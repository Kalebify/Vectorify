import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import type { PythonStatus } from './types/system';

function response(status: PythonStatus = 'online') {
  return new Response(JSON.stringify({
    status: status === 'online' ? 'online' : 'degraded',
    timestamp: new Date().toISOString(), api: { status: 'online' },
    python: { status, service: 'vectorify-python-engine', version: '0.1.0', message: null },
  }), { headers: { 'Content-Type': 'application/json' } });
}

describe('Diagnóstico desde la respuesta HTTP', () => {
  // M2.2-S08: la home (sin params) es ahora el dashboard "Mis proyectos"; el diagnóstico del
  // sistema vive en el flujo clásico `?view=new`.
  beforeEach(() => { window.history.pushState({}, '', '/?view=new'); });
  afterEach(() => { window.history.pushState({}, '', '/'); });

  it('muestra loading mientras espera', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    render(<App />);
    expect(screen.getByText('Consultando el estado del sistema…')).toBeInTheDocument();
    expect(screen.getAllByText('Consultando…')).toHaveLength(2);
  });

  it('muestra ambos servicios online y consulta solamente la Web API', async () => {
    const fetch = vi.fn().mockResolvedValue(response());
    vi.stubGlobal('fetch', fetch);
    render(<App />);
    expect(await screen.findByText('Todos los servicios están en línea.')).toBeInTheDocument();
    expect(screen.getAllByText('En línea')).toHaveLength(2);
    expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/api\/v1\/system\/health$/), expect.any(Object));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['unavailable', 'No disponible'], ['timeout', 'Tiempo de espera agotado'],
    ['invalid_response', 'Respuesta inválida'], ['error', 'Error'],
  ] as const)('mantiene API online cuando Python devuelve %s', async (status, label) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(status)));
    render(<App />);
    expect(await screen.findByText(label)).toBeInTheDocument();
    expect(screen.getByText('En línea')).toBeInTheDocument();
    expect(screen.getByText('La Web API está en línea, pero uno o más servicios dependientes presentan problemas.')).toBeInTheDocument();
  });

  it('muestra API offline y Python desconocido ante fallo de red', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Network error')));
    render(<App />);
    expect(await screen.findByText('Sin conexión')).toBeInTheDocument();
    expect(screen.getByText('Desconocido')).toBeInTheDocument();
  });

  it('se recupera de la caída de Python sin recargar la página', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response()).mockResolvedValueOnce(response('unavailable'))
      .mockResolvedValue(response()));
    await act(async () => { render(<App />); });
    expect(screen.getAllByText('En línea')).toHaveLength(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.getByText('No disponible')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.getAllByText('En línea')).toHaveLength(2);
  });
});

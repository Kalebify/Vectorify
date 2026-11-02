import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from './App';

const uploaded = vi.hoisted(() => ({ projectId: 'p', imageId: 'i', filename: 'logo.png', bytes: 100, width: 476, height: 307 }));
vi.mock('./hooks/useImageUpload', () => ({ useImageUpload: () => ({ status: 'success', result: uploaded, reset: vi.fn() }) }));
vi.mock('./api/thresholdApi', async (importOriginal) => ({
  ...await importOriginal<typeof import('./api/thresholdApi')>(),
  generateThresholdMask: vi.fn(() => new Promise(() => {})),
}));
vi.mock('./components/colorPalette/ColorPalettePanel', () => ({ ColorPalettePanel: () => null }));
vi.mock('./components/preprocess/PreprocessPanel', () => ({
  PreprocessPanel: ({ onPreviewReady }: { onPreviewReady: (preview: object) => void }) => <>
    <button onClick={() => onPreviewReady({ previewId: 'preview-1', width: 476, height: 307 })}>Primer preprocesado</button>
    <button onClick={() => onPreviewReady({ previewId: 'preview-2', width: 476, height: 307 })}>Cambiar preprocesado</button>
  </>,
}));
beforeEach(() => {
  window.history.pushState({}, '', '/?view=new');
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
});
afterEach(() => { vi.unstubAllGlobals(); window.history.pushState({}, '', '/'); });

it('preserves inversion and threshold when a new preprocessing preview finishes', () => {
  render(<App />);
  fireEvent.click(screen.getByRole('radio', { name: 'Blanco y negro' }));
  fireEvent.click(screen.getByRole('button', { name: 'Primer preprocesado' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Invertir blanco/negro' }));
  fireEvent.change(screen.getByRole('slider', { name: 'Umbral' }), { target: { value: '180' } });
  fireEvent.click(screen.getByRole('button', { name: 'Cambiar preprocesado' }));
  expect(screen.getByRole('checkbox', { name: 'Invertir blanco/negro' })).toBeChecked();
  expect(screen.getByRole('slider', { name: 'Umbral' })).toHaveValue('180');
  expect(screen.getByRole('radio', { name: 'Blanco y negro' })).toBeChecked();
});

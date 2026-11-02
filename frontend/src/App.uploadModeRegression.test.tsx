import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from './App';

// Keep the real UploadPanel: its success effect must not restart the project
// when App rerenders after choosing another vectorization mode.
const upload = vi.hoisted(() => ({
  result: { projectId: 'p', imageId: 'i', filename: 'pato.png', bytes: 100, width: 1152, height: 2048 },
}));
vi.mock('./hooks/useImageUpload', () => ({
  useImageUpload: () => ({ status: 'success', result: upload.result, reset: vi.fn() }),
}));
vi.mock('./components/colorPalette/ColorPalettePanel', () => ({
  ColorPalettePanel: () => <input aria-label="Nombre de color de prueba" defaultValue="Amarillo" />,
}));
vi.mock('./components/preprocess/PreprocessPanel', () => ({
  PreprocessPanel: () => <input aria-label="Brillo de prueba" defaultValue="0" />,
}));
beforeEach(() => {
  window.history.pushState({}, '', '/?view=new');
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
});
afterEach(() => { vi.unstubAllGlobals(); window.history.pushState({}, '', '/'); });

it('keeps monochrome selected after a real successful upload and preserves both routes', () => {
  render(<App />);
  expect(screen.getByText('Proyecto creado')).toBeVisible();
  fireEvent.change(screen.getByLabelText('Nombre de color de prueba'), { target: { value: 'Cuerpo' } });
  fireEvent.click(screen.getByRole('radio', { name: 'Blanco y negro' }));
  expect(screen.getByRole('radio', { name: 'Blanco y negro' })).toBeChecked();
  expect(screen.getByRole('heading', { name: 'Preprocesamiento' })).toBeVisible();
  expect(screen.queryByRole('heading', { name: 'Paleta de colores' })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Brillo de prueba'), { target: { value: '12' } });
  fireEvent.click(screen.getByRole('radio', { name: 'Por colores' }));
  expect(screen.getByLabelText('Nombre de color de prueba')).toHaveValue('Cuerpo');
  fireEvent.click(screen.getByRole('radio', { name: 'Blanco y negro' }));
  expect(screen.getByRole('radio', { name: 'Blanco y negro' })).toBeChecked();
  expect(screen.getByLabelText('Brillo de prueba')).toHaveValue('12');
});

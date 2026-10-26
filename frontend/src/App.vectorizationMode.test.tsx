import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from './App';

vi.mock('./components/upload/UploadPanel', () => ({
  UploadPanel: ({ onProjectCreated }: { onProjectCreated: (project: object) => void }) => (
    <button onClick={() => onProjectCreated({ projectId: 'p', imageId: 'i', filename: 'pato.png', width: 1152, height: 2048 })}>Cargar prueba</button>
  ),
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
afterEach(() => window.history.pushState({}, '', '/'));

it('abre la ruta por colores y mantiene el umbral monocromo fuera de ese flujo', () => {
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: 'Cargar prueba' }));
  expect(screen.getByRole('radio', { name: 'Por colores' })).toBeChecked();
  expect(screen.getByRole('heading', { name: 'Paleta de colores' })).toBeVisible();
  expect(screen.queryByRole('heading', { name: 'Preprocesamiento' })).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Brillo de prueba")).not.toBeInTheDocument();
  expect(screen.getByText(/no conserva los colores/i)).toBeVisible();
});

it('permite elegir blanco y negro y conserva los ajustes de cada ruta al volver', () => {
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: 'Cargar prueba' }));
  fireEvent.change(screen.getByLabelText('Nombre de color de prueba'), { target: { value: 'Cuerpo' } });
  fireEvent.click(screen.getByRole('radio', { name: 'Blanco y negro' }));
  expect(screen.getByRole('heading', { name: 'Preprocesamiento' })).toBeVisible();
  expect(screen.queryByRole('heading', { name: 'Paleta de colores' })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Brillo de prueba'), { target: { value: '12' } });
  fireEvent.click(screen.getByRole('radio', { name: 'Por colores' }));
  expect(screen.getByLabelText('Nombre de color de prueba')).toHaveValue('Cuerpo');
  fireEvent.click(screen.getByRole('radio', { name: 'Blanco y negro' }));
  expect(screen.getByLabelText('Brillo de prueba')).toHaveValue('12');
  fireEvent.click(screen.getByRole('button', { name: 'Cargar prueba' }));
  expect(screen.getByRole('radio', { name: 'Por colores' })).toBeChecked();
});

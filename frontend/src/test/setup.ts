import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// jsdom no implementa ResizeObserver (usado por VectorCanvas, M1-S06, para
// medir el contenedor y calcular fit-to-screen). Stub mínimo: no dispara
// callbacks automáticamente (los tests que necesiten simular una medición
// llaman a la callback registrada explícitamente), pero evita un
// ReferenceError al montar el componente.
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver = ResizeObserverStub;
}

// Los findBy*/waitFor esperan 1 s por defecto: bajo la carga de la suite completa en paralelo (ver `testTimeout` en vitest.config.ts) eso produjo
// fallos intermitentes en tests que pasan solos (p. ej. ManufacturingOperations, main.fragmentOrder). Un tope mayor no ralentiza los tests que pasan.
configure({ asyncUtilTimeout: 10000 });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

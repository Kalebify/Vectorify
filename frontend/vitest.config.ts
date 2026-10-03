import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    // M2.1-S06 agrega VectorCanvas (Konva/react-konva, ver ADR de
    // M2.1-S05): montar un <Stage> real bajo jsdom+node-canvas es más caro
    // en CPU que el resto de los componentes de este repo, y bajo la carga
    // de correr la suite COMPLETA en paralelo (34 archivos, cada uno con su
    // propio entorno jsdom) el timeout por defecto de 5s empezó a fallar de
    // forma intermitente incluso en tests sin nada async -- no es un bug de
    // lógica (todos pasan en aislamiento), es contención de recursos. Se
    // sube el timeout global en vez de reducir el paralelismo (que
    // ralentizaría toda la suite existente) para darle margen a las
    // máquinas más lentas sin tocar ningún test individual.
    testTimeout: 30000,
    // Tope de paralelismo: sin esto, vitest levanta hasta un worker por CPU
    // lógico (16 en esta máquina), cada uno con su propio jsdom + (en los
    // archivos de VectorCanvas/EditorShell) su propio Stage real de Konva
    // sobre `canvas` (node-canvas, nativo) -- bajo carga externa esa
    // cantidad de entornos simultáneos empezó a agotar CPU y a hacer
    // fallar por timeout tests sin relación alguna con Konva (ver
    // comentario de `testTimeout`). Limitar el techo de threads reduce el
    // pico de contención sin serializar toda la suite.
    //
    // Revisado en M2.1-S07 fix round 2 (QA reportó fallos intermitentes con
    // paralelismo default incluso con el tope de 8 de arriba; 307/307
    // estables solo con --maxWorkers=2 pasado a mano): se baja el tope acá
    // para que `npm test` sea estable SIN tener que pasar la flag a mano.
    maxWorkers: 2,
  },
});

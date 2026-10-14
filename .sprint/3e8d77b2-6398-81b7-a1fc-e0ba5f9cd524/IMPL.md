# IMPL.md — M3-S14 · Laser Checker integrado en el Editor

## Resumen
Panel **Laser Check** en el editor (botón en el header): estado global **Ready / Review / Blocking** y lista de issues con severidad, tipo, capa,
objeto y acción sugerida. Click (o Enter) en un issue selecciona los objetos, centra el viewport y dibuja un resalte. Se re-analiza solo tras
editar la geometría. Spec: `spec.md`; decisiones también en el ADR (D7).

## Decisiones
- **El checker corre en el cliente sobre la geometría editada en memoria** (`lib/editor/laserCheck.ts`, módulo puro). El checker de M1-S08 analiza
  versiones guardadas y solo M/L/Z: no ve ediciones sin guardar ni curvas. Backend y Python **sin cambios**.
- **Piezas flotantes reusan S11** (`planFloating` + `useFloatingAnalysis`, servidor), modo `stencil` (default de S11). Mientras el servidor no responde, o
  si falla, el check queda NO VERIFICADO y el estado nunca es `Ready`; los checks locales siguen valiendo.
- **Estado global**: `Blocking` si hay algún error (path abierto en CUT, geometría inválida, duplicado exacto, flotante); `Review` si solo hay avisos
  **o** algún check no se pudo verificar; `Ready` solo con cero issues y todo verificado. Un documento sin nada analizable (todo oculto/ignorado) es `Review`.
- **Relevancia por operación**: capas `ignore` y ocultas no se analizan; las bloqueadas sí (solo lectura). Path abierto y flotantes solo en CUT (un
  contorno abierto en ENGRAVE o una línea sin relleno es válido). Capa `unassigned` ⇒ se analiza como CUT, cada issue lo indica y suma un aviso de capa.
- **Umbrales** (constantes exportadas, en mm; sin escala física se leen en unidades y el panel avisa): detalle mínimo CUT 0,1 mm / ENGRAVE 0,05 mm; cierre
  de path ≤ 0,01 mm; duplicado exacto ≤ 0,001 mm, casi ≤ 0,05 mm; subforma degenerada < 0,0001 mm; complejidad > 5 000 nodos por objeto o > 50 000 por capa.
- **Autointersección** con presupuesto de comparaciones (2 M por objeto, 20 M total); si se agota queda NO VERIFICADO.
- **Duplicados**: sobre la geometría con la matriz aplicada, dentro de la misma clase de operación (cortar y grabar el mismo contorno no es duplicado).
- **Re-run**: manual + automático con debounce de 400 ms tras cambiar la geometría confirmada; los resultados llevan la huella del documento y, si
  cambió sin re-analizar, se marcan **Desactualizado** (se oculta el resalte y no se pueden activar issues viejos). Una sola petición de flotantes viva, con abort.
- No es una herramienta de canvas (`activeTool` no cambia): no se tocaron las listas manuales de `VectorCanvas` salvo el prop del overlay.

## Entregado
- `lib/editor/laserCheck.ts` (+ test, 48), `hooks/useLaserCheck.ts` (+ test, 17), `LaserCheckPanel` (+ test, 21), `LaserCheckOverlay` (+ test, 6),
  `EditorShell.laserCheck.test.tsx` (21), integración en `EditorShell`/`EditorHeader`/`VectorCanvas`, estilos, ADR D7.

## Limitaciones / observaciones
- **Falsos "Blocking" posibles con la semántica `stencil`**: un contorno interior dentro de otro (p. ej. el agujero de una "O" en material sólido) se reporta
  como isla flotante, igual que en S11. Para diseños de piezas (no plantillas) el modo correcto sería `parts`; hoy el Laser Check no ofrece el selector
  (queda como mejora). Revisar si se quiere otro default.
- Estrechamientos cóncavos dentro de una forma grande no se detectan como detalle pequeño (el ancho se mide sobre el casco convexo).
- Más de 500 objetos CUT con relleno: el análisis de flotantes lo rechaza el cliente (límite de S11) y queda NO VERIFICADO con el motivo.
- La lista muestra los primeros 200 issues y el resalte dibuja hasta 300; el resumen cuenta todos.
- No verificado: el aspecto real en navegador (CSS, foco, layout del rail); los tests corren en jsdom.

## Verificación (orquestador)
Ver el PR (checks corridos de forma independiente). `dotnet test` E2E sigue sin poder ejecutarse sin Docker.

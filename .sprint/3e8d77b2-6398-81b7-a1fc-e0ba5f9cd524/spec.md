# M3-S14 · Laser Checker integrado en el Editor
URL: https://app.notion.com/p/3e8d77b2639881b7a1fce0ba5f9cd524
Stack declarado: Frontend (React/TS, Konva) + reuso del servicio de geometría de S11 (Shapely vía ASP.NET). Áreas de la tarjeta: Laser, Vector, Frontend.

> Lee primero `docs/ADR_EDITOR_MVP3.md` (secciones de S11 "Piezas flotantes y bridges", D5/S13) y los IMPL.md de S11
> (`.sprint/3c1d77b2-6398-8109-a3bd-f702d298f3c7/IMPL.md`), S13 (`.sprint/3e8d77b2-6398-819b-8da0-e056b668d3a4/IMPL.md`) y M1-S08 (checker de paths abiertos/duplicados sobre versiones guardadas).
> Antes de escribir código, lee: `frontend/src/lib/editor/floating.ts`, `hooks/useFloatingAnalysis.ts`, `components/editor/FloatingPanel.tsx` y `FloatingOverlay.tsx`,
> `lib/editor/viewport.ts` (`focusTransform`), `hooks/useCanvasTransform.ts` (`centerOn`), `lib/editor/objects.ts`, `pathGeometry.ts`, `geometry.ts`, `units.ts`, `types.ts`,
> `components/editor/EditorShell.tsx` (cómo se cablean FloatingPanel/herramientas) y `VectorCanvas.tsx` (listas manuales: `selectOnly`, Escape, `TOOL_LABELS`: olvidar una falla en silencio).

## Requerimiento (transcripción del cuerpo de la tarjeta)
Objetivo: Integrar análisis de fabricabilidad directamente en el editor y conectar cada issue con su geometría.
Criterio de aceptación: El editor muestra issues de paths abiertos, duplicados, piezas flotantes, detalles mínimos y otros checks disponibles; click en issue centra y resalta la geometría.

**Panel.** Estados: Ready / Review / Blocking. Mostrar severidad, tipo, layer, objeto/componente y acción sugerida.
**Checks mínimos.** Paths abiertos, duplicados, floating components, detalles demasiado pequeños cuando exista umbral, geometría inválida, complejidad excesiva si está disponible.
**Interacción.** Click issue → seleccionar/resaltar/zoom to fit issue. Re-run después de mutaciones relevantes.
**Fabricación.** Usar dimensiones mm y ManufacturingOperation para evitar warnings irrelevantes.
**Tests.** Dataset conocido con problemas y casos limpios.
**Definition of Done.** El usuario no necesita inspeccionar manualmente todo el SVG para localizar problemas de corte conocidos.

## Criterios de aceptación
1. El panel muestra un estado global **Ready / Review / Blocking** y una lista de issues con severidad, tipo, capa, objeto/componente y acción sugerida.
2. Checks: path abierto, duplicado (exacto y casi), pieza flotante, detalle demasiado pequeño, geometría inválida, complejidad excesiva.
3. Click en un issue selecciona los objetos implicados, los resalta y centra/ajusta el viewport (zoom to fit del issue).
4. Se vuelve a analizar tras mutaciones relevantes (la geometría confirmada cambió); un resultado desactualizado nunca se presenta como vigente.
5. Los checks usan mm (`mmFactor`) y la `ManufacturingOperation` de la capa para no emitir warnings irrelevantes.
6. Tests con un dataset conocido con problemas y casos limpios (DERIVADO de la sección Tests de la tarjeta).

## Referencias visuales / de marca
MISSING (sin referencias; seguir el lenguaje visual de los paneles del editor: `FloatingPanel`, `HistoryPanel`, `editor.css`).

## Umbrales de calidad
Defaults del proyecto (no hay propiedad Umbrales): `npm test`, `npm run build`, `npm run lint` sin warnings nuevos en lo tocado, `dotnet build`, `pytest` sin regresiones.

## Decisiones del orquestador (documentarlas en IMPL.md y en el ADR)
1. **El checker corre en el CLIENTE sobre la geometría editada en memoria** (`EditableDocument`: capas efectivas + objetos confirmados). El checker de M1-S08 (`/api/v1/.../check`) analiza versiones *guardadas* y solo M/L/Z: no ve ediciones sin guardar ni curvas del editor, así que no sirve para esta tarjeta. Es un módulo **puro** `lib/editor/laserCheck.ts` (sin DOM, testeable con datasets).
2. **Piezas flotantes: se reusa S11** (`planFloating` + `useFloatingAnalysis`, servidor Shapely) — no se reimplementa. Es asíncrono: el panel muestra "analizando flotantes…" y, si falla, lo informa sin invalidar los checks locales (un check no disponible se muestra como NO VERIFICADO, nunca como OK). Sin cambios de backend ni Python (si crees necesitarlos, anótalo como desviación y justifícalo).
3. **Umbrales en mm** (constantes exportadas, documentadas y con default razonable; con escala física desconocida → unidades del documento y aviso, como `NO_SCALE_NOTICE` de S11): detalle mínimo CUT ≈ 0,1 mm (ancho de kerf) y ENGRAVE más laxo; complejidad por nº de nodos por objeto/capa; tolerancia de cierre/duplicado relativa o en mm (elige y documenta). Los objetos con `stroke` y sin `fill` (líneas) NO son "path abierto": un contorno abierto solo es problema donde se espera área (relleno/CUT).
4. **Relevancia por operación**: capas `ignore` no se analizan; **paths abiertos y flotantes solo importan en CUT**; en ENGRAVE un path abierto es válido (línea grabada); capas sin operación (`unassigned`) se analizan como CUT pero cada issue lo indica (“sin operación asignada”). Capas ocultas no se analizan; bloqueadas sí (solo lectura).
5. **Severidad** → estado global: `Blocking` si hay algún issue error (path abierto en CUT, geometría inválida, duplicado exacto, flotante en CUT), `Review` si solo hay warnings (casi-duplicado, detalle pequeño, complejidad, unassigned), `Ready` si no hay ninguno **y** todos los checks se pudieron verificar (si alguno no se pudo correr ⇒ nunca `Ready`).
6. **Re-run**: manual (botón *Analizar*) y automático con debounce tras cambiar la geometría confirmada mientras el panel está abierto (los checks locales son baratos; los flotantes con una sola petición viva y abort). Los resultados llevan la huella del documento analizado: si el documento cambió y todavía no se re-analizó, se marcan **desactualizados**.
7. **Click en issue**: selecciona los objetos del issue (con el mismo mecanismo de selección de S11), centra con `focusTransform`/`centerOn` y dibuja un overlay de resalte (reusar el patrón de `FloatingOverlay`). Teclado completo: lista navegable, Enter activa, Escape cierra y devuelve el foco; región `aria-live` con el resumen.
8. Cableado de la herramienta/panel: ver las listas manuales de `VectorCanvas` (`selectOnly`, Escape, `TOOL_LABELS`) y los *fake clients* de tests si se toca un contrato.

## Tests exigidos
- **Lógica pura** (`laserCheck.test.ts`): dataset conocido con problemas (path abierto, duplicado exacto y casi, detalle pequeño, geometría inválida —NaN/degenerada/auto-intersección si se detecta—, complejidad) y dataset limpio ⇒ `Ready`; relevancia por operación (ignore/ENGRAVE/unassigned/oculta/bloqueada); umbrales en mm con y sin escala; determinismo (mismo documento ⇒ mismos issues en el mismo orden); severidades y estado global; “no verificado ≠ Ready”.
- **Hook** (análisis local + flotantes, re-run con debounce, resultado desactualizado, abort/una petición viva, fallo de flotantes) y **componentes** (panel: estados, lista, foco/teclado, aria-live; overlay).
- **EditorShell**: abrir el panel, analizar un documento con problemas, click en un issue ⇒ selección + viewport centrado; mutar ⇒ marcado desactualizado / re-análisis; suite existente S01–S13 verde.
- Verificación: `npm test`, `npm run build`, `npm run lint`, `dotnet build`, `pytest`.

## DoD
El usuario no necesita inspeccionar manualmente todo el SVG para localizar problemas de corte conocidos: abre el panel, ve el estado y salta a cada problema.

## Ambigüedades detectadas
- Los umbrales numéricos (detalle mínimo, complejidad) no están en la tarjeta: se fijan como constantes documentadas (decisión 3) y se listan como supuestos en el PR.
- “Acción sugerida” no tiene catálogo: texto determinista por tipo (p. ej. “Cerrar el path o asignar la capa a Engrave”, “Eliminar el duplicado”, “Agregar un bridge”, “Agrandar el detalle o quitarlo”). No ejecuta correcciones automáticas (fuera de alcance).
- Fuera de alcance: correcciones automáticas, checks de MVP 4 (IA), exportar el reporte, cambiar los endpoints M1-S08.

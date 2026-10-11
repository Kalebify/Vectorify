# spec.md — M3-S11 · Bridges + piezas flotantes

> Lee primero `docs/ADR_EDITOR_MVP3.md` y los `IMPL.md` de M3-S01..S10, sobre todo **S04** (`.sprint/3e8d77b2-6398-8102-b5de-e68e3f8fc1c0/`:
> servicio de geometría Python/.NET, formato de anillos, límites), **S08** (`…/3c1d77b2-6398-81f7-9504-d7070d96c1c0/`: `useGeometryPreview`, panel con
> preview, resultado → objetos nuevos, capa destino) , **S09/S10** (`…-81bf-…`, `…-81ff-…`: mismo patrón de endpoint + panel). Reusá esa
> infraestructura; no dupliques. Existe además lógica del flujo clásico (MVP 1) en `services/python-engine/app/core/{component_analysis,
> physical_union}.py` (componentes, profundidad/contención, `_build_bridge`, árbol de expansión mínima): **leela como referencia de
> conceptos** (no está pensada para este formato; no la rompas ni la reemplaces).

## Contexto (cuerpo de la tarjeta)
"Una pieza visualmente correcta puede perder islas internas al cortar." El usuario ejecuta un **análisis**, ve los **componentes
flotantes resaltados** y crea **bridges configurables en mm con preview**. Definir *floating* según **contención/componentes**; un bridge
genera **geometría real** y **reanaliza el resultado**. Warnings enlazan con la geometría (seleccionar un issue **centra y resalta** el
componente). Tests: **A/O/R, stencil, múltiples islas, bridges finos/gruesos, undo**. DoD: "Los casos del dataset se detectan y un bridge
confirmado reduce componentes correctamente sin destruir el diseño." Fuera de alcance: colocación automática "perfecta" por IA.
Criterio: "Se detectan componentes flotantes y bridges creados reducen el número de componentes esperado."

## Decisiones (documentalas en IMPL.md, ADR y UI)
1. **Qué significa "flotante" — dos modos explícitos** (selector visible, default *Plantilla*):
   - **Plantilla (stencil)**: las formas analizadas son **cortes** (vacío): el material es la hoja menos esas formas. Una **isla** es una región
     de material rodeada por completo por cortes (el hueco interior de una "O", la contra-forma de una "A" o "R", los centros de un stencil);
     al cortar, **se cae**. Flotante = cada hueco (anillo interior) de la unión de las formas, a cualquier profundidad impar (un corte
     dentro de una isla no la conecta: la isla sigue flotando).
   - **Piezas (parts)**: las formas son **material**; flotante = componente de la unión que está **dentro de un hueco de otro** (contención), es
     decir, desconectado del cuerpo principal (p. ej. el punto dentro de una "O").
   Resultado del análisis: lista de componentes `{id, kind: principal|flotante, polígono, área, bounds, padre}` y recuentos. Determinista.
2. **Alcance del análisis (explícito)**: la **selección** si la hay; si no, los objetos con relleno **visibles** de las capas cuya operación de
   fabricación es **CUT** (default; la operación de cada capa ya existe en el modelo). El panel dice qué se analiza ("Capas CUT: A, B (12
   objetos)"). Objetos bloqueados **cuentan para el análisis** (solo lectura) pero **no se modifican** al crear bridges; ocultos no cuentan.
3. **Bridge** = conexión física real:
   - *Plantilla*: un rectángulo de ancho **w** (mm, default 0,8; rango validado) que cruza el corte entre la isla y el material exterior
     se **resta** de las formas de corte (abre un puente de material). *Piezas*: un rectángulo de ancho w se **suma** (unión) entre el
     componente flotante y el cuerpo vecino.
   - **Sugerencia automática** (heurística simple, determinista; no "IA"): por isla, el segmento más corto entre su borde y el material/cuerpo
     más cercano, orientado perpendicular al borde, con ancho w y el largo mínimo para cruzar el corte. El usuario puede **moverla**: click sobre
     el borde de la isla fija el ancla; ajusta w en mm; quita o agrega bridges por isla (varios por isla permitidos).
   - Un bridge que **no conecta** (queda corto, w demasiado fino para la tolerancia, cae fuera) se marca **inválido** y no se aplica.
4. **Reanálisis y verificación**: el servidor devuelve, para el conjunto de bridges propuesto, la **geometría resultante** y el **reanálisis**
   (flotantes antes → después). Apply se habilita solo si el resultado es válido; el panel muestra "N flotantes → M" y avisa si algún bridge no
   redujo nada o si quedan flotantes sin puente. **El diseño no se destruye**: las formas conservan capa, `fill`/`stroke`, ids cuando no cambian
   (`changed:false`); las piezas resultantes siguen en su capa.
5. **Resultado y comando**: objetos modificados se reemplazan por sus piezas resultantes (ids nuevos si cambian, misma capa; reusar la
   mecánica de S04/S08/S10). Un comando atómico undoable por Apply; preview sin llenar la pila de undo; Cancel sin rastro. Capas
   bloqueadas/ocultas: sus objetos no se modifican; si un bridge necesitara modificarlos ⇒ ese bridge se rechaza con el motivo (nada se omite
   en silencio).

## Alcance técnico
- **Python** (`services/python-engine`): `POST /api/v1/geometry/floating` (análisis: subjects + `mode` + `tolerance` ⇒ componentes con
  clasificación y padre, determinista, validado, límites como el resto) y `POST /api/v1/geometry/bridge` (subjects + `mode` + lista de
  bridges `{anchor:{x,y}|island:int, direction?, width, length?}` + `tolerance` ⇒ por bridge `{valid, reason?, polygon}` + por subject la
  geometría resultante con `changed` + **reanálisis** `{floatingBefore, floatingAfter, mainAfter}`; sin sugerencias manuales ⇒ opción
  `suggest:true` que devuelve los bridges sugeridos). Núcleo en `app/core/geometry_floating.py` (o similar); reusá `geometry_ops` donde
  convenga. Errores uniformes; límites de subjects/vértices/bridges; timeout.
- **ASP.NET Core**: `POST /api/v2/geometry/floating` y `/bridge` (endpoint → servicio → cliente Python, validación 400, revalidación de la
  respuesta del cliente, 503/504/502 uniformes). Sin DB ni usuario.
- **Frontend**: `lib/editor/floating.ts` (puro: selección del alcance, petición, interpretación, issues, `applyBridgeResult` ⇒ `EditProduction`),
  `hooks/useFloatingAnalysis.ts` y `useBridgeOperation.ts` (sobre `useGeometryPreview`), `FloatingPanel.tsx` (modo, alcance, botón Analizar,
  **lista de issues** con selección ⇒ **centra el viewport y resalta** el componente; bridges: ancho en mm, sugerencias, colocación manual,
  quitar, recuento antes→después, Apply/Cancel), `FloatingOverlay` (componentes flotantes resaltados + bridges propuestos), acceso desde la barra
  del editor (herramienta/acción "Piezas flotantes" — el toolbar no tiene un botón dedicado hoy: agregá uno visible y documentalo). Para "centrar":
  usá/extendé `useCanvasTransform` (centrar un rectángulo del documento con un zoom razonable); accesible (`aria-live`, issues navegables por teclado).

## Fuera de alcance
Colocación automática óptima (IA), bridges curvos, optimización global del número de bridges, integración de estos issues en el Laser Checker
(S14 los reusa), persistencia (S13), análisis de capas ENGRAVE.

## Tests exigidos
- **Python** (valores calculados a mano, fixtures sintéticos tipo dataset): **A, O, R** (la contra-forma es flotante en *Plantilla*; cuenta de
  flotantes por letra), stencil con **múltiples islas** (conteo exacto), isla anidada dentro de una isla (profundidad impar/par), *Piezas*
  (punto dentro de "O" flotante; dos componentes disjuntos, ninguno flotante), forma sin huecos (0 flotantes), winding irrelevante, determinismo,
  bridge fino/grueso (ancho w ⇒ área sustraída/sumada = w·largo exacto), un bridge **reduce** flotantes (1→0) y uno **inválido** (corto/fuera) no,
  varios bridges en una isla, reanálisis consistente con el análisis independiente del resultado, límites y errores 400/422.
- **.NET**: validador (cada regla), servicio, cliente (revalidación), endpoints de punta a punta con Python simulado.
- **Frontend**: `floating.ts` (alcance: selección vs. capas CUT, bloqueados cuentan pero no se modifican, ocultos no), issues y su orden, bridges
  (mm→unidades), `applyBridgeResult` (ids/capas/`changed:false`), rechazo por capas bloqueadas, comando único. Panel/hook/shell: Analizar,
  seleccionar issue ⇒ el viewport se centra (probar el cálculo de `centerOn`) y se resalta, preview con debounce/abort (mocks de `fetch` con
  `AbortSignal` y conteo de llamadas), Apply deshabilitado con bridges inválidos, undo/redo exactos, "N flotantes → M", StrictMode.
- La suite existente (S01–S10) debe seguir verde.
- Verificación: `dotnet build`, `dotnet test` (completo; hay Docker), `pytest` (`services/python-engine/.venv/Scripts/python.exe -m pytest -q`),
  `npm test`, `npm run build`, `npm run lint` (sin errores nuevos).

## DoD
Se detectan las piezas flotantes (A/O/R, stencil, múltiples islas) con su definición explícita, el usuario las ve resaltadas y navega a ellas,
crea bridges configurables en mm con preview, y un bridge confirmado reduce los componentes flotantes de forma verificada (reanálisis) sin
destruir el diseño, como un comando atómico y reversible.

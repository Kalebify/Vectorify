# spec.md — M3-S09 · Offset de geometría

> Lee primero `docs/ADR_EDITOR_MVP3.md` (D4 + decisiones de S08) y los `IMPL.md` de M3-S01..S08, sobre todo **S04**
> (`.sprint/3e8d77b2-6398-8102-b5de-e68e3f8fc1c0/`: servicio de geometría Python/ASP.NET, formato de anillos, límites, errores) y
> **S08** (`.sprint/3c1d77b2-6398-81f7-9504-d7070d96c1c0/`: panel con preview + debounce + `AbortController`, capa destino
> explícita, resultado → objetos nuevos, `changed`). Offset **reusa** esa infraestructura (hook de preview, `geometryApi`,
> convenciones de panel y de comando atómico); no dupliques.

## Contexto
Criterio (Notion): "Offset en mm produce preview y resultado geométricamente válido." DoD: "Offset conserva unidades y genera
geometría válida o explica por qué no puede aplicarse." Usuario: selecciona geometría, indica offset en **mm**, elige dirección,
ve el preview y Apply/Cancel. Motor: Clipper2 "u opción validada" ⇒ **Shapely `buffer`** (misma decisión de S08). Joins/caps,
detectar colapso, mantener escala real. Fuera de alcance: compensación automática de kerf/material.

## Decisiones (documentalas en IMPL.md, ADR y UI)
1. **Convención de signo**: distancia ≥ 0 en la UI con **dirección** explícita *Exterior* (agranda la forma) / *Interior* (la
   encoge); internamente `distance` firmada (+ exterior, − interior). Para **líneas abiertas** (sin relleno) existe solo "ambos
   lados": el resultado es un polígono alrededor de la línea de ancho total 2×offset (con *caps* redondo/plano/cuadrado); *Interior*
   se deshabilita con el motivo. Offset 0 se rechaza (no hace nada); límite máximo |offset| configurable (p. ej. 1000 mm) con error claro.
2. **Unidades reales**: el panel trabaja en **mm** y convierte con `mmPerUnit` (S01/S02). **Sin escala física** (`mmPerUnit` nulo) ⇒ el
   panel opera en unidades de documento con un aviso visible ("sin escala física: el offset es en unidades"); nunca inventa mm.
   La tolerancia de aplanado/arcos es en mm (default 0,01 mm) y se convierte igual.
3. **Joins y caps**: *Redondo* (default), *Inglete* (con límite configurable, default 2) y *Bisel*; caps (solo líneas): redondo, plano,
   cuadrado. Valores presentados con nombres claros y descripciones cortas.
4. **Colapso y advertencias — nada falla en silencio**: el servidor informa por subject si el resultado **colapsó** (queda vacío), se
   **partió en varias piezas**, o perdió/ganó **huecos**, y el máximo offset interior alcanzable (`maxInwardOffset`, radio del
   máximo círculo inscrito, p. ej. `shapely.maximum_inscribed_circle`) para sugerirlo. El cliente muestra, antes de confirmar: "N
   objetos colapsan con este offset (máximo interior ≈ X mm)", "M objetos se dividen en K piezas". Si **todos** colapsan ⇒ Apply
   deshabilitado con la explicación. Si **algunos** colapsan ⇒ se aplica solo a los demás **solo si el usuario lo confirma
   explícitamente** (casilla/confirmación; por defecto Apply queda deshabilitado hasta confirmar o ajustar el valor).
5. **Resultado y capa**: por defecto **Conservar original** (el offset se agrega como contorno nuevo, caso típico: línea de corte
   exterior) con opción **Reemplazar**. Cada resultado va a la **capa de su objeto de origen** (se muestra en el panel); si hay
   capa(s) de origen bloqueada/oculta ⇒ la operación se rechaza (como en S08, no se omite en silencio); se puede elegir
   explícitamente **otra capa destino** (o capa nueva con la mecánica de S03). Una pieza disjunta = un objeto nuevo (ids nuevos,
   huecos como subpaths, `fill` = color de la capa destino, sin matriz); orden/posición: encima del objeto de origen (documentá).
   Un solo comando atómico undoable por Apply.
5b. **Presets** de distancia (0,1 / 0,25 / 0,5 / 1 / 2 / 5 mm) y campo numérico libre con validación; paso con flechas.
6. **Preview + Apply/Cancel**: igual que S08 (debounce, abort, una petición viva, estados *calculando…* / error recuperable /
   colapso / advertencias, preview que no llena la pila de undo, Enter/Escape). El preview dibuja el resultado (y el original
   atenuado) sobre el canvas.

## Alcance técnico
- **Python** (`services/python-engine`): `POST /api/v1/geometry/offset` (núcleo puro en `app/core/geometry_offset.py` o junto a
  `geometry_ops.py`, servicio con límites + timeout como el de booleanas). Request: `{ subjects:[Geometry…], distance (firmada),
  joinStyle:"round"|"mitre"|"bevel", mitreLimit, capStyle:"round"|"flat"|"square", tolerance }` (mismo formato de anillos de S04).
  Response por subject: `{ geometries, collapsed, splitCount, holesBefore, holesAfter, maxInwardOffset }`, salida **determinista**, sin
  NaN, validada (`is_valid`), piezas < tolerancia² descartadas. Resolución de arcos acotada por la tolerancia (como el pincel de S04).
  Límites: subjects/vértices como el resto, |distance| acotada. Errores uniformes.
- **ASP.NET Core**: `POST /api/v2/geometry/offset` (`GeometryEndpoints` → servicio → cliente Python; validación 400: NaN/Infinity,
  distancia 0 o fuera de límites, join/cap desconocidos, `mitreLimit` ≤ 0, límites de tamaño; el cliente revalida la respuesta; 503/504/502
  uniformes). Sin DB ni usuario.
- **Frontend**: `lib/editor/offset.ts` (puro: validación, mm→unidades, construcción de la petición, interpretación de la respuesta,
  resumen de advertencias, `applyOffsetResult` ⇒ `EditProduction`, reglas de capa/colapso/confirmación), `hooks/useOffsetOperation.ts`
  (sobre el patrón de `useBooleanOperation`), `OffsetPanel.tsx` + acceso (barra contextual o la herramienta **Offset** del toolbar,
  que hoy está deshabilitada: habilitala), overlay de preview, atajos de Enter/Escape. Accesible (`aria-live`, nombres legibles).

## Fuera de alcance
Kerf/material, offsets variables, offset de grupos con diferentes distancias, offset de curvas preservando Bézier (resultado = polilíneas
aplanadas a la tolerancia, documentado), persistencia (S13).

## Tests exigidos
- **Python** (valores calculados a mano): rectángulo w×h con offset exterior inglete ⇒ área (w+2d)(h+2d); redondo ⇒ wh+2d(w+h)+πd²
  (tolerancia explícita por aplanado de arcos); bisel (área intermedia); interior de un rectángulo ⇒ (w−2d)(h−2d) y **colapso exacto**
  cuando 2d ≥ min(w,h); círculo aproximado ⇒ π(r+d)²; polígono con hueco (anillo: el hueco se achica/agranda); mancuerna (dos
  cuadrados unidos por cuello fino) con offset interior ⇒ 2 piezas (`splitCount`); línea abierta con caps (longitud×2d + extremos);
  inglete con ángulo agudo respeta `mitreLimit`; `maxInwardOffset` correcto en un rectángulo (= min(w,h)/2) y consistente con el colapso;
  winding horario/antihorario ⇒ mismo resultado; determinismo byte a byte; entradas degeneradas, límites y errores 400/422; rendimiento
  razonable con muchos subjects.
- **.NET**: validador (cada regla de 400), servicio, cliente (revalidación de respuesta), endpoint de punta a punta con Python simulado.
- **Frontend** `offset.ts`: mm→unidades con escala (y sin escala ⇒ aviso), signo por dirección, líneas ⇒ solo ambos lados, colapso total/
  parcial ⇒ reglas de Apply/confirmación, conservar vs. reemplazar, capa de origen vs. destino explícito, bloqueadas/ocultas ⇒ rechazo,
  piezas múltiples con ids nuevos, `fill` de la capa, comando único. Panel/hook/shell: preview con debounce/abort (mocks de `fetch`
  con `AbortSignal` y conteo de llamadas), una petición viva, error del servidor ⇒ nada cambia, Cancel sin rastro y sin llenar undo,
  undo/redo exactos, presets, validación del campo, StrictMode.
- La suite existente (S01–S08) debe seguir verde.
- Verificación: `dotnet build`, `dotnet test` (completo), `pytest` (`services/python-engine/.venv/Scripts/python.exe -m pytest -q`),
  `npm test`, `npm run build`, `npm run lint` (sin errores nuevos).

## DoD
Offset interior/exterior en mm (con joins/caps), con preview y advertencias de colapso/división, genera geometría válida o explica por qué
no puede aplicarse; conserva la escala real; es un comando atómico undoable que nunca decide la capa en silencio.

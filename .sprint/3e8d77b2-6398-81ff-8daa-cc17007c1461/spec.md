# spec.md — M3-S10 · Cut / Split de geometría

> **Nota de origen**: durante esta tarjeta el conector de Notion estaba desconectado, así que esta spec se redactó con el
> **Objetivo** y el **Criterio de aceptación** de la tarjeta (que ya se habían leído) y no con su cuerpo completo (UX/Tests). Si
> el cuerpo de la tarjeta trae requisitos adicionales, se tratarán como corrección posterior.
>
> Lee primero `docs/ADR_EDITOR_MVP3.md` (D4 y decisiones de S08/S09) y los `IMPL.md` de M3-S01..S09, sobre todo **S04**
> (`.sprint/3e8d77b2-6398-8102-b5de-e68e3f8fc1c0/`: servicio de geometría, `bufferedLine`, `difference`, formato de anillos), **S08**
> (`.sprint/3c1d77b2-6398-81f7-9504-d7070d96c1c0/`) y **S09** (`.sprint/3c1d77b2-6398-81bf-9525-eb27252cf0fd/`: `useGeometryPreview`
> generalizado, panel con preview + debounce + abort, resultados → objetos nuevos, advertencias). Reusá esa infraestructura.

## Contexto
Objetivo (Notion): "Dividir paths o piezas usando una línea/segmento de corte y producir componentes vectoriales válidos."
Criterio: "El usuario define un corte, previsualiza el resultado y Apply produce geometría separada con IDs/componentes recalculados y
Undo disponible." Área: Frontend, Vector, Laser. La herramienta **Cut** existe en el toolbar (hoy deshabilitada): habilitala.

## Decisiones (documentalas en IMPL.md, ADR y UI)
1. **Dos modos explícitos de corte** (selector visible; el activo siempre indicado):
   - *Dividir* (sin hueco): el objeto se parte a lo largo de la línea; las piezas **comparten el borde** del corte (caso típico:
     separar piezas para tratarlas por separado).
   - *Separar con hueco* (ranura): se resta una ranura de ancho configurable en **mm** (default 0,2 mm) centrada en la línea
     (`difference` con `bufferedLine`, ya existente en S04); las piezas quedan **físicamente separadas** (caso típico: láser).
2. **Línea de corte**: polilínea de 2+ puntos dibujada en el canvas (click por punto; doble click/Enter termina; Backspace quita
   el último; Escape cancela) y atajo de **segmento recto** (arrastre). Opción **"Extender el corte hasta cruzar todo"** (la
   primera/última recta se prolonga lo necesario): sin ella, un corte que **termina dentro** de una forma NO la divide (queda
   intacta) y el panel lo dice ("el corte no atraviesa completamente «X»"). Coordenadas en unidades de documento, guía en mm.
3. **Alcance explícito**: con selección ⇒ solo los objetos seleccionados; sin selección ⇒ **todos los objetos visibles y
   desbloqueados cruzados por la línea**, listados antes de aplicar ("Se cortarán N objetos: …"). Objetos de capas bloqueadas/
   ocultas se **omiten e informan** (consistente con S01; no se rechaza toda la operación porque no son operandos consumidos). Líneas
   abiertas (trazos) también se parten en segmentos; objetos sin geometría legible se omiten con aviso.
4. **Resultado**: cada **pieza** disjunta = un objeto nuevo (ids nuevos, **misma capa** del objeto de origen —no hay decisión de capa—,
   mismo `fill`/`stroke`, sin matriz, huecos como subpaths); un objeto no cruzado conserva su `d` original (`changed:false`); orden
   de pintado determinista y las piezas ocupan el lugar del original. Piezas con área < tolerancia² se descartan con aviso. "IDs/
   componentes recalculados": las piezas son objetos independientes y el recuento por capa (`pathCount`) refleja el nuevo total.
5. **Validez y advertencias — nada en silencio**: resultados validados (sin NaN, sin polígonos inválidos); el servidor informa por
   subject `pieces` y `changed`; el panel muestra el número de piezas resultantes por objeto y avisa si **ninguno** cambia (Apply
   deshabilitado con la explicación). Errores del servidor ⇒ no cambia nada.
6. **Preview + Apply/Cancel**: igual que S08/S09 (debounce, abort, una petición viva, estados *calculando…*/error/sin cambios, preview
   que **colorea cada pieza** de forma distinguible con el original atenuado, que no llena la pila de undo, Enter/Escape). Un
   comando atómico undoable por Apply (Undo restaura los objetos originales exactos).

## Alcance técnico
- **Python** (`services/python-engine`): operación **`split`** en el servicio de geometría (módulo `geometry_ops.py` o `geometry_split.py`,
  ruta `POST /api/v1/geometry/split`, mismos límites/timeout/errores que el resto). Request: `{ subjects:[Geometry…], cutter:{ points },
  mode:"split"|"slot", slotWidth, extend:boolean, tolerance }`. *Dividir*: partir polígonos con `shapely.ops.split` / `polygonize`
  (robusto con huecos y varias intersecciones) y líneas con `split`; *ranura*: `difference` con el buffer de la línea. Respuesta por
  subject: `{ changed, pieces:[Geometry…], pieceCount }`, orden **determinista**, validado (`is_valid`), sin slivers < tolerancia².
- **ASP.NET Core**: `POST /api/v2/geometry/split` (endpoint → servicio → cliente Python, como boolean/offset): validación 400
  (NaN/Infinity, `points` < 2, modo/`slotWidth` inválidos, límites de tamaño), el cliente revalida la respuesta (un resultado por
  subject, `pieceCount` coherente, solo piezas del tipo correcto), 503/504/502 uniformes. Sin DB ni usuario.
- **Frontend**: `lib/editor/cut.ts` (puro: construcción de la línea y la petición, alcance, interpretación de la respuesta, advertencias,
  `applyCutResult` ⇒ `EditProduction`, reglas de locks/ocultas), `hooks/useCutOperation.ts` (sobre `useGeometryPreview`), `CutPanel.tsx`
  (modo, ancho de ranura en mm, extender, alcance/objetos afectados, conteo de piezas, estados, Apply/Cancel), superficie de dibujo de la
  línea (reusar `ToolSurface`), `CutOverlay` (línea + piezas coloreadas), herramienta **Cut** habilitada. Accesible (`aria-live`, nombres
  legibles).

## Fuera de alcance
Corte con curvas (la línea es una polilínea; las curvas de los objetos sí se cortan tras aplanarlas), cortes múltiples simultáneos, snapping,
reunir piezas (eso es Unión de S08), puentes (S11), persistencia (S13).

## Tests exigidos
- **Python** (valores calculados a mano): cuadrado dividido por la diagonal ⇒ 2 triángulos de área mitad (suma exacta); rectángulo con corte
  recto ⇒ áreas w1·h y w2·h; polígono con hueco cortado por la mitad (el hueco se reparte); forma en "U" cortada por una línea que cruza 2
  veces ⇒ 3 piezas; corte que no atraviesa ⇒ `changed:false`; `extend` hace que sí atraviese; ranura de ancho w ⇒ área original − w·longitud
  atravesada y 2 piezas separadas; línea abierta partida en segmentos con longitudes calculadas; línea de corte colineal con un borde; winding
  horario/antihorario ⇒ mismo resultado; slivers filtrados; determinismo byte a byte; entradas degeneradas; límites y errores 400/422;
  rendimiento razonable con muchos subjects.
- **.NET**: validador (cada regla), servicio, cliente (revalidación), endpoint de punta a punta con Python simulado.
- **Frontend** `cut.ts`: alcance (selección vs. todos los cruzados), locks/ocultas omitidos con aviso, `changed:false` conserva `d`, piezas con
  ids nuevos y misma capa/fill/stroke, huecos, orden e inserción deterministas, descarte de piezas mínimas, "ninguno cambia" ⇒ sin producción,
  ranura en mm→unidades, extender. Panel/hook/shell: dibujo de la línea (puntos, Backspace, Enter, Escape, segmento por arrastre), preview con
  debounce/abort (mocks de `fetch` con `AbortSignal` y conteo de llamadas), una petición viva, error del servidor ⇒ nada cambia, Cancel sin
  rastro y sin llenar undo, un comando por Apply, undo/redo exactos, StrictMode.
- La suite existente (S01–S09) debe seguir verde.
- Verificación: `dotnet build`, `dotnet test`, `pytest` (`services/python-engine/.venv/Scripts/python.exe -m pytest -q`), `npm test`,
  `npm run build`, `npm run lint` (sin errores nuevos). **Entorno**: si Docker sigue sin arrancar, los tests con Testcontainers no pueden
  correr; reportalo con el desglose (qué falla y por qué) y corré al menos `dotnet test --filter Geometry`.

## DoD
El usuario dibuja un corte (o un segmento), ve el preview de las piezas, y Apply produce piezas separadas válidas (con o sin ranura) con ids
nuevos y en su capa, de forma atómica y reversible, sin que nada cambie en silencio.

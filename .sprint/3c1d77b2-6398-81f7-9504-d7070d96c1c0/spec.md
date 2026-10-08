# spec.md — M3-S08 · Operaciones booleanas

> Lee primero `docs/ADR_EDITOR_MVP3.md` (D4: servicio de geometría) y los `IMPL.md` de M3-S01..S07, en especial **S04**
> (`.sprint/3e8d77b2-6398-8102-b5de-e68e3f8fc1c0/IMPL.md`: ya existe `POST /api/v2/geometry/boolean` → Python/Shapely con
> `union|difference|intersection|xor|normalize`, formato de anillos, `changed`, límites), **S03** (`…-81ac-…`: mover objetos entre
> capas, crear capas, color de la capa) y **S06/S07** (patrón de acciones atómicas con panel, atajos y mensajes). Esta tarjeta
> añade la **UI y la cobertura profunda** de las booleanas sobre ese mismo endpoint; no crees un endpoint paralelo.

## Contexto
Criterio (Notion): "Operaciones producen geometría válida sobre el conjunto de casos de prueba." DoD: "Cada operación produce
geometría válida o un error explícito sin pérdida de datos." UX pedida: acciones habilitadas según selección, **orden de
operandos explícito**, preview, Apply/Cancel y errores comprensibles. Motor: "Clipper2 u opción validada" ⇒ **decisión: Shapely/GEOS**
(ya en el motor, sin dependencias nuevas en .NET; documentala en el ADR con la justificación: robustez de OverlayNG, ya validado
en S04). Layers: **nunca decidir silenciosamente el color/layer final**. Preservar la versión anterior.

## Decisiones (documentalas en IMPL.md, ADR y UI)
1. **Operandos y orden explícitos**: la acción trabaja con 2+ objetos **con relleno** seleccionados (las líneas abiertas/`fill:"none"`
   se rechazan con mensaje: "Las booleanas operan sobre formas rellenas"). El orden por defecto es el de **pintado** (el de abajo =
   A, luego B, C…), mostrado con insignias A/B/C sobre el canvas y en la lista del panel, que permite **reordenar (subir/bajar) e
   invertir**. Semántica: *Unión* = A ∪ B ∪ …; *Diferencia* = A − (B ∪ C ∪ …) (A es la base); *Intersección* = región común a
   **todos**; *XOR* = región cubierta por un número **impar** de operandos (simetría n-aria; con 2 operandos es el XOR clásico).
   Verificá la semántica actual de `intersection` en `app/core/geometry_ops.py` (`run_boolean`): si no soporta "común a todos los
   subjects", agregala **sin romper** los usos de S04 y documentá el contrato; lo mismo para `xor`/`union` n-arios.
2. **Capa/color del resultado — decisión explícita del usuario**: si todos los operandos están en la **misma capa**, el resultado va
   a esa capa (visible en el panel). Si pertenecen a **capas distintas**, el panel exige elegir la **capa destino** (selector sin valor
   por defecto; "Aplicar" deshabilitado hasta elegir) entre las capas de los operandos (u otra capa desbloqueada y visible, o una
   capa nueva con la mecánica de S03). El color del resultado es el de la capa destino. Nada se decide en silencio.
3. **Originales**: opción "Conservar originales" (default **desactivada** ⇒ los operandos se reemplazan por el resultado en un solo
   comando; activada ⇒ se agregan los resultados y los originales quedan). Siempre un comando atómico y undoable ⇒ la versión
   anterior se recupera con Undo. Operandos en capas **bloqueadas u ocultas** se rechazan (como en S01..S07); la capa destino debe
   estar desbloqueada y visible.
4. **Resultado**: cada **pieza** disjunta del resultado es un objeto nuevo (ids nuevos, capa destino, `fill` de la capa, sin matriz),
   con sus huecos como subpaths del mismo objeto; el orden de pintado de las piezas es determinista (el del servidor) y se insertan
   donde estaba el operando de más arriba (documentá la regla). Un objeto operando **no afectado** por la operación (p. ej. una
   diferencia donde B no toca a A, `changed:false`) conserva su `d` original (Bézier intactos) en vez de aplanarse.
   **Resultado vacío** (p. ej. intersección de disjuntos, diferencia totalmente cubierta) ⇒ NO se aplica: error comprensible
   "El resultado está vacío" y no cambia nada. Resultados degenerados (área < tolerancia²) se descartan con aviso.
5. **Precisión**: los operandos se aplanan en el cliente (con su `matrix` horneada) a la tolerancia configurable del panel
   (default 0,01 mm → unidades de documento; avanzado, con mínimo/máximo); el resultado son polilíneas (documentado en el ADR en D4).
6. **Preview + Apply/Cancel**: al abrir el panel y al cambiar operación/orden/capa/tolerancia se pide el resultado al servidor
   (debounce, `AbortController`, una petición viva a la vez) y se muestra como **preview** sobre el canvas (los operandos atenuados);
   estados *calculando…*, *error recuperable* (nada cambia), *resultado vacío*. Apply (Enter) confirma con el resultado ya calculado
   (si cambió algo desde el último preview, recalcula primero); Cancel (Escape) no deja rastro; el preview **no** llena la pila de undo.

## Alcance técnico
- **Python/ASP.NET** (`services/python-engine`, `backend/`): sin endpoint nuevo. Completar/endurecer lo necesario para n-arios
  (ver decisión 1), y cubrir **a fondo** con tests: solapamiento parcial/total, no solapamiento, contención, bordes que se tocan,
  polígonos idénticos, huecos e islas dentro de huecos, **winding horario/antihorario** (la regla par-impar debe dar el mismo
  resultado), entrada autointersectante (`make_valid`), slivers (filtro por tolerancia), tolerancias distintas, coordenadas
  grandes/pequeñas, n-arios (3+ operandos) para las 4 operaciones con resultados calculados a mano (áreas), orden de operandos
  (A−B ≠ B−A), determinismo byte a byte, límites y errores 400/422, y un test de rendimiento razonable (p. ej. 200 operandos
  pequeños) sin umbrales frágiles. En .NET: tests de endpoint/servicio para los casos n-arios y de validación.
- **Frontend**: `lib/editor/boolean.ts` (puro: `planBoolean(selection, document, {op, order, targetLayer, keepOriginals,
  tolerance})` ⇒ petición + función `applyBooleanResult(plan, response)` ⇒ `EditProduction`; validaciones y motivos de rechazo;
  etiquetas), `hooks/useBooleanOperation.ts` (preview con debounce/abort sobre `useGeometryOperation`/`geometryApi` de S04),
  `BooleanPanel.tsx` (operación, lista de operandos con A/B/C + reordenar/invertir, capa destino, conservar originales, tolerancia,
  estados, Apply/Cancel), overlay de insignias/preview en el canvas, botón(es) de acceso (p. ej. grupo "Booleanas" en la barra
  contextual junto a `ArrangeBar`) con estado deshabilitado + motivo (< 2 objetos, líneas abiertas, bloqueados) y atajo opcional.
- Accesibilidad: panel operable por teclado, `aria-live` para estados del cálculo, nombres de operandos legibles (nombre de capa +
  índice) además de la insignia.

## Fuera de alcance
Offset (S09), corte por línea (S10), puentes (S11), booleanas sobre líneas abiertas, preservar curvas Bézier en el resultado,
persistencia (S13), historial como panel (S12).

## Tests exigidos
- Python y .NET como arriba (valores **calculados a mano**; los tests deben fallar si se invierte A/B, si winding cambia el resultado,
  si n-ario se reduce a binario, etc.).
- `lib/editor/boolean.ts`: orden por defecto (pintado) y reordenado/invertido, diferencia no commutativa, capas distintas ⇒ exige
  destino, misma capa ⇒ destino automático, líneas abiertas/bloqueadas/ocultas rechazadas, conservar originales, resultado vacío ⇒
  sin producción, `changed:false` conserva `d`, piezas múltiples con ids nuevos y huecos, orden/posición de inserción determinista,
  color de la capa destino, tolerancia convertida desde mm.
- Panel/hook/shell: preview con debounce y abort (mocks de `fetch` con `AbortSignal` y conteo de llamadas), una petición viva,
  error del servidor ⇒ nada cambia, Apply recalcula si hay preview viejo, Cancel sin rastro y sin llenar la pila de undo, un comando
  por Apply (la pila crece exactamente 1), undo/redo exactos, atajos/estados deshabilitados, StrictMode.
- La suite existente (S01–S07) debe seguir verde.
- Verificación: `dotnet build`, `dotnet test` (completo), `pytest` (`services/python-engine/.venv/Scripts/python.exe -m pytest -q`),
  `npm test`, `npm run build`, `npm run lint` (sin errores nuevos).

## DoD
Unión, diferencia, intersección y XOR sobre 2+ formas rellenas, con orden de operandos explícito, preview y Apply/Cancel, producen
geometría válida o un error explícito; la capa/color final es siempre una decisión visible del usuario; todo es un comando
undoable y no se pierde nada.

# IMPL.md — M3-S09 · Offset de geometría

## Resumen
Offset interior/exterior en mm (joins y caps) con preview y Apply/Cancel, sobre el servicio de geometría de S04/S08 (Shapely
`buffer`, endpoint sin estado), detección de colapso y de división, y `maxInwardOffset`. Spec: `spec.md`. (La sesión del
implementador se cortó una vez por un límite de uso de la API y se retomó; el árbol estaba completo.)

## Decisiones
- **Motor**: Shapely `buffer` (misma decisión que S08). Distancia firmada (+ exterior, − interior); la UI usa distancia ≥ 0 +
  dirección. Líneas abiertas: solo "ambos lados" (polígono de ancho 2×offset, con caps redondo/plano/cuadrado); Interior deshabilitado.
- **Cable**: Python en snake_case (`/api/v1/geometry/offset`, como S04); ASP.NET y editor en camelCase (`/api/v2/geometry/offset`).
- **Escala real**: el panel trabaja en mm y convierte con `mmPerUnit`; sin escala física avisa y trabaja en unidades; la tolerancia es
  en mm. Tope de 1000 mm en el editor; el servidor acota en unidades (1 000 000).
- **Colapso y división nunca en silencio**: el servidor informa por subject `collapsed`, `pieces_before`, `split_count`,
  `lost_pieces`, `holes_before/after` y `max_inward_offset` (círculo inscrito máximo). Todos colapsan ⇒ Apply deshabilitado con
  explicación; algunos colapsan ⇒ Apply exige confirmar (la casilla se descarta ante cualquier cambio de valores, selección u
  opciones); un objeto que colapsa nunca se toca, ni siquiera con «Reemplazar». División/huecos se informan sin pedir confirmación.
- **Resultado**: por defecto **conservar original** (opción reemplazar); cada resultado va a la capa de su objeto de origen o a una
  destino explícita; origen bloqueada/oculta ⇒ rechazo; una pieza = un objeto nuevo (ids nuevos, huecos como subpaths, `fill` de la
  capa), encima del origen; un comando atómico undoable; preview sin llenar la pila de undo.

## Entregado
- **Python**: `app/core/geometry_offset.py`, `process_offset` en el servicio (timeout y límites), ruta `POST /api/v1/geometry/offset`
  (lectura de cuerpo compartida con booleanas), esquemas y topes configurables (distancia, inglete).
- **ASP.NET**: contratos, `ValidateOffset` (`invalid_distance`, `unknown_join_style`, `unknown_cap_style`, `invalid_mitre_limit`),
  `GeometryService.OffsetAsync`, `PythonGeometryClient.OffsetAsync` (revalida eco de parámetros, coherencia de `collapsed`/
  `split_count`/`holes_after`, solo polígonos, `max_inward_offset` nulo solo en líneas), endpoint, `MaxOffsetDistance`/`MaxMitreLimit`.
- **Frontend**: `lib/editor/offset.ts` (puro), `useGeometryPreview` (el hook de preview de S08 generalizado; `useBooleanOperation` y
  `useOffsetOperation` son envoltorios finos), `OffsetPanel`, `OffsetOverlay`, herramienta **Offset** habilitada, `MeasureField` con
  flechas ↑/↓. ADR actualizado.

## Verificación (orquestador) — con una limitación de entorno
- `dotnet build` 0/0 · `pytest` **662/662** · `npm test` **2217/2217** (una corrida tuvo un fallo del test viejo
  `ManufacturingOperations`, que pasa aislado y en la corrida completa siguiente: flake por carga) · `npm run build` limpio ·
  `npm run lint` 0 errores · `dotnet test --filter Geometry` **336/336**.
- **`dotnet test` completo NO se pudo ejecutar entero**: Docker Desktop no arranca en este equipo desde la sesión anterior (el
  proceso no aparece y `wsl --status` informa "WSL 1 no es compatible con la configuración actual"). Resultado real: 1059 superados,
  166 con error; **todos los fallos son de tests con Testcontainers/PostgreSQL** (`DockerUnavailableException`) salvo uno
  (`ConsolidatedVectorLayerEndpointsTests…`) que tardó 2 min 27 s por carga y **pasa aislado (4/4)**. Esta tarjeta no toca código de
  base de datos (solo `Geometry/`, `Clients/`, `Options/`, `Program.cs` para registrar opciones, `appsettings.json`), y la última
  corrida completa con Docker (S08, `main`) fue 1065/1065. **Pendiente**: volver a correr `dotnet test` completo cuando Docker esté
  disponible (se exige de nuevo en S10/S16).
- Mutaciones del implementador: Python 17, C# 12, frontend 24 — todas detectadas (las que sobrevivieron al principio se
  reforzaron con tests).

## Hallazgos
- GEOS recorta la punta del inglete a `límite × distancia` (no la convierte en bisel).
- Con `JsonSerializerDefaults.Web`, un `"NaN"` entre comillas llega como NaN al validador y se rechaza ahí.
- Los mensajes de error de `geometry.ts` hablaban del pincel de Erase: Offset tiene los suyos.

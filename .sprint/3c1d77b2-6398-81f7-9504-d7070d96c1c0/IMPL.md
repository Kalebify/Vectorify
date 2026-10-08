# IMPL.md — M3-S08 · Operaciones booleanas

## Resumen
Unión, diferencia, intersección y XOR n-arias sobre 2+ formas rellenas, con orden de operandos explícito, capa destino decidida por
el usuario, preview y Apply/Cancel, sobre el endpoint de geometría de S04 (sin endpoint paralelo). Spec: `spec.md`.

## Decisiones
- **Motor: Shapely/GEOS** (la tarjeta pedía "Clipper2 u opción validada"): ya en el motor, sin dependencias nuevas en .NET, OverlayNG
  robusto, ya validado en S04 y reutilizable por S09–S11. Documentado en el ADR (D4).
- **Semántica n-aria**: *Unión* = A ∪ B ∪ …; *Diferencia* = A − (B ∪ C ∪ …); *Intersección* = región común a **todos**;
  *XOR* = paridad impar. En S04 `intersection` es "cada subject ∩ unión de operandos" (lo usa Erase), por lo que se agregó la
  operación nueva **`intersection_all`** (subjects + operands, mínimo 2, resultado combinado; borde/vértice compartido ⇒ vacío)
  sin tocar el contrato de S04. `xor` ya era de paridad impar y `union` ya era n-ario (cubiertos con tests). Una operación
  desconocida ahora lanza error (antes caía en la rama `xor`).
- **Operandos**: orden por defecto = pintado (el de abajo es A), con insignias A/B/C, subir/bajar e invertir. Líneas abiertas,
  capas bloqueadas/ocultas y >500 operandos rechazan la operación completa (nunca se omite un operando en silencio).
- **Capa/color del resultado**: misma capa ⇒ esa; capas distintas ⇒ **selector obligatorio sin valor por defecto** (Aplicar
  deshabilitado; `applyBooleanResult` devuelve `target_required`); también capa nueva con hex (mecánica de S03). El color es el de
  la capa destino.
- **Resultado**: una pieza disjunta = un objeto nuevo (ids nuevos, `fill` de la capa, sin matriz, huecos como subpaths); `changed:false`
  conserva `d`, matriz e id; **vacío no se aplica**; área < tolerancia² se descarta con aviso. Inserción: ocupa el lugar del operando
  más alto de la capa destino (con "Conservar originales", justo encima); si ningún operando está en el destino, al tope.
- **Preview**: petición con debounce (250 ms) y `AbortController`, una viva a la vez; la primera sale sin debounce; cambiar solo capa
  destino o "Conservar originales" no re-pide (la geometría no depende de eso); Apply recalcula si el preview es viejo. No llena la
  pila de undo; Cancel/Escape/cambiar de herramienta sin rastro; un comando atómico por Apply.

## Entregado
Python: `intersection_all` + contrato documentado (`geometry_ops.py`, `schemas.py`, ruta). .NET: `GeometryOperation.IntersectionAll`
(nombre en el cable `intersection_all`), validador (≥ 2 formas). Frontend: `lib/editor/boolean.ts` (puro), `useBooleanOperation`,
`BooleanBar` (motivo visible del deshabilitado), `BooleanPanel` (lista A/B/C, reordenar/invertir, destino, conservar originales,
tolerancia 0,001–1 mm, `aria-live`), `BooleanOverlay` (insignias, velo, preview) e integración en `EditorShell`/`VectorCanvas`.

## Desviaciones / hallazgos
- Operación nueva `intersection_all` en vez de reinterpretar `intersection`. Sin atajo de teclado dedicado (opcional en la spec).
- El servidor descarta astillas < tolerancia² sin avisar; el cliente descarta e informa las que le llegan.
- `useGeometryOperation.run` rechaza llamadas mientras el controller anterior no se asentó tras `cancel()`: el hook nuevo encadena
  las peticiones. En operaciones combinadas con polígonos el servidor devolvería como línea un borde compartido: filtrado en
  `intersection_all`.

## Verificación (orquestador)
Ver el reporte de QA en Notion y el PR. El implementador comprobó con 36 mutaciones (35 detectadas; 1 equivalente) que los tests
pueden fallar.

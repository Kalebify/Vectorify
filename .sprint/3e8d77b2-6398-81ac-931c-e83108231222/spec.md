# spec.md — M3-S03 · Fill + Recolor + Eyedropper

> Lee primero `docs/ADR_EDITOR_MVP3.md` y los `IMPL.md` de M3-S01 (`.sprint/3c1d77b2-6398-8167-977a-f44248e874b1/`)
> y M3-S02 (`.sprint/3e8d77b2-6398-81c5-9257-ea063abbaa7e/`). Reusás `lib/editor/*`, `useEditableDocument`
> (`applyEdit`, gestos, undo/redo, locks, `frame`), el Inspector de objetos, `PaletteBar` y `EditorLayersPanel`.

## Contexto
Criterio (Notion): "Fill/Recolor cambia objetos seleccionados, Eyedropper toma color existente y la paleta/layers
se mantienen consistentes." Regla de la tarjeta: **no usar HEX como identidad**; si una operación crea un color
nuevo, actualizar el modelo Palette/Color **explícitamente**. DoD: "El usuario puede corregir colores sin romper
la asociación Layer↔Palette↔Paths."

## Modelo (decisión de dominio — documentala en IMPL.md)
En este documento **una capa = un color de paleta** (relación 1:1: `Layer.ColorId`, `PaletteColor`), y el color
de un objeto es el de **su capa** (el `fill` del `<path>` es redundante). Por eso:
1. **La identidad de un color es la capa (`groupId`), no su hex.** Dos capas pueden tener el mismo hex
   visual sin ser el mismo color. Nunca se usa el hex como clave de nada (map keys, agrupaciones, selección).
2. **Fill sobre objetos = mover esos objetos a la capa del color elegido.** El color se elige de la paleta
   (swatches = capas existentes → destino explícito por `groupId`) o con un selector de color libre:
   - color libre que **coincide en hex** con una capa existente: se ofrece "Usar la capa «X»" (destino por
     `groupId`), nunca se compara en silencio;
   - color libre **nuevo** ⇒ se **crea una capa nueva** (nombre "Color #RRGGBB" editable, `groupId` UUID nuevo,
     misma operación de fabricación por defecto que las demás, orden al final, visible, no bloqueada) con su
     color de paleta nuevo, y los objetos se mueven a ella. La creación es explícita, visible en el panel de
     capas y en la barra de paleta, y entra en el mismo comando (undo la elimina).
3. **Recolor con alcance explícito** `selección | capa | documento`, desde un panel contextual con **scope
   visible**, preview, resumen ("Se recolorarán N objetos en M capas") y **confirmación cuando afecte a muchos
   objetos** (umbral configurable, default 50 objetos o cualquier alcance "documento"):
   - *Selección*: igual que Fill (mover los objetos al color destino).
   - *Capa*: **cambia el color de la propia capa** (mismo `groupId`/ColorId, hex nuevo): todos sus objetos
     cambian; si el hex destino coincide con **otra** capa, se ofrece "Fusionar con «X»" como opción explícita y
     confirmada (mueve todos los objetos y deja la capa origen vacía, sin borrarla en silencio: queda vacía y se
     informa); nunca fusiona sin que el usuario lo elija.
   - *Documento*: sustituye un color origen por uno destino en todo el documento (origen = una capa elegida);
     misma regla que *Capa*.
   Respeta locks (capas bloqueadas no se modifican ni reciben objetos; se informa cuántos objetos se omitieron).
4. **Eyedropper**: click sobre el canvas toma el color del **objeto visible bajo el cursor** (hit-test geométrico
   de S01, el más arriba) → devuelve su **capa** (no un hex suelto): el color queda como "color activo" referido a
   esa capa, y el siguiente Fill/Recolor usa esa capa como destino; muestra swatch + nombre de capa + hex.
   Click en vacío: sin cambios. No muestrea píxeles (la fuente de verdad es el modelo, no el render).

## Alcance técnico

### 1. Estructura de capas editable y undoable (`lib/editor`, `useEditableDocument`)
La estructura de capas pasa a ser parte del estado editable (hasta ahora solo vivía en `useVectorDocument`,
persistida por PATCH): `EditableLayerMeta { groupId, name, colorHex, order, visible, locked, manufacturingOperation,
isNew }`. Extendé `EditorEdit` (como hiciste con `frame` en S02) con `layers?: {before, after}` opcional y
retrocompatible: **un comando puede cambiar objetos + estructura de capas a la vez** (Fill con color nuevo =
crear capa + mover objetos, atómico, undo/redo exacto). `geometryDirty` se activa también por cambios de
estructura. Las capas creadas en cliente tienen `isNew: true` (aún sin existir en el servidor; se persisten con
M3-S13 — dejá el TODO(M3-S13) existente cubriéndolo).
`EditorShell` expone a `EditorLayersPanel`/`PaletteBar`/Inspector la lista **efectiva** de capas (servidor +
overrides del editor); los PATCH de metadata existentes (nombre/visible/lock/orden/operación) siguen
funcionando para capas del servidor; para capas `isNew` operan sobre el estado local (sin PATCH).
Helpers puros nuevos en `lib/editor/colors.ts`: normalización de hex (`#rgb`, `#rrggbb`, mayúsculas), parse/format,
`findLayersByHex` (solo para **ofrecer** coincidencias, nunca como identidad), `buildFillProduction`,
`buildRecolorProduction(scope, …)`, `summarizeRecolor`.

### 2. UI
- Herramientas **Fill** y **Color** habilitadas en `EditorToolbar` (Fill = aplicar color activo a la selección /
  objeto clickeado; Color = abre el panel de Recolor con scope), **Eyedropper** (atajo `I`; agregá el botón a
  la barra, el wireframe obligatorio original no lo traía: hacelo visible y documentalo).
- Panel contextual de color: selector de color nativo + campo hex (validado) + swatches de la paleta
  (`PaletteBar` reutilizada) + color activo + scope (radio selección/capa/documento, deshabilitando lo que no
  aplica: sin selección no hay "selección") + preview (gesto `beginGesture/previewEdit` de S01: no llena la pila
  de undo, Cancel no deja rastro) + resumen + Apply/Cancel (Enter/Escape) + confirmación para alcances grandes.
- Inspector: muestra la capa/color del objeto seleccionado y refleja el resultado inmediatamente; `PaletteBar` y
  el panel de capas reflejan capas nuevas/colores cambiados al instante.
- Accesibilidad: todo operable por teclado; `aria-*`; el swatch indica nombre de capa además del color.

## Fuera de alcance
Gradientes/strokes/opacidad, bibliotecas de colores, reducción/cuantización de paleta, persistencia (S13),
cambio del algoritmo de detección de paleta, cambiar la operación de fabricación al recolorear (se mantiene la de
la capa destino).

## Tests exigidos
- `lib/editor/colors.ts`: normalización de hex, coincidencias, producciones de Fill/Recolor (objeto único,
  multi-select, capa completa, **color compartido entre dos capas** — verificar que NO se confunden por hex,
  documento, fusión explícita), umbral de confirmación, capas bloqueadas, capa nueva (campos por defecto).
- Comandos: Fill con color nuevo = un comando atómico (capa + objetos), undo elimina la capa y devuelve los
  objetos; cancel sin rastro; recolor de capa conserva el `groupId`; fusión deja la capa origen vacía y lo
  informa; la estructura se restaura exacta con undo/redo.
- Eyedropper: toma la capa del objeto más arriba, superpuestos, vacío, capa oculta (no toma), capa bloqueada
  (sí toma: solo lee).
- Componentes: panel de color (hex inválido, scope deshabilitado según selección, confirmación, Apply/Cancel por
  teclado), `PaletteBar`/`EditorLayersPanel` reflejan capas nuevas, Inspector. Mocks de `fetch` con `AbortSignal`.
- Verificación: `npm test`, `npm run build`, `npm run lint` (sin errores nuevos), `dotnet build`.

## DoD
Fill/Recolor/Eyedropper corrigen colores con alcance explícito y confirmación, sin usar el hex como identidad,
manteniendo coherentes capas, paleta y paths (incluida la creación explícita de colores nuevos), con undo/redo
exactos.

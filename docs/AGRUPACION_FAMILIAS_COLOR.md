# Agrupación por familias de color base

Tarjeta de Notion «Agrupar sombras y variantes en colores base antes de vectorizar (una capa por familia)».
Especificación congelada: `.sprint/405d77b2-6398-8171-aa55-f0ba2f2d99e4/spec.md` (CA-01…CA-14).

## Qué hace

Dos estilos de agrupación al detectar la paleta (`POST …/color-palette/detect`):

| Estilo | Valor API | Qué produce |
| --- | --- | --- |
| **Colores base** | `base_colors` | Reúne luces y sombras de una misma familia en **un grupo por familia** (una capa tras generar capas), con todas sus piezas, y separa el **fondo** como grupo técnico. |
| **Conservar tonos y sombras** | `detailed` | El comportamiento histórico: un grupo por tono detectado. |

Parámetros nuevos (solo `base_colors`; en `detailed` se normalizan y no afectan a la caché):

* `groupingStyle` — `detailed` si se omite (la API nunca cambia sola).
* `targetFamilies` — 1–16 o `null` (automático). **Es un tope, no una cuota**: nunca se inventan familias que la imagen no tiene.
* `groupingStrength` — 0–1 (default 0,5). Más alto fusiona sombras más distintas; 0 conserva diferencias intencionales.
* `AlgorithmVersion` (1) — fija el algoritmo que generó la paleta; forma parte de la caché, de la persistencia y de la respuesta.

En `base_colors`, `maxColors` se ignora (el tope lo da `targetFamilies`).

La **UI** propone «Colores base» como valor inicial para detecciones **nuevas** (decisión documentada; el valor por defecto de la API sigue siendo `detailed`). Cambiar de estilo o de parámetros no toca la paleta ya detectada: solo se aplica con «Detectar de nuevo». Una paleta devuelta sin campos de estilo (API/documento anterior) se muestra como «Conservar tonos y sombras».

## Algoritmo (`services/python-engine/app/core/color_families.py`)

1. `detect_palette` (sin tope de colores) detecta los tonos como siempre.
2. **Fondo** (`detect_background`): color de referencia = grupo que más perímetro ocupa (≥ 50 %); fondo = sus componentes 4-conexos conectados al borde. Una apertura morfológica (radio 1 % del lado menor, mín. 2 px) separa las «bolsas» que solo se conectan por un cuello estrecho: **no se borran**, quedan en su familia y se cuentan como ambiguas. Además se mide el contacto del fondo con objetos claros neutros más gruesos que un anillo de antialiasing (p. ej. un ojo blanco junto a un fondo blanco): si existe → `needsReview`. Los blancos que no tocan el borde (ojos rodeados de color) nunca son fondo.
3. **Familias** (`cluster_families`): Lab → (L, C, h). Neutro si C < 8 + 10·fuerza o L < 12; neutros por salto de luminosidad (enlace simple), cromáticos por tono circular con guardas de luminosidad y croma (fusión aglomerativa por centroides). Un neutro nunca se fusiona con un cromático por umbral: solo el tope `targetFamilies` puede forzarlo, eligiendo el par de menor ΔE.
4. **Píxeles de transición** (`resolve_transition_pixels`): los anillos de antialiasing de ≤ 4 px entre dos regiones se reasignan al núcleo más cercano si su luminosidad queda entre las de ambos (evita contornos naranjas alrededor de las pupilas). Contornos oscuros genuinos y líneas finas sobre fondo liso no se tocan.
5. Cada píxel opaco queda en **exactamente una** familia o en el fondo; alpha 0 en ninguno (partición exacta, CA-05). Orden de presentación: área descendente, fondo al final. Determinista (CA-09).

No hay reglas del pato ni un número fijo de colores: los umbrales son funciones de `groupingStrength`.

## Contratos

* Motor Python: `ColorPaletteParams` (+`grouping_style`, `target_families`, `grouping_strength`), `ColorGroupPayload` (+`is_background`, `source_group_count`, `piece_count`), `ColorPaletteMetrics` (+`family_count`, `piece_count`, `background`), respuesta (+`algorithm_version`).
* ASP.NET Core: `ColorPaletteDetectRequest` (+`GroupingStyle`, `TargetFamilies`, `GroupingStrength`), `ColorPaletteParameters` (+estilo, parámetros, `AlgorithmVersion`; todos con defaults que reproducen el comportamiento histórico), `ColorGroup` (+`IsBackground`, `PieceCount`, `SourceGroupCount`), `ColorPaletteVersion` (+`Background`), respuesta HTTP (+`groupingStyle`, `targetFamilies`, `groupingStrength`, `algorithmVersion`, `familyCount`, `pieceCount`, `background`; por grupo +`isBackground`, `pieceCount`, `sourceGroupCount`).
* El fondo técnico se pre-excluye (`IsExcluded`), se llama «Fondo», se ordena al final y **no cuenta como familia**; incluirlo es una acción explícita del usuario (control Incluido/Excluido existente). Las capas se generan por grupo como siempre.
* Exportación: la selección **por defecto** del diálogo de exportación omite las capas excluidas en la paleta (el fondo técnico); se pueden elegir a mano (el preflight lo explica: «excluida en la paleta»). Esto también aplica a documentos anteriores con grupos excluidos (cambia solo el valor por defecto de la selección, no el documento guardado).

## Compatibilidad y caché (CA-10)

* Sidecars JSON de paletas anteriores se rehidratan como `detailed` / `AlgorithmVersion = 0` y **no se modifican**; su clave de caché no coincide con la de ninguna petición nueva, así que nunca se reutilizan como versión vigente ni se sobrescriben. Reabrir un documento sigue leyendo la paleta guardada.
* La clave de caché incluye tolerancia, `maxColors`, `tinyAreaRatio`, estilo, `targetFamilies`, intensidad y versión de algoritmo: alternar estilos o parámetros sobre una misma sesión da resultados correctos y conserva ambos en caché. Si el motor informa otra versión de algoritmo, el registro conserva la versión informada.

## Evidencia (pato 1152×2048, `tests/fixtures/pato_1152x2048.png`)

Entorno: Windows 11, CPython del `.venv` del repo, OpenCV, tolerancia 12, `tinyAreaRatio` 0,001, intensidad 0,5, objetivo automático.

| Medida | Antes (detallado) | Ahora (`base_colors`) |
| --- | --- | --- |
| Grupos / capas de color | 36 | **5 familias + 1 fondo técnico** (naranja, amarillo, gris/blanco, verde, negro) |
| Píxeles compartidos / sin asignar entre máscaras | 0 / 0 | 0 / 0 |
| Paths trazados (5 familias) | 557 (36 capas) | 56 |
| Detección (servicio completo, PNG→JSON) | — | 1,7–2,8 s en local; 2,1 s en Docker (timeout vigente 20 s, sin tocar) |

Clasificación (CA-03): sombrero → verde, cuerpo → amarillo, pico y pies → naranja (una capa, varias piezas), pupilas → negro (2 piezas), ojos izquierdo y derecho → gris/blanco; **≤ 8 píxeles naranjas sueltos dentro de las cajas de los ojos** (medidos: 0–1). Comprobado contra una referencia aprobada (`pato_familias_referencia.png`, acuerdo ≥ 99,5 %), no solo por conteo.

Trazado medido (CA-08, presupuestos en el spec):

| Capa | Desplazamiento medio de contorno | Contaminación sobre otras familias |
| --- | --- | --- |
| naranja | 0,73 px | 0,50 px |
| amarillo | 0,78 px | 0,45 px |
| gris/blanco | 0,70 px | 0,43 px |
| verde | 0,36 px | 0,18 px |
| negro | 0,31 px | 0,31 px |
| **solape entre familias** | 0,39 px de profundidad media (≈0,37 % del lienzo) | |
| **huecos entre familias** | 0,021 px (≈0,02 % del lienzo) | |

Presupuestos: ≤ 1,0 px (capa), ≤ 0,75 px (solape y contaminación), ≤ 0,25 px (huecos). Todos cumplidos. Cero paths vacíos, cerrados sin área o duplicados (`test_duck_traced_geometry_has_no_empty_degenerate_or_duplicate_paths`). **No se certifica «cero superposición»**: el trazado poligonal mide ≈0,3 px de solape medio; que sea aceptable depende del kerf (1 px = ancho_mm/1152 → 0,087 mm a 100 mm de ancho).

## E2E real (pila Docker aislada, 27/10/2026)

Pila propia (`docker compose -p vectorify-families-20261027`, puertos 33xxx, volúmenes propios, retirada al terminar) construida desde esta rama: Postgres 17, motor Python, Web API y frontend. Los servicios habituales del usuario no se tocaron.

* `tests/e2e/color_families_e2e_test.mjs` (HTTP real, PNG original del pato): **OK**. Detección `base_colors` objetivo 5 en **2,1 s** (Docker; límite 20 s); 5 familias (naranja, amarillo, blanco/gris, verde, negro) + fondo técnico excluido; cobertura exacta (suma de `pixelCount` = 1152×2048); alternar a `detailed` devuelve los 36 tonos y volver a `base_colors` sale de caché (7 ms, mismos `groupId`); objetivo 3 **no** reutiliza la caché de 5; reabrir conserva estilo/parámetros; paleta confirmada rechaza otra detección (409); 6 capas (5 familias + fondo `ignore`); guardado v2 y reapertura del documento (nombre editado, escala 150 mm, `viewBox` 0 0 1152 2048, fondo `isBackground`).
* Navegador (panel de paleta real): subida del PNG, estilo «Colores base» (recomendado) por defecto, 5 familias / 43 piezas, bloque «Fondo» con 67,4 % del lienzo, máscara y aviso de revisión (3,4 % de claros en contacto, 0,04 % por cuello estrecho), fila «Fondo técnico» excluida.
* Navegador (editor, documento guardado): 6 capas, fondo «Ignorada»; exportación real por el diálogo:
  * **SVG** `pato_documento.svg`, 25.985 bytes, `width="150mm" height="266.666667mm" viewBox="0 0 1152 2048" data-units="mm"`, **5 grupos** (una capa por familia) con **5 rellenos** (`#c8551f #bea90e #cac0bc #0f7739 #040303`), 77 paths (versión previa a la absorción de motas), sin duplicados ni subpaths de área < 1 px². El fondo no se exporta; no reaparecen los 36 tonos.
  * **DXF** `pato_documento.dxf`: `$INSUNITS 4` (mm), 5 capas (`NARANJA-PICO-Y-PIES`, `FAMILIA-2…5`), 69 polilíneas, extensión 17,2–137,6 × 0–231,4 mm dentro de 150 × 266,7 mm (56 objetos tras absorber motas).
* Laser Check del editor sobre las 5 familias: **Blocking** (65 islas flotantes tras absorber motas; 116 antes). Son caras diminutas (0,001–0,09 mm²) que aparecen donde los contornos de familias vecinas se solapan ≈0,3 px al trazarse por separado; el editor exige confirmación explícita para exportar y se confirmó solo en esta pila de prueba. **No se resuelve en esta tarjeta** (necesita contornos que compartan borde exacto) y no se certifica «sin piezas flotantes».
* La validación raster-vector que ya existía (`rasterValidation`, advertir sin bloquear) marca **fuera de tolerancia de contaminación (1 %)** las 5 capas de familia (1,1–3,8 % del área de cada capa; 0,2–0,5 px de profundidad media) y dentro de tolerancia el desajuste propio (1,2–5,4 % < 15 %). La tolerancia relativa vigente no se modificó; el presupuesto de esta tarjeta (px de contorno) sí se cumple.

## Límites conocidos (no se aprueban como resueltos)

* **Fondo ambiguo**: un blanco de primer plano que se funde con el fondo sin borde distinguible (el brillo superior del ojo derecho del pato) queda dentro del fondo; no se detecta como cuello ni se «reconstruye»: el sistema solo avisa con `needsReview` (el pato lo activa: ≈3,4 % del lienzo de claros en contacto con el fondo). El usuario ve el área de fondo y su máscara y puede incluirla como capa.
* Los anillos/halos de antialiasing se reparten entre vecinos; una línea de ≤ 4 px entre dos colores cuyo brillo cae entre ambos se considera transición.
* Los umbrales son heurísticos de luminosidad/croma/tono, validados con el pato y con casos sintéticos (rojos que cruzan 0°/360°, pasteles, grises, negro/blanco, tonos cercanos intencionales, más y menos de cinco colores); no se probó con fotografías.
* **NO VERIFICADO**: importación real en LightBurn (CA-14: requiere la aplicación de escritorio; los archivos reales SVG/DXF quedaron generados y verificados por contenido, no abiertos en LightBurn). El E2E de navegador cubrió abrir el documento guardado → exportar SVG/DXF, y por separado subir → paleta; no se automatizó un único recorrido continuo subida → paleta → capas → editor en una sola sesión de navegador (el tramo capas → guardado → reapertura se verificó por HTTP).

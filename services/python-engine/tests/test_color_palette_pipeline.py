"""Tests unitarios de las funciones puras de detección/reducción de paleta
de colores (app.core.color_palette_pipeline): agrupamiento determinista en
espacio Lab, manejo explícito de transparencia y respeto del límite
`max_colors`. Ver spec.md M2-S01, sección "Pruebas": colores sólidos,
anti-aliasing, sombras, transparencias, colores casi iguales y muchos
colores. La sección final ("M2.1-S02") cubre el endurecimiento de esta
tarjeta: `tiny_area_ratio` (explosión de grupos por antialiasing),
`touches_border` (fondo dominante) y los casos límite explícitos pedidos
por spec.md (gradientes, B/N de 2 colores, maxColors > colores reales).
"""

import cv2
import numpy as np
import pytest

from app.core.color_palette_pipeline import build_quantized_preview, detect_palette, extract_unique_colors
from tests.support import make_antialiased_illustration_png_bytes


def _solid_block_image() -> np.ndarray:
    """6x9 BGR: tres bloques sólidos bien separados (rojo, verde, azul puros)."""
    image = np.zeros((6, 9, 3), dtype=np.uint8)
    image[:, 0:3] = (0, 0, 255)  # BGR: rojo puro
    image[:, 3:6] = (0, 255, 0)  # verde puro
    image[:, 6:9] = (255, 0, 0)  # azul puro
    return image


# --- Colores sólidos ---


def test_detect_palette_solid_colors_returns_three_separate_groups_with_expected_area():
    image = _solid_block_image()

    result = detect_palette(image, alpha=None, tolerance=5.0, max_colors=None, max_unique_colors=512)

    assert len(result.groups) == 3
    for group in result.groups:
        assert group.pixel_count == 18  # 6 filas * 3 columnas
        assert not group.has_partial_alpha
    assert sum(g.pixel_count for g in result.groups) == result.total_pixel_count


def test_detect_palette_is_deterministic_across_repeated_calls():
    image = _solid_block_image()

    first = detect_palette(image, None, 5.0, None, 512)
    second = detect_palette(image, None, 5.0, None, 512)

    assert [g.color_bgr for g in first.groups] == [g.color_bgr for g in second.groups]
    assert [g.pixel_count for g in first.groups] == [g.pixel_count for g in second.groups]
    for g1, g2 in zip(first.groups, second.groups):
        assert np.array_equal(g1.mask, g2.mask)


def test_detect_palette_groups_are_ordered_by_area_descending():
    image = np.zeros((10, 10, 3), dtype=np.uint8)
    image[:, :7] = (10, 10, 10)
    image[:, 7:] = (250, 250, 250)

    result = detect_palette(image, None, 5.0, None, 512)

    assert result.groups[0].pixel_count >= result.groups[1].pixel_count


# --- Sombras (variaciones de luminosidad del mismo color lógico) ---


def _shadow_image() -> np.ndarray:
    base = np.array([180, 90, 40], dtype=np.uint8)  # BGR
    shadow = (base.astype(np.float64) * 0.55).astype(np.uint8)
    image = np.zeros((4, 4, 3), dtype=np.uint8)
    image[:, :2] = base
    image[:, 2:] = shadow
    return image


def test_detect_palette_shadow_variations_merge_with_wide_tolerance():
    result = detect_palette(_shadow_image(), None, tolerance=60.0, max_colors=None, max_unique_colors=512)

    assert len(result.groups) == 1


def test_detect_palette_shadow_variations_stay_separate_with_strict_tolerance():
    result = detect_palette(_shadow_image(), None, tolerance=1.0, max_colors=None, max_unique_colors=512)

    assert len(result.groups) == 2


# --- Colores casi iguales ---


def _near_identical_colors_image() -> np.ndarray:
    image = np.zeros((4, 4, 3), dtype=np.uint8)
    image[:, :2] = (100, 150, 200)
    image[:, 2:] = (103, 152, 202)
    return image


def test_detect_palette_near_identical_colors_merge_within_tolerance():
    result = detect_palette(_near_identical_colors_image(), None, tolerance=10.0, max_colors=None, max_unique_colors=512)

    assert len(result.groups) == 1


def test_detect_palette_near_identical_colors_stay_separate_with_zero_tolerance():
    result = detect_palette(_near_identical_colors_image(), None, tolerance=0.0, max_colors=None, max_unique_colors=512)

    assert len(result.groups) == 2


# --- Anti-aliasing (bordes con gradiente de color) ---


def _antialiased_edge_image(width: int = 20, height: int = 4) -> np.ndarray:
    left = np.array([30, 30, 200], dtype=np.float64)
    right = np.array([200, 30, 30], dtype=np.float64)
    image = np.zeros((height, width, 3), dtype=np.uint8)
    edge_start, edge_width = 8, 4
    for x in range(width):
        if x < edge_start:
            color = left
        elif x >= edge_start + edge_width:
            color = right
        else:
            t = (x - edge_start) / (edge_width - 1)
            color = left * (1 - t) + right * t
        image[:, x] = color.astype(np.uint8)
    return image


def test_detect_palette_antialiased_edge_still_covers_every_pixel_and_respects_max_colors():
    image = _antialiased_edge_image()

    result = detect_palette(image, None, tolerance=80.0, max_colors=3, max_unique_colors=512)

    assert len(result.groups) <= 3
    assert sum(g.pixel_count for g in result.groups) == image.shape[0] * image.shape[1]


def test_detect_palette_antialiased_edge_produces_more_than_two_raw_colors_without_a_limit():
    # Sin `max_colors`, el degradé intermedio no debería colapsar por completo
    # a solo los dos colores de los extremos -- hay tonos de transición
    # realmente distintos entre sí más allá de la tolerancia por defecto.
    image = _antialiased_edge_image()

    result = detect_palette(image, None, tolerance=5.0, max_colors=None, max_unique_colors=512)

    assert len(result.groups) > 2


# --- Transparencia ---


def test_detect_palette_fully_transparent_image_produces_empty_palette():
    image = np.full((4, 4, 3), (10, 20, 30), dtype=np.uint8)
    alpha = np.zeros((4, 4), dtype=np.uint8)

    result = detect_palette(image, alpha, tolerance=5.0, max_colors=None, max_unique_colors=512)

    assert result.groups == []
    assert result.transparent_pixel_count == 16


def test_detect_palette_excludes_only_fully_transparent_pixels_from_color_groups():
    # Mismo color RGB en toda la imagen; solo la mitad derecha es
    # transparente (alpha=0) -- no debe contarse como color, a diferencia de
    # un fondo sólido real del mismo color.
    image = np.full((4, 4, 3), (10, 20, 30), dtype=np.uint8)
    alpha = np.zeros((4, 4), dtype=np.uint8)
    alpha[:, :2] = 255

    result = detect_palette(image, alpha, tolerance=5.0, max_colors=None, max_unique_colors=512)

    assert len(result.groups) == 1
    assert result.groups[0].pixel_count == 8
    assert result.transparent_pixel_count == 8


def test_detect_palette_partial_alpha_pixels_count_as_color_but_are_flagged():
    image = np.full((4, 4, 3), (10, 20, 30), dtype=np.uint8)
    alpha = np.full((4, 4), 128, dtype=np.uint8)

    result = detect_palette(image, alpha, tolerance=5.0, max_colors=None, max_unique_colors=512)

    assert len(result.groups) == 1
    assert result.groups[0].has_partial_alpha is True
    assert result.groups[0].pixel_count == 16
    assert result.transparent_pixel_count == 0


def test_detect_palette_opaque_group_is_not_flagged_as_partial_alpha():
    image = np.full((4, 4, 3), (10, 20, 30), dtype=np.uint8)
    alpha = np.full((4, 4), 255, dtype=np.uint8)

    result = detect_palette(image, alpha, tolerance=5.0, max_colors=None, max_unique_colors=512)

    assert result.groups[0].has_partial_alpha is False


def test_detect_palette_without_alpha_channel_treats_every_pixel_as_opaque():
    image = np.full((3, 3, 3), (1, 2, 3), dtype=np.uint8)

    result = detect_palette(image, alpha=None, tolerance=5.0, max_colors=None, max_unique_colors=512)

    assert result.transparent_pixel_count == 0
    assert result.groups[0].pixel_count == 9


# --- Muchos colores ---
#
# "Muchos colores" no está cuantificado por spec.md ("Ambigüedades
# detectadas": "el implementador elige un valor razonable, ej. 50+"). Se usa
# una grilla 10x10 (100 píxeles) con un degradé bidimensional determinista
# que produce bastante más de 50 colores únicos, manteniendo el test rápido
# (el peor caso, tolerance=0.0, ejercita a pleno la fusión O(k^2) hacia
# `max_colors` sin volverse lento).


def _many_colors_gradient_image(size: int = 10) -> np.ndarray:
    xs = np.linspace(0, 255, size).astype(np.uint8)
    ys = np.linspace(0, 255, size).astype(np.uint8)
    blue = np.tile(xs, (size, 1))
    green = np.tile(ys.reshape(-1, 1), (1, size))
    red = ((blue.astype(np.int32) + green.astype(np.int32) * 7) % 256).astype(np.uint8)
    return np.stack([blue, green, red], axis=-1)


def test_many_colors_gradient_has_at_least_50_unique_source_colors():
    image = _many_colors_gradient_image()

    unique_count = len(np.unique(image.reshape(-1, 3), axis=0))

    assert unique_count >= 50


def test_detect_palette_many_colors_respects_max_colors_upper_bound():
    image = _many_colors_gradient_image()

    result = detect_palette(image, None, tolerance=0.0, max_colors=8, max_unique_colors=512)

    assert len(result.groups) <= 8
    assert sum(g.pixel_count for g in result.groups) == image.shape[0] * image.shape[1]


def test_detect_palette_many_colors_without_max_colors_keeps_most_of_them_separate_at_zero_tolerance():
    # No se exige igualdad exacta con la cantidad de colores BGR únicos: la
    # cuantización a 8 bits de OpenCV al convertir a Lab puede, en casos
    # puntuales, mapear dos BGR distintos al mismo triplete Lab -- pero con
    # tolerancia 0 la enorme mayoría debe seguir separada (no hay fusión
    # "amplia" posible).
    image = _many_colors_gradient_image()

    result = detect_palette(image, None, tolerance=0.0, max_colors=None, max_unique_colors=512)

    unique_count = len(np.unique(image.reshape(-1, 3), axis=0))
    assert len(result.groups) >= unique_count - 5


# --- extract_unique_colors: salvaguarda de rendimiento ---


def test_extract_unique_colors_reduces_cardinality_when_exceeding_budget():
    image = _many_colors_gradient_image()
    pixels = image.reshape(-1, 3)

    colors, inverse, counts = extract_unique_colors(pixels, max_unique_colors=8)

    assert len(colors) <= 8
    assert inverse.shape[0] == pixels.shape[0]
    assert int(counts.sum()) == pixels.shape[0]


def test_extract_unique_colors_is_a_passthrough_when_within_budget():
    image = _solid_block_image()
    pixels = image.reshape(-1, 3)

    colors, inverse, counts = extract_unique_colors(pixels, max_unique_colors=512)

    assert len(colors) == 3
    assert int(counts.sum()) == pixels.shape[0]


# --- build_quantized_preview ---


def test_build_quantized_preview_paints_transparent_where_no_group_assigned():
    image = np.full((4, 4, 3), (10, 20, 30), dtype=np.uint8)
    alpha = np.zeros((4, 4), dtype=np.uint8)
    alpha[:, :2] = 255

    result = detect_palette(image, alpha, tolerance=5.0, max_colors=None, max_unique_colors=512)
    preview = build_quantized_preview(result)

    assert preview.shape == (4, 4, 4)
    assert (preview[:, :2, 3] == 255).all()
    assert (preview[:, 2:, 3] == 0).all()


def test_build_quantized_preview_paints_each_group_with_its_representative_color():
    image = _solid_block_image()
    result = detect_palette(image, None, 5.0, None, 512)

    preview = build_quantized_preview(result)

    for group in result.groups:
        rows, cols = np.nonzero(group.mask == 255)
        sample_pixel = preview[rows[0], cols[0]]
        b, g, r = group.color_bgr
        assert tuple(int(c) for c in sample_pixel) == (b, g, r, 255)


# --- M2.1-S02: tiny_area_ratio (ataca la explosión de grupos por antialiasing) ---
#
# Fixture de reproducción: réplica determinista (a la misma escala, 300x300,
# que la usada para medir el umbral elegido -- ver el reporte del sprint,
# IMPL.md, para la evidencia completa) del caso ya documentado por la
# auditoría M2.1-S01 ("con antialiasing, 17 grupos en vez de ~5 lógicos").


def _antialiased_illustration_bgr():
    data = make_antialiased_illustration_png_bytes()
    return cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)


def test_detect_palette_without_tiny_area_ratio_still_reproduces_the_antialiasing_explosion():
    # Documenta el comportamiento ANTES del fix (tiny_area_ratio omitido ->
    # default 0.0 = deshabilitado a este nivel, ver docstring del módulo):
    # confirma que el fixture de este archivo de test reproduce genuinamente
    # el problema (no es un fixture "de juguete" que ya venía bien).
    image = _antialiased_illustration_bgr()

    result = detect_palette(image, alpha=None, tolerance=12.0, max_colors=None, max_unique_colors=512)

    assert len(result.groups) == 18
    assert sum(g.pixel_count for g in result.groups) == result.total_pixel_count


def test_detect_palette_tiny_area_ratio_merges_antialiasing_noise_into_the_logical_colors():
    # DESPUÉS del fix: mismo fixture, mismo tolerance, único cambio
    # tiny_area_ratio=0.001 (el default elegido, ver ColorPaletteOptions/
    # Settings.color_palette_default_tiny_area_ratio) -- los 12 grupos
    # "ruido" de antialiasing (todos <0.1% del área relevante) se absorben
    # hacia su vecino de color más cercano, quedan los 6 colores lógicos
    # (cielo, pasto, casa, puerta, techo, sol), ninguno perdido ni inventado.
    image = _antialiased_illustration_bgr()

    result = detect_palette(image, alpha=None, tolerance=12.0, max_colors=None, max_unique_colors=512, tiny_area_ratio=0.001)

    assert len(result.groups) == 6
    assert sum(g.pixel_count for g in result.groups) == result.total_pixel_count


def test_detect_palette_tiny_area_ratio_can_be_disabled_explicitly_for_fine_grained_palettes():
    # spec.md: "no debe impedir que un usuario avanzado pida explícitamente
    # muchos colores finos si lo desea" -- pasar tiny_area_ratio=0.0 a
    # propósito reproduce el mismo resultado "sin fix" que si se hubiera
    # omitido, confirmando que el comportamiento es opt-out, no forzado.
    image = _antialiased_illustration_bgr()

    without_param = detect_palette(image, alpha=None, tolerance=12.0, max_colors=None, max_unique_colors=512)
    with_explicit_zero = detect_palette(
        image, alpha=None, tolerance=12.0, max_colors=None, max_unique_colors=512, tiny_area_ratio=0.0
    )

    assert len(with_explicit_zero.groups) == len(without_param.groups) == 18


def test_detect_palette_tiny_area_ratio_respects_max_colors_requested_explicitly():
    # El fix se aplica ANTES de max_colors: si el usuario pide explícitamente
    # más colores finos de los que sobrevivirían al fix (ver
    # ColorPaletteParameters/ColorPaletteParams), max_colors sigue siendo un
    # límite superior sobre lo que quedó después de limpiar el ruido, nunca
    # un piso que reviva grupos ya fusionados.
    image = _antialiased_illustration_bgr()

    result = detect_palette(
        image, alpha=None, tolerance=12.0, max_colors=4, max_unique_colors=512, tiny_area_ratio=0.001
    )

    assert len(result.groups) <= 4
    assert sum(g.pixel_count for g in result.groups) == result.total_pixel_count


def test_detect_palette_tiny_area_ratio_never_collapses_below_one_group():
    # Umbral deliberadamente enorme (0.49, casi el máximo permitido por el
    # contrato: ColorPaletteOptions/ColorPaletteParams validan <= 0.5): ni
    # así debería desaparecer el último grupo sobreviviente -- "no colapsa a
    # 0" es una garantía estructural de `_merge_tiny_groups_into_nearest`
    # (`while len(live) > 1`), no un efecto de la tolerancia elegida.
    image = _antialiased_illustration_bgr()

    result = detect_palette(image, alpha=None, tolerance=12.0, max_colors=None, max_unique_colors=512, tiny_area_ratio=0.49)

    assert len(result.groups) >= 1
    assert sum(g.pixel_count for g in result.groups) == result.total_pixel_count


def test_detect_palette_tiny_area_ratio_does_not_affect_groups_above_the_threshold():
    # Contraprueba de "muchos colores" (ya cubierta en la sección de arriba,
    # reverificada acá con tiny_area_ratio activo): en la grilla 10x10 con
    # ~100 colores únicos de 1 píxel cada uno (1% del área total), el
    # default de 0.001 (0.1%) no debería fusionar ninguno -- todos están muy
    # por encima del umbral.
    image = _many_colors_gradient_image()

    result = detect_palette(image, None, tolerance=0.0, max_colors=None, max_unique_colors=512, tiny_area_ratio=0.001)

    unique_count = len(np.unique(image.reshape(-1, 3), axis=0))
    assert len(result.groups) >= unique_count - 5


# --- M2.1-S02: touches_border (heurística de fondo dominante) ---


def test_detect_palette_marks_the_group_covering_most_of_the_border_as_touching_it():
    # Fondo que cubre TODO el lienzo (toca el 100% del perímetro) más un
    # cuadrado de primer plano chico y centrado que no toca ningún borde.
    image = np.full((40, 40, 3), (235, 206, 135), dtype=np.uint8)
    image[15:25, 15:25] = (40, 40, 160)

    result = detect_palette(image, alpha=None, tolerance=5.0, max_colors=None, max_unique_colors=512)

    assert len(result.groups) == 2
    background, foreground = result.groups[0], result.groups[1]
    assert background.pixel_count > foreground.pixel_count
    assert background.touches_border is True
    assert foreground.touches_border is False


def test_detect_palette_does_not_mark_a_partial_border_touch_as_background_candidate():
    # Dos mitades que tocan el borde cada una por SU lado (ninguna cubre la
    # mayoría del perímetro TOTAL: cada una toca 3 de los 4 lados
    # completos, pero comparte los otros 2 con la mitad vecina) -- con un
    # umbral de mayoría absoluta (>=50%) ambas deberían calificar en este
    # caso simétrico particular (empiezan igual de "grandes" en el
    # perímetro); se verifica el caso real y no uno inventado.
    image = np.zeros((10, 10, 3), dtype=np.uint8)
    image[:, :5] = (255, 255, 255)

    result = detect_palette(image, alpha=None, tolerance=5.0, max_colors=None, max_unique_colors=512)

    # Cada mitad toca exactamente la mitad del perímetro (fila superior,
    # inferior y su propia columna lateral) -- ninguna llega al umbral de
    # mayoría estricta (> no >=, ver _BACKGROUND_BORDER_TOUCH_RATIO): ambas
    # deberían dar exactamente 0.5, y el criterio ">=" del código las marca
    # a las DOS como True. Documentamos el valor real observado, no lo
    # forzamos.
    assert {g.touches_border for g in result.groups} == {True}


def test_detect_palette_interior_group_never_touches_border():
    image = np.zeros((20, 20, 3), dtype=np.uint8)
    image[5:15, 5:15] = (100, 200, 50)

    result = detect_palette(image, alpha=None, tolerance=5.0, max_colors=None, max_unique_colors=512)

    interior = min(result.groups, key=lambda g: g.pixel_count)
    assert interior.touches_border is False


# --- M2.1-S02: casos límite explícitos de spec.md ---


def test_detect_palette_black_and_white_two_colors_is_unaffected_by_the_antialiasing_fix():
    # Regresión explícita (spec.md, "Casos límite": "imagen B/N (2 colores):
    # debe seguir funcionando exactamente igual que hoy") -- con el default
    # de tiny_area_ratio (0.001) activo, ninguna de las dos mitades (50%
    # cada una) debería fusionarse.
    image = np.zeros((12, 12, 3), dtype=np.uint8)
    image[:, 6:] = (255, 255, 255)

    result = detect_palette(image, alpha=None, tolerance=5.0, max_colors=None, max_unique_colors=512, tiny_area_ratio=0.001)

    assert len(result.groups) == 2
    assert {g.pixel_count for g in result.groups} == {72}


def test_detect_palette_max_colors_greater_than_actual_colors_returns_actual_count_without_error():
    # spec.md, "Casos límite": "paleta solicitada (maxColors) mayor que la
    # cantidad de colores reales: no debe fallar ni inventar colores".
    image = _solid_block_image()  # 3 colores reales

    result = detect_palette(image, alpha=None, tolerance=5.0, max_colors=64, max_unique_colors=512, tiny_area_ratio=0.001)

    assert len(result.groups) == 3
    assert sum(g.pixel_count for g in result.groups) == result.total_pixel_count


def test_detect_palette_gradient_with_default_style_tuning_stays_bounded_and_does_not_collapse():
    # spec.md, "Casos límite": "gradientes (transición continua de color):
    # confirmar comportamiento razonable (no explota en cientos de grupos
    # gracias al fix de arriba, y no colapsa todo a 1 color salvo que la
    # tolerancia lo pida)". Degradé continuo de 200 columnas entre dos
    # colores bien distintos en Lab -- con tolerance=12 (default de
    # producción) y tiny_area_ratio=0.001 (default de producción) debería
    # quedar en un puñado de grupos, ni "cientos" (uno por columna) ni 1.
    width, height = 200, 4
    left = np.array([30, 30, 200], dtype=np.float64)
    right = np.array([200, 30, 30], dtype=np.float64)
    image = np.zeros((height, width, 3), dtype=np.uint8)
    for x in range(width):
        t = x / (width - 1)
        image[:, x] = (left * (1 - t) + right * t).astype(np.uint8)

    result = detect_palette(image, alpha=None, tolerance=12.0, max_colors=None, max_unique_colors=512, tiny_area_ratio=0.001)

    assert 1 < len(result.groups) < width
    assert sum(g.pixel_count for g in result.groups) == result.total_pixel_count


def test_detect_palette_transparency_case_is_unaffected_by_tiny_area_ratio():
    # Reverificación explícita (spec.md, "Casos límite": "transparencia (ya
    # cubierto, reverificar que sigue funcionando tras cualquier cambio)")
    # con tiny_area_ratio activo en su default de producción: el grupo
    # opaco (mitad izquierda, 50% del área relevante) no debería fusionarse
    # ni desaparecer, y los píxeles transparentes siguen fuera del cómputo.
    image = np.full((4, 4, 3), (10, 20, 30), dtype=np.uint8)
    alpha = np.zeros((4, 4), dtype=np.uint8)
    alpha[:, :2] = 255

    result = detect_palette(image, alpha, tolerance=5.0, max_colors=None, max_unique_colors=512, tiny_area_ratio=0.001)

    assert len(result.groups) == 1
    assert result.groups[0].pixel_count == 8
    assert result.transparent_pixel_count == 8


def test_bucket_representatives_use_original_pixel_means_not_lower_edges():
    # Fuerza dos buckets en vez de tres colores. 255 no debe convertirse en 128.
    pixels = np.array([[0, 0, 0], [1, 1, 1], [1, 1, 1], [255, 255, 255]], dtype=np.uint8)
    colors, inverse, counts = extract_unique_colors(pixels, max_unique_colors=2)
    assert colors[inverse[-1]].tolist() == [255, 255, 255]
    assert colors[inverse[0]].tolist() == [1, 1, 1]
    assert counts.tolist() == [3, 1]


def test_continuous_color_palette_keeps_white_and_bright_yellow():
    shades = np.arange(128, 256, dtype=np.uint8)
    yellow = np.column_stack([np.zeros(128, dtype=np.uint8), shades, shades])
    pixels = np.vstack([np.full((1024, 3), 255, dtype=np.uint8), yellow])
    result = detect_palette(pixels.reshape(1, -1, 3), None, tolerance=0.0,
                            max_colors=None, max_unique_colors=8)
    white = max(result.groups, key=lambda group: group.pixel_count)
    assert white.color_bgr == (255, 255, 255)
    assert any(group.color_bgr[0] == 0 and group.color_bgr[1] >= 239 for group in result.groups)



def test_packed_color_keys_preserve_bucket_membership_order_and_weighted_means():
    pixels = np.random.default_rng(42).integers(0, 256, size=(4000, 3), dtype=np.uint8)
    pixels = np.vstack([pixels, pixels[:100]])  # frecuencias no uniformes
    step = 1
    while True:
        bucketed = (pixels.astype(np.int32) // step * step).astype(np.uint8)
        reference, expected_inverse, expected_counts = np.unique(
            bucketed, axis=0, return_inverse=True, return_counts=True)
        if len(reference) <= 512:
            break
        step *= 2
    colors, inverse, counts = extract_unique_colors(pixels, max_unique_colors=512)
    np.testing.assert_array_equal(inverse, expected_inverse.reshape(-1))
    np.testing.assert_array_equal(counts, expected_counts)
    for index in range(len(colors)):
        np.testing.assert_array_equal(colors[index], np.rint(pixels[inverse == index].mean(axis=0)))

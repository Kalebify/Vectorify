"""Tests unitarios de la agrupación en familias de color base
(app.core.color_palette_pipeline.detect_base_color_palette): fusiona luces y
sombras de una misma familia ANTES de vectorizar, separa el fondo del color y
conserva exacta la cobertura raster. Ver .sprint/405d77b2-.../spec.md
(CA-02..CA-06, CA-09).

Las imágenes se construyen en Lab (L, C, h) para controlar el tono con
precisión (incluido el cruce circular de 360° a 0°) sin depender de ningún
personaje concreto.
"""

import cv2
import numpy as np
import pytest

from app.core.color_palette_pipeline import detect_base_color_palette, detect_palette
from tests.support import WHITE, blank, lch_to_bgr, paint_ellipse, paint_rect, shaded_character

def detect(image, alpha=None, *, tolerance=8.0, target=None, strength=0.5, tiny=0.0):
    return detect_base_color_palette(
        image, alpha, tolerance=tolerance, max_unique_colors=512, tiny_area_ratio=tiny,
        target_families=target, grouping_strength=strength,
    )


def families(result):
    return [g for g in result.groups if not g.is_background]


def group_index_at(result, x, y) -> int:
    hits = [i for i, g in enumerate(result.groups) if g.mask[y, x] == 255]
    assert len(hits) <= 1, "un píxel nunca puede pertenecer a dos grupos"
    return hits[0] if hits else -1


# --- CA-02 / CA-03: una capa por familia, sin mezclar sombras de ojos con naranja ---


def test_shades_of_each_color_collapse_into_one_family_each():
    result = detect(shaded_character())

    # yellow, orange, green, light-neutral (ojo) y black (pupila) -> 5 familias (fondo aparte)
    assert len(families(result)) == 5
    yellow = {group_index_at(result, 110, 95), group_index_at(result, 110, 150 + 60), group_index_at(result, 70, 200)}
    assert len(yellow) == 1 and -1 not in yellow, "luz, medio y sombra del amarillo comparten familia"
    green = {group_index_at(result, 100, 30), group_index_at(result, 100, 70)}
    assert len(green) == 1
    pico = {group_index_at(result, 190, 110), group_index_at(result, 190, 128)}
    pie = {group_index_at(result, 60, 270), group_index_at(result, 60, 290)}
    assert len(pico | pie) == 1, "pico y pie (dos piezas separadas) son UNA capa naranja"
    assert -1 not in pico | pie


def test_eye_shadows_stay_neutral_and_never_join_orange():
    result = detect(shaded_character())

    orange = group_index_at(result, 190, 110)
    eye_white = group_index_at(result, 110, 160)
    eye_shadow = group_index_at(result, 110, 175)
    warm_gray_shadow = group_index_at(result, 80, 162)
    pupil = group_index_at(result, 110, 140)

    assert eye_white == eye_shadow == warm_gray_shadow != orange
    assert pupil not in {orange, eye_white}
    pupil_group = result.groups[pupil]
    assert pupil_group.color_bgr[0] < 30 and pupil_group.color_bgr[1] < 30 and pupil_group.color_bgr[2] < 30


def test_family_color_is_the_real_mean_of_its_pixels():
    image = shaded_character()
    result = detect(image)

    for group in families(result):
        mean = cv2.mean(image, mask=group.mask)[:3]
        assert np.allclose(group.color_bgr, np.rint(mean), atol=1.0)


def test_family_piece_count_counts_disconnected_regions():
    result = detect(shaded_character())
    orange = result.groups[group_index_at(result, 190, 110)]

    assert orange.piece_count == 2
    assert orange.source_group_count >= 2


# --- CA-05: cobertura raster exacta ---


def test_masks_partition_every_opaque_pixel_exactly_once():
    image = shaded_character()
    result = detect(image)

    stack = np.stack([g.mask == 255 for g in result.groups])
    assert int(stack.sum(axis=0).max()) == 1, "sin píxeles compartidos"
    assert int((stack.sum(axis=0) == 0).sum()) == 0, "sin píxeles sin asignar"
    assert sum(g.pixel_count for g in result.groups) == image.shape[0] * image.shape[1]
    for group in result.groups:
        assert group.pixel_count == int(np.count_nonzero(group.mask))


def test_transparent_pixels_are_excluded_from_every_family_and_partial_alpha_is_kept():
    image = shaded_character()
    alpha = np.full(image.shape[:2], 255, dtype=np.uint8)
    alpha[:, :10] = 0
    alpha[100:110, 100:110] = 128

    result = detect(image, alpha)

    union = np.maximum.reduce([g.mask for g in result.groups])
    assert not np.any(union[:, :10] == 255)
    assert result.transparent_pixel_count == 10 * image.shape[0]
    assert any(g.has_partial_alpha for g in result.groups)
    assert np.count_nonzero(union) == image.shape[0] * image.shape[1] - 10 * image.shape[0]


# --- CA-09: determinismo ---


def test_detection_is_deterministic():
    image = shaded_character()

    first = detect(image)
    second = detect(image)

    assert [g.color_bgr for g in first.groups] == [g.color_bgr for g in second.groups]
    assert [g.pixel_count for g in first.groups] == [g.pixel_count for g in second.groups]
    for a, b in zip(first.groups, second.groups):
        assert np.array_equal(a.mask, b.mask)


def test_families_are_presented_by_area_descending_with_background_last():
    result = detect(shaded_character())

    counts = [g.pixel_count for g in families(result)]
    assert counts == sorted(counts, reverse=True)
    assert result.groups[-1].is_background


# --- CA-04: generalización y control ---


def test_hue_is_circular_reds_on_both_sides_of_zero_degrees_merge():
    image = blank(60, 120)
    paint_rect(image, 5, 55, 5, 40, lch_to_bgr(50, 60, 352))   # rojo-magenta, h -8
    paint_rect(image, 5, 55, 45, 80, lch_to_bgr(48, 62, 4))    # rojo, h +4
    paint_rect(image, 5, 55, 85, 115, lch_to_bgr(52, 58, 12))  # rojo-naranja, h +12

    result = detect(image, tolerance=3.0)

    assert len(families(result)) == 1


def test_strength_zero_keeps_intentionally_close_tones_apart_and_high_strength_merges_them():
    image = blank(60, 100)
    paint_rect(image, 5, 55, 5, 45, lch_to_bgr(55, 60, 60))
    paint_rect(image, 5, 55, 55, 95, lch_to_bgr(55, 60, 80))  # 20° de tono

    assert len(families(detect(image, tolerance=3.0, strength=0.0))) == 2
    assert len(families(detect(image, tolerance=3.0, strength=1.0))) == 1


def test_pastel_and_saturated_of_same_hue_are_not_forced_together_at_low_strength():
    image = blank(60, 100)
    paint_rect(image, 5, 55, 5, 45, lch_to_bgr(55, 70, 20))   # rojo saturado
    paint_rect(image, 5, 55, 55, 95, lch_to_bgr(88, 14, 20))  # pastel rosado (misma tinta)

    assert len(families(detect(image, tolerance=3.0, strength=0.1))) == 2


def test_black_white_and_grays_form_neutral_families_without_inventing_color():
    image = blank(60, 120)
    paint_rect(image, 5, 55, 5, 40, (2, 2, 2))
    paint_rect(image, 5, 55, 45, 80, lch_to_bgr(55, 0, 0))
    paint_rect(image, 5, 55, 85, 115, lch_to_bgr(70, 0, 0))

    result = detect(image, tolerance=3.0)

    fams = families(result)
    assert len(fams) == 2, "negro y gris(es) claros: dos familias neutras"
    for group in fams:
        b, g, r = group.color_bgr
        assert max(b, g, r) - min(b, g, r) <= 6


def test_target_families_is_an_upper_bound_not_a_quota():
    image = shaded_character()

    assert len(families(detect(image, target=3))) == 3
    assert len(families(detect(image, target=10))) == 5
    assert len(families(detect(image, target=1))) == 1


def test_target_families_keeps_exact_partition_after_forced_merges():
    image = shaded_character()
    result = detect(image, target=2)

    stack = np.stack([g.mask == 255 for g in result.groups])
    assert int(stack.sum(axis=0).max()) == 1 and int(stack.sum(axis=0).min()) == 1


def test_single_flat_color_is_one_family_and_no_background_when_it_fills_the_canvas():
    image = np.full((40, 40, 3), lch_to_bgr(50, 60, 50), dtype=np.uint8)

    result = detect(image)

    assert len(result.groups) == 1 and not result.groups[0].is_background
    assert result.background is None


def test_fully_transparent_image_has_no_groups():
    image = blank(10, 10)
    alpha = np.zeros((10, 10), dtype=np.uint8)

    result = detect(image, alpha)

    assert result.groups == [] and result.background is None


def test_detailed_detection_is_unchanged_by_the_new_style_code():
    image = shaded_character()

    old = detect_palette(image, None, 8.0, None, 512, tiny_area_ratio=0.0)

    assert len(old.groups) > 5, "el estilo detallado sigue conservando cada tono"
    assert all(not g.is_background for g in old.groups)


# --- CA-06: fondo independiente del color ---


def test_background_is_its_own_group_and_does_not_count_as_a_family():
    result = detect(shaded_character())

    backgrounds = [g for g in result.groups if g.is_background]
    assert len(backgrounds) == 1
    assert result.background is not None
    assert result.background.pixel_count == backgrounds[0].pixel_count
    assert backgrounds[0].touches_border
    assert backgrounds[0].mask[0, 0] == 255


def test_enclosed_white_hole_is_not_background_and_stays_in_the_light_family():
    image = blank(120, 120)
    paint_rect(image, 20, 100, 20, 100, lch_to_bgr(60, 60, 50))
    paint_rect(image, 45, 75, 45, 75, WHITE)  # hueco blanco interior: NO conectado al borde

    result = detect(image)

    background = next(g for g in result.groups if g.is_background)
    assert background.mask[60, 60] == 0, "el blanco interior no es fondo"
    owner = group_index_at(result, 60, 60)
    assert owner != -1 and not result.groups[owner].is_background
    assert background.mask[5, 5] == 255


def test_white_inside_figure_is_kept_even_if_it_has_the_exact_background_color():
    image = shaded_character()
    # el ojo del personaje es claro pero está rodeado por el cuerpo: sigue siendo familia
    result = detect(image)

    eye_owner = result.groups[group_index_at(result, 110, 160)]
    assert not eye_owner.is_background


def test_white_touching_background_through_a_thin_neck_is_kept_and_flagged_not_deleted_silently():
    image = blank(160, 160)
    paint_ellipse(image, 80, 80, 60, 60, lch_to_bgr(55, 60, 50))
    paint_ellipse(image, 80, 80, 28, 28, WHITE)            # bolsa blanca interior
    image[78:82, 80:150] = WHITE                           # cuello blanco de 4 px hasta el fondo

    result = detect(image)

    assert result.background is not None
    assert result.background.ambiguous_pixel_count > 0
    assert result.background.needs_review is True
    background = next(g for g in result.groups if g.is_background)
    assert background.mask[80, 80] == 0, "la bolsa ambigua NO se borra: se conserva para revisión"
    assert group_index_at(result, 80, 80) != -1


def test_light_object_in_contact_with_background_requests_review():
    image = blank(100, 100)
    paint_rect(image, 20, 80, 20, 80, lch_to_bgr(60, 60, 50))
    paint_rect(image, 30, 70, 70, 100, lch_to_bgr(93, 4, 60))  # objeto claro pegado al fondo claro

    result = detect(image, tolerance=6.0)

    assert result.background is not None and result.background.needs_review is True
    assert result.background.contact_pixel_count > 0


def test_clean_background_does_not_request_review():
    result = detect(shaded_character())

    assert result.background is not None
    assert result.background.ambiguous_pixel_count == 0
    assert result.background.needs_review is False


def test_background_requires_most_of_the_perimeter():
    image = np.full((60, 60, 3), lch_to_bgr(60, 60, 50), dtype=np.uint8)
    paint_rect(image, 0, 60, 0, 20, WHITE)  # un tercio del perímetro cada color:
    paint_rect(image, 0, 60, 40, 60, lch_to_bgr(40, 50, 270))  # ninguno llega al 50 %

    result = detect(image)

    assert result.background is None
    assert not any(g.is_background for g in result.groups)


def test_background_is_detected_for_any_background_color():
    for bg in ((255, 255, 255), (40, 40, 40), lch_to_bgr(70, 40, 250)):
        image = shaded_character()
        image[(image == np.array(WHITE, dtype=np.uint8)).all(axis=2)] = bg

        result = detect(image)

        assert any(g.is_background for g in result.groups), bg


def test_alpha_zero_background_is_never_a_color_background():
    image = shaded_character()
    alpha = np.full(image.shape[:2], 255, dtype=np.uint8)
    white = (image == np.array(WHITE, dtype=np.uint8)).all(axis=2)
    alpha[white] = 0

    result = detect(image, alpha)

    assert result.background is None
    assert len(families(result)) == 5
    assert result.transparent_pixel_count == int(white.sum())


# --- Píxeles de transición (antialiasing) ---


def test_antialiasing_ring_between_pupil_and_eye_does_not_become_a_colored_outline():
    image = blank(200, 200)
    paint_rect(image, 10, 190, 10, 100, lch_to_bgr(60, 70, 50))             # naranja (otra pieza)
    paint_rect(image, 10, 190, 100, 190, lch_to_bgr(80, 3, 60))             # ojo gris claro
    paint_ellipse(image, 145, 100, 24, 36, lch_to_bgr(16, 30, 48))          # anillo marrón cálido (L entre negro y gris)
    paint_ellipse(image, 145, 100, 22, 34, lch_to_bgr(1, 0, 0))             # pupila negra

    result = detect(image, tolerance=6.0)

    orange = result.groups[group_index_at(result, 50, 100)]
    assert int(np.count_nonzero(orange.mask[:, 100:])) == 0, "el anillo no se queda como contorno naranja"
    ring_owner = group_index_at(result, 145, 100 - 35)
    assert ring_owner != -1 and result.groups[ring_owner] is not orange


def test_thin_dark_outline_between_two_light_colors_is_kept():
    image = blank(100, 120)
    paint_rect(image, 10, 90, 10, 58, lch_to_bgr(75, 70, 95))     # amarillo
    paint_rect(image, 10, 90, 62, 110, lch_to_bgr(50, 50, 148))   # verde
    paint_rect(image, 10, 90, 58, 62, lch_to_bgr(6, 0, 0))        # contorno negro de 4 px: NO es transición

    result = detect(image, tolerance=6.0)

    black = result.groups[group_index_at(result, 60, 50)]
    assert black.pixel_count == 4 * 80
    assert black.color_bgr[0] < 30


def test_thin_line_over_a_flat_background_is_never_touched():
    image = blank(100, 100)
    paint_rect(image, 48, 51, 10, 90, lch_to_bgr(55, 60, 30))  # línea de 3 px sobre fondo liso

    result = detect(image, tolerance=6.0)

    line = result.groups[group_index_at(result, 50, 49)]
    assert not line.is_background and line.pixel_count == 3 * 80


# --- CA-04: más y menos de cinco colores / CA-07: agujeros y piezas ---


def test_more_than_five_distinct_colors_are_not_forced_into_five_families():
    image = blank(60, 440)
    for index, hue in enumerate((20, 60, 100, 150, 200, 250, 300, 340)):  # 8 tonos bien separados
        paint_rect(image, 5, 55, 5 + index * 53, 5 + index * 53 + 45, lch_to_bgr(60, 60, hue))

    result = detect(image, tolerance=3.0)

    assert len(families(result)) == 8


def test_two_color_image_gives_two_families_even_when_five_are_requested():
    image = blank(60, 100)
    paint_rect(image, 5, 55, 5, 45, lch_to_bgr(55, 60, 30))
    paint_rect(image, 5, 55, 55, 95, lch_to_bgr(55, 60, 200))

    result = detect(image, tolerance=3.0, target=5)

    assert len(families(result)) == 2


def test_a_family_keeps_the_holes_of_its_shape_and_counts_one_piece():
    image = blank(100, 100)
    paint_rect(image, 10, 90, 10, 90, lch_to_bgr(55, 60, 40))   # anillo naranja...
    paint_rect(image, 35, 65, 35, 65, lch_to_bgr(80, 70, 95))   # ...con un hueco ocupado por otra familia

    result = detect(image, tolerance=6.0)

    ring = result.groups[group_index_at(result, 15, 15)]
    assert ring.mask[50, 50] == 0, "el hueco no pertenece a la familia del anillo"
    assert ring.piece_count == 1
    assert ring.pixel_count == 80 * 80 - 30 * 30


def test_family_union_keeps_separate_pieces_in_one_group_without_bridging_them():
    image = blank(60, 140)
    paint_rect(image, 5, 55, 5, 40, lch_to_bgr(55, 60, 40))
    paint_rect(image, 5, 55, 100, 135, lch_to_bgr(45, 55, 42))  # misma familia, pieza separada y otra sombra

    result = detect(image, tolerance=6.0)

    assert len(families(result)) == 1
    family = families(result)[0]
    assert family.piece_count == 2
    assert family.mask[30, 70] == 0, "el hueco entre las piezas no se rellena"
    assert family.pixel_count == 2 * 35 * 50

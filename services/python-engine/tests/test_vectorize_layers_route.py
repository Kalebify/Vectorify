"""Tests de integración de POST /api/v1/vectorize-layers (M2-S02) vía
TestClient: una capa vectorial POR CADA máscara de color recibida, cada una
vectorizada de forma INDEPENDIENTE reutilizando VectorizationService.process
(mismo motor/pipeline que M1-S05, sin reinventar el trazado de contornos), en
una única request .NET -> Python (ver spec.md, "Ambigüedades detectadas").
Casos de prueba obligatorios de spec.md M2-S02 ("Pruebas"): capas solapadas,
no solapadas, agujeros, transparencia (origen en zonas con alpha parcial) y
alineación pixel->vector con una tolerancia documentada.
"""

import json

import pytest

from app.core.config import get_settings
from tests.support import (
    NOT_AN_IMAGE,
    make_adjacent_masks_png_bytes,
    make_mask_png_bytes,
    make_positioned_square_mask_png_bytes,
    make_quadrant_mask_png_bytes,
    make_ring_mask_png_bytes,
    make_sparse_mask_png_bytes,
    make_square_mask_png_bytes,
)

VECTORIZE_LAYERS_URL = "/api/v1/vectorize-layers"

# Tolerancia de alineación pixel->vector: 1px absoluto sobre el bounding box
# del path resultante -- ver spec.md M2-S02, "Ambigüedades detectadas": "el
# implementador elige un valor razonable (ej. sub-píxel o 1px) y lo
# documenta, consistente con las tolerancias ya usadas en M1-S08". VTracer
# con mode="polygon" traza el contorno exacto de los píxeles blancos sin
# antialiasing/suavizado, así que 1px absoluto ya es una tolerancia holgada
# (el error esperado en el caso normal es 0) frente a las tolerancias
# RELATIVAS (fracción de diagonal) de CheckParams en M1-S08 -- acá se usa un
# valor absoluto en vez de relativo porque la comparación es contra
# coordenadas de píxel conocidas de antemano, no contra otro subpath.
ALIGNMENT_TOLERANCE_PX = 1.0


def _post_vectorize_layers(client, masks: list[bytes], group_ids: list[str]):
    files = [("files", (f"mask-{index}.png", data, "image/png")) for index, data in enumerate(masks)]
    return client.post(VECTORIZE_LAYERS_URL, files=files, data={"group_ids": json.dumps(group_ids)})


def test_vectorize_layers_returns_one_layer_per_mask_matching_group_ids(client):
    # Mismo tamaño de lienzo para ambas máscaras -- invariante real de M2-S02
    # ("Ninguna máscara se recorta a su bounding box: todas comparten las
    # dimensiones de la imagen original") del que depende la validación
    # raster-vs-vector de M2.1-S03 (compara cada capa contra la UNIÓN de las
    # demás máscaras recibidas, que deben tener las mismas dimensiones).
    masks = [make_square_mask_png_bytes(size=60, square=30), make_ring_mask_png_bytes(size=60, outer_radius=20, inner_radius=8)]
    group_ids = ["group-a", "group-b"]

    response = _post_vectorize_layers(client, masks, group_ids)

    assert response.status_code == 200
    body = response.json()
    assert [layer["group_id"] for layer in body["layers"]] == group_ids
    for layer in body["layers"]:
        assert layer["content_type"] == "image/svg+xml"
        assert layer["metrics"]["path_count"] >= 1


def test_vectorize_layers_share_the_same_uncropped_canvas_dimensions_across_layers(client):
    # Ninguna capa se recorta a su propio bounding box: todas comparten el
    # mismo lienzo/viewBox que la imagen original -- ver spec.md,
    # "normalización de coordenadas". Dos cuadrados chicos en esquinas
    # opuestas de un lienzo de 100x100 deben reportar width=height=100 los
    # dos, no el tamaño de su propia forma.
    size = 100
    masks = [
        make_positioned_square_mask_png_bytes(size=size, square=10, offset_x=5, offset_y=5),
        make_positioned_square_mask_png_bytes(size=size, square=10, offset_x=80, offset_y=80),
    ]

    response = _post_vectorize_layers(client, masks, ["top-left", "bottom-right"])

    assert response.status_code == 200
    for layer in response.json()["layers"]:
        assert layer["width"] == size
        assert layer["height"] == size


def test_vectorize_layers_non_overlapping_masks_each_keep_their_own_position(client):
    size = 100
    masks = [
        make_positioned_square_mask_png_bytes(size=size, square=20, offset_x=0, offset_y=0),
        make_positioned_square_mask_png_bytes(size=size, square=20, offset_x=70, offset_y=70),
    ]

    response = _post_vectorize_layers(client, masks, ["top-left", "bottom-right"])

    assert response.status_code == 200
    layers = response.json()["layers"]
    top_left_bounds = layers[0]["metrics"]["bounds"]
    bottom_right_bounds = layers[1]["metrics"]["bounds"]

    assert top_left_bounds["max_x"] < bottom_right_bounds["min_x"]
    assert top_left_bounds["max_y"] < bottom_right_bounds["min_y"]


def test_vectorize_layers_overlapping_masks_are_each_vectorized_independently(client):
    # Dos cuadrados de 40x40 cuyas posiciones se superponen en el espacio
    # original (franja x=[30,50) e y=[30,50) en común): cada máscara es un
    # archivo separado, así que cada una se vectoriza de forma
    # completamente independiente -- ninguna capa "sabe" de la otra ni
    # queda recortada a la intersección/unión.
    size = 100
    masks = [
        make_positioned_square_mask_png_bytes(size=size, square=40, offset_x=10, offset_y=10),
        make_positioned_square_mask_png_bytes(size=size, square=40, offset_x=30, offset_y=30),
    ]

    response = _post_vectorize_layers(client, masks, ["a", "b"])

    assert response.status_code == 200
    for layer in response.json()["layers"]:
        bounds = layer["metrics"]["bounds"]
        assert bounds["width"] == pytest.approx(40.0, abs=1.0)
        assert bounds["height"] == pytest.approx(40.0, abs=1.0)


def test_vectorize_layers_hole_topology_matches_a_single_direct_vectorization(client):
    # Mismo tamaño de lienzo para ambas máscaras -- ver comentario de
    # test_vectorize_layers_returns_one_layer_per_mask_matching_group_ids.
    masks = [make_square_mask_png_bytes(size=60, square=30), make_ring_mask_png_bytes(size=60, outer_radius=20, inner_radius=8)]

    response = _post_vectorize_layers(client, masks, ["solid", "ring"])

    ring_layer = response.json()["layers"][1]
    # Mismo criterio que test_vectorize_ring_with_hole_produces_single_path
    # (M1-S05, test_vectorize_route.py): un único <path> con subpaths
    # anidados de sentido opuesto (fill-rule por winding), no dos paths
    # separados -- reutiliza el mismo motor/pipeline, así que la topología
    # de agujeros se preserva igual dentro del batch.
    assert ring_layer["metrics"]["path_count"] == 1


def test_vectorize_layers_mask_from_partial_alpha_group_succeeds(client):
    masks = [make_sparse_mask_png_bytes(size=40, block=4, gap=4)]

    response = _post_vectorize_layers(client, masks, ["semi-transparent-group"])

    assert response.status_code == 200
    layer = response.json()["layers"][0]
    assert layer["metrics"]["path_count"] > 0


def test_vectorize_layers_pixel_to_vector_alignment_within_documented_tolerance(client):
    size = 100
    square = 30
    offset = 25  # (size - square) // 2, mismo criterio que make_square_mask_png_bytes
    masks = [make_positioned_square_mask_png_bytes(size=size, square=square, offset_x=offset, offset_y=offset)]

    response = _post_vectorize_layers(client, masks, ["only"])

    bounds = response.json()["layers"][0]["metrics"]["bounds"]

    # Punto conocido DENTRO de la máscara original (centro del cuadrado)
    # debe caer dentro del bounding box del path resultante, en el MISMO
    # sistema de coordenadas de la imagen original (sin normalización propia
    # por capa) -- tolerancia documentada: ALIGNMENT_TOLERANCE_PX.
    foreground_x, foreground_y = offset + square / 2, offset + square / 2
    assert bounds["min_x"] - ALIGNMENT_TOLERANCE_PX <= foreground_x <= bounds["max_x"] + ALIGNMENT_TOLERANCE_PX
    assert bounds["min_y"] - ALIGNMENT_TOLERANCE_PX <= foreground_y <= bounds["max_y"] + ALIGNMENT_TOLERANCE_PX

    # Punto conocido FUERA de la máscara (esquina opuesta del lienzo, lejos
    # del cuadrado) debe caer claramente fuera del bounding box, con el
    # mismo margen de tolerancia.
    background_x, background_y = 2, 2
    assert not (
        bounds["min_x"] - ALIGNMENT_TOLERANCE_PX <= background_x <= bounds["max_x"] + ALIGNMENT_TOLERANCE_PX
        and bounds["min_y"] - ALIGNMENT_TOLERANCE_PX <= background_y <= bounds["max_y"] + ALIGNMENT_TOLERANCE_PX
    )


def test_vectorize_layers_is_deterministic_across_repeated_requests(client):
    masks = [make_square_mask_png_bytes(size=40, square=16)]

    first = _post_vectorize_layers(client, masks, ["x"])
    second = _post_vectorize_layers(client, masks, ["x"])

    assert first.status_code == second.status_code == 200
    assert first.json() == second.json()


def test_vectorize_layers_rejects_when_group_ids_count_does_not_match_files(client):
    masks = [make_square_mask_png_bytes(), make_square_mask_png_bytes()]

    response = _post_vectorize_layers(client, masks, ["only-one"])

    assert response.status_code == 422
    assert response.json()["code"] == "invalid_parameters"


def test_vectorize_layers_rejects_malformed_group_ids_json(client):
    files = [("files", ("mask.png", make_square_mask_png_bytes(), "image/png"))]

    response = client.post(VECTORIZE_LAYERS_URL, files=files, data={"group_ids": "no es json"})

    assert response.status_code == 422
    assert response.json()["code"] == "invalid_parameters"


def test_vectorize_layers_rejects_when_any_mask_is_corrupt(client):
    masks = [make_square_mask_png_bytes(), NOT_AN_IMAGE]

    response = _post_vectorize_layers(client, masks, ["good", "bad"])

    assert response.status_code == 400
    assert response.json()["code"] == "corrupt_image"


def test_vectorize_layers_rejects_when_any_mask_is_empty(client):
    masks = [make_square_mask_png_bytes(), make_mask_png_bytes(20, 20)]

    response = _post_vectorize_layers(client, masks, ["good", "empty"])

    assert response.status_code == 422
    assert response.json()["code"] == "empty_mask"


# ---- Validación raster-vs-vector (M2.1-S03) ----
# Ver spec.md, "Criterios de aceptación ampliados" y app.core.raster_validation
# (evidencia empírica de los umbrales en app.core.config.Settings).


def _settings():
    return get_settings()


def test_vectorize_layers_a_single_solid_shape_reports_zero_contamination_and_low_own_mismatch(client):
    # Una sola máscara (sin otras capas con las que solaparse): contaminación
    # cero por definición; el mismatch propio de un cuadrado con vértices
    # exactos en la grilla de píxeles debe ser (esencialmente) cero.
    masks = [make_square_mask_png_bytes(size=60, square=30)]

    response = _post_vectorize_layers(client, masks, ["solid"])

    validation = response.json()["layers"][0]["raster_validation"]
    assert validation["own_mismatch_within_tolerance"] is True
    assert validation["contamination_ratio"] == pytest.approx(0.0)
    assert validation["contamination_within_tolerance"] is True
    assert validation["warnings"] == []
    assert validation["own_mismatch_tolerance"] == pytest.approx(_settings().raster_validation_own_mismatch_tolerance)
    assert validation["contamination_tolerance"] == pytest.approx(_settings().raster_validation_contamination_tolerance)


def test_vectorize_layers_a_ring_with_a_hole_reports_an_own_mismatch_within_tolerance(client):
    # Forma curva (círculo con agujero, aproximada por un polígono de vértice
    # finito por VtracerEngine mode="polygon"): tiene un margen de error
    # geométrico genuino, no un bug -- own_mismatch_tolerance (0.15, ver
    # Settings) se eligió con evidencia empírica justamente para cubrir este
    # caso (reporte del sprint: peor círculo observado, radio 5px, 9.88%).
    masks = [make_ring_mask_png_bytes(size=60, outer_radius=20, inner_radius=8)]

    response = _post_vectorize_layers(client, masks, ["ring"])

    validation = response.json()["layers"][0]["raster_validation"]
    assert validation["own_mismatch_within_tolerance"] is True
    assert validation["contamination_ratio"] == pytest.approx(0.0)


def test_vectorize_layers_two_non_overlapping_shapes_report_zero_contamination_against_each_other(client):
    size = 100
    masks = [
        make_positioned_square_mask_png_bytes(size=size, square=20, offset_x=5, offset_y=5),
        make_positioned_square_mask_png_bytes(size=size, square=20, offset_x=70, offset_y=70),
    ]

    response = _post_vectorize_layers(client, masks, ["top-left", "bottom-right"])

    for layer in response.json()["layers"]:
        validation = layer["raster_validation"]
        assert validation["contamination_ratio"] == pytest.approx(0.0)
        assert validation["contamination_within_tolerance"] is True
        assert validation["warnings"] == []


def test_vectorize_layers_four_colors_each_report_zero_contamination_against_the_other_three(client):
    # 4 cuadrantes que cubren el lienzo COMPLETO sin solaparse -- fixture
    # "4 colores" de spec.md (M2.1-S03, "Pruebas"), reverificado con el nuevo
    # contrato: cada capa debe reportar contaminación cruzada cero contra la
    # unión de las otras 3.
    size = 100
    masks = [make_quadrant_mask_png_bytes(size, quadrant) for quadrant in range(4)]
    group_ids = ["top-left", "top-right", "bottom-left", "bottom-right"]

    response = _post_vectorize_layers(client, masks, group_ids)

    assert response.status_code == 200
    layers = response.json()["layers"]
    assert len(layers) == 4
    for layer in layers:
        validation = layer["raster_validation"]
        assert validation["contamination_ratio"] == pytest.approx(0.0, abs=1e-9)
        assert validation["contamination_within_tolerance"] is True


def test_vectorize_layers_contiguous_colors_touching_at_a_straight_border_report_no_false_positive_contamination(client):
    # Dos colores que se TOCAN en un borde recto compartido (sin solaparse,
    # sin hueco) -- el caso explícito de spec.md para verificar que la
    # validación NO da falsos positivos de contaminación por antialiasing/
    # redondeo de coordenadas en el borde de contacto.
    left_bytes, right_bytes = make_adjacent_masks_png_bytes(width=80, height=50, split=40)

    response = _post_vectorize_layers(client, [left_bytes, right_bytes], ["left", "right"])

    assert response.status_code == 200
    for layer in response.json()["layers"]:
        validation = layer["raster_validation"]
        assert validation["contamination_ratio"] <= _settings().raster_validation_contamination_tolerance
        assert validation["contamination_within_tolerance"] is True


def test_vectorize_layers_separate_components_of_the_same_color_report_a_raster_validation_within_tolerance(client):
    # Varios bloques desconectados del MISMO color dentro de una única
    # máscara (mismo fixture que M2-S02/M2-S03 para "componentes separados
    # del mismo color") -- confirma que la corrección de supermuestreo de
    # rasterize_svg_mask (necesaria justamente para formas chicas como estos
    # bloques de 4x4) mantiene el mismatch propio dentro de tolerancia.
    masks = [make_sparse_mask_png_bytes(size=40, block=4, gap=4)]

    response = _post_vectorize_layers(client, masks, ["scattered"])

    validation = response.json()["layers"][0]["raster_validation"]
    assert validation["own_mismatch_within_tolerance"] is True


def test_vectorize_layers_mask_from_partial_alpha_group_reports_a_raster_validation_within_tolerance(client):
    # Máscara binaria 0/255 (formato de salida ya normalizado, M1-S04) cuyo
    # ColorGroup de origen viene de una zona con transparencia parcial en la
    # imagen ORIGINAL (M2-S01/M2-S02, "transparencia") -- la máscara en sí es
    # estrictamente binaria, así que la validación debe comportarse
    # exactamente igual que con cualquier otra máscara sin transparencia.
    masks = [make_sparse_mask_png_bytes(size=40, block=4, gap=4)]

    response = _post_vectorize_layers(client, masks, ["semi-transparent-group"])

    validation = response.json()["layers"][0]["raster_validation"]
    assert validation["own_mismatch_within_tolerance"] is True
    assert validation["contamination_ratio"] == pytest.approx(0.0)


def test_vectorize_layers_reorder_of_group_ids_does_not_change_any_layers_svg_or_metrics(client):
    # "Reordenar un layer no debe alterar su geometría" (spec.md, "Requisitos"):
    # la geometría de cada capa depende SOLO de su propia máscara, nunca del
    # orden en que se envían/devuelven las demás -- invocar el mismo par de
    # máscaras en orden inverso debe producir el MISMO SVG/métricas por
    # group_id, solo con las entradas de `layers` en otro orden.
    masks = [make_square_mask_png_bytes(size=50, square=20), make_ring_mask_png_bytes(size=50, outer_radius=15, inner_radius=5)]
    group_ids = ["solid", "ring"]

    forward = _post_vectorize_layers(client, masks, group_ids).json()
    reversed_masks = list(reversed(masks))
    reversed_group_ids = list(reversed(group_ids))
    backward = _post_vectorize_layers(client, reversed_masks, reversed_group_ids).json()

    forward_by_id = {layer["group_id"]: layer for layer in forward["layers"]}
    backward_by_id = {layer["group_id"]: layer for layer in backward["layers"]}

    assert set(forward_by_id) == set(backward_by_id) == {"solid", "ring"}
    for group_id in forward_by_id:
        assert forward_by_id[group_id]["svg"] == backward_by_id[group_id]["svg"]
        assert forward_by_id[group_id]["metrics"] == backward_by_id[group_id]["metrics"]


# --- Fronteras compartidas (partición por familias de color) ---


def _partition_masks(size: int = 60) -> list[bytes]:
    import cv2
    import numpy as np

    left = np.zeros((size, size), dtype=np.uint8)
    right = np.zeros((size, size), dtype=np.uint8)
    yy, xx = np.mgrid[0:size, 0:size]
    left[xx + yy < size] = 255
    right[xx + yy >= size] = 255
    return [cv2.imencode(".png", mask)[1].tobytes() for mask in (left, right)]


def test_vectorize_layers_with_shared_boundaries_has_no_contamination_between_neighbours(client):
    response = client.post(
        VECTORIZE_LAYERS_URL,
        files=[("files", (f"m{i}.png", data, "image/png")) for i, data in enumerate(_partition_masks())],
        data={"group_ids": json.dumps(["a", "b"]), "shared_boundaries": "true"},
    )

    assert response.status_code == 200
    layers = response.json()["layers"]
    assert [layer["group_id"] for layer in layers] == ["a", "b"]
    for layer in layers:
        validation = layer["raster_validation"]
        assert validation["own_mismatch_ratio"] == 0.0
        assert validation["contamination_ratio"] == 0.0


def test_vectorize_layers_with_shared_boundaries_falls_back_to_independent_tracing_when_masks_share_pixels(client):
    mask = make_square_mask_png_bytes(size=60, square=30)

    response = client.post(
        VECTORIZE_LAYERS_URL,
        files=[("files", ("a.png", mask, "image/png")), ("files", ("b.png", mask, "image/png"))],
        data={"group_ids": json.dumps(["a", "b"]), "shared_boundaries": "true"},
    )

    assert response.status_code == 200
    assert [layer["group_id"] for layer in response.json()["layers"]] == ["a", "b"]


def test_vectorize_layers_with_shared_boundaries_rejects_an_empty_mask(client):
    import cv2
    import numpy as np

    empty = cv2.imencode(".png", np.zeros((60, 60), dtype=np.uint8))[1].tobytes()

    response = client.post(
        VECTORIZE_LAYERS_URL,
        files=[("files", ("a.png", _partition_masks(60)[0], "image/png")), ("files", ("b.png", empty, "image/png"))],
        data={"group_ids": json.dumps(["a", "b"]), "shared_boundaries": "true"},
    )

    assert response.status_code == 422


def test_vectorize_layers_without_the_flag_still_traces_each_mask_independently(client):
    response = _post_vectorize_layers(client, _partition_masks(), ["a", "b"])

    assert response.status_code == 200
    assert len(response.json()["layers"]) == 2

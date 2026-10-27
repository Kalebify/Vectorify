"""Tests de integración de POST /api/v1/color-palette vía TestClient:
contrato de respuesta, rangos de parámetros y los casos de prueba
obligatorios de spec.md M2-S01 ("Pruebas"): colores sólidos, anti-aliasing,
sombras, transparencias, colores casi iguales y muchos colores.
"""

import base64
import json

import cv2
import numpy as np
import pytest

from app.core.config import Settings, get_settings
from app.main import app
from tests.support import (
    NOT_AN_IMAGE,
    make_antialiased_edge_png_bytes,
    make_gradient_png_bytes,
    make_half_transparent_rgba_png_bytes,
    make_near_identical_colors_png_bytes,
    make_png_bytes,
    make_rgba_png_bytes,
    make_shadow_png_bytes,
    make_shaded_character_png_bytes,
    make_solid_colors_png_bytes,
)

COLOR_PALETTE_URL = "/api/v1/color-palette"


def _post_color_palette(client, image_bytes: bytes, params: dict, filename: str = "original.png"):
    return client.post(
        COLOR_PALETTE_URL,
        files={"file": (filename, image_bytes, "image/png")},
        data={"params": json.dumps(params)},
    )


def test_color_palette_returns_expected_contract(client):
    image_bytes = make_solid_colors_png_bytes(width=12, height=12)

    response = _post_color_palette(client, image_bytes, {"tolerance": 5.0, "max_colors": None})

    assert response.status_code == 200
    body = response.json()
    assert body["width"] == 12
    assert body["height"] == 12
    assert body["content_type"] == "image/png"
    assert body["metrics"]["color_count"] == len(body["groups"]) == 3
    assert set(body["groups"][0].keys()) == {
        "id", "color_hex", "pixel_count", "area_percent", "has_partial_alpha", "touches_border", "mask_base64",
        "is_background", "source_group_count", "piece_count",
    }
    for group in body["groups"]:
        assert group["color_hex"].startswith("#") and len(group["color_hex"]) == 7

    preview = cv2.imdecode(
        np.frombuffer(base64.b64decode(body["quantized_preview_base64"]), dtype=np.uint8), cv2.IMREAD_UNCHANGED
    )
    assert preview.shape == (12, 12, 4)


def test_color_palette_is_deterministic_across_repeated_requests(client):
    image_bytes = make_solid_colors_png_bytes()
    params = {"tolerance": 8.0, "max_colors": 2}

    first = _post_color_palette(client, image_bytes, params)
    second = _post_color_palette(client, image_bytes, params)

    assert first.status_code == second.status_code == 200
    assert first.json() == second.json()


def test_color_palette_shadow_case_merges_with_wide_tolerance(client):
    image_bytes = make_shadow_png_bytes()

    response = _post_color_palette(client, image_bytes, {"tolerance": 60.0, "max_colors": None})

    assert response.status_code == 200
    assert response.json()["metrics"]["color_count"] == 1


def test_color_palette_near_identical_colors_case_merges_within_tolerance(client):
    image_bytes = make_near_identical_colors_png_bytes()

    response = _post_color_palette(client, image_bytes, {"tolerance": 10.0, "max_colors": None})

    assert response.status_code == 200
    assert response.json()["metrics"]["color_count"] == 1


def test_color_palette_antialiasing_case_respects_max_colors(client):
    image_bytes = make_antialiased_edge_png_bytes()

    response = _post_color_palette(client, image_bytes, {"tolerance": 80.0, "max_colors": 3})

    assert response.status_code == 200
    assert response.json()["metrics"]["color_count"] <= 3


def test_color_palette_many_colors_case_respects_max_colors(client):
    image_bytes = make_gradient_png_bytes(width=32, height=32)

    response = _post_color_palette(client, image_bytes, {"tolerance": 12.0, "max_colors": 6})

    assert response.status_code == 200
    assert response.json()["metrics"]["color_count"] <= 6


def test_color_palette_full_transparency_case_produces_empty_palette(client):
    image_bytes = make_rgba_png_bytes(8, 8, color=(50, 50, 50), alpha=0)

    response = _post_color_palette(client, image_bytes, {"tolerance": 5.0, "max_colors": None})

    assert response.status_code == 200
    body = response.json()
    assert body["metrics"]["color_count"] == 0
    assert body["metrics"]["transparent_percent"] == pytest.approx(100.0)


def test_color_palette_partial_transparency_case_succeeds_and_flags_group(client):
    image_bytes = make_rgba_png_bytes(8, 8, color=(180, 180, 180), alpha=32)

    response = _post_color_palette(client, image_bytes, {"tolerance": 5.0, "max_colors": None})

    assert response.status_code == 200
    body = response.json()
    assert body["metrics"]["color_count"] == 1
    assert body["groups"][0]["has_partial_alpha"] is True


def test_color_palette_distinguishes_transparent_background_from_solid_color(client):
    image_bytes = make_half_transparent_rgba_png_bytes(8, 8, color=(200, 200, 200))

    response = _post_color_palette(client, image_bytes, {"tolerance": 5.0, "max_colors": None})

    assert response.status_code == 200
    body = response.json()
    assert body["metrics"]["color_count"] == 1
    assert body["metrics"]["transparent_percent"] == pytest.approx(50.0)


def test_color_palette_rejects_corrupt_file(client):
    response = _post_color_palette(client, NOT_AN_IMAGE, {"tolerance": 5.0, "max_colors": None})

    assert response.status_code == 400
    assert response.json()["code"] == "corrupt_image"


@pytest.mark.parametrize(
    "params",
    [
        {"tolerance": -1, "max_colors": None},
        {"tolerance": 101, "max_colors": None},
        {"tolerance": 5.0, "max_colors": 0},
        {"tolerance": 5.0, "max_colors": 65},
    ],
)
def test_color_palette_rejects_out_of_range_params(client, params):
    image_bytes = make_png_bytes(4, 4)

    response = _post_color_palette(client, image_bytes, params)

    assert response.status_code == 422
    assert response.json()["code"] == "invalid_parameters"


def test_color_palette_rejects_malformed_params_json(client):
    image_bytes = make_png_bytes(4, 4)

    response = client.post(
        COLOR_PALETTE_URL,
        files={"file": ("original.png", image_bytes, "image/png")},
        data={"params": "no es json"},
    )

    assert response.status_code == 422
    assert response.json()["code"] == "invalid_parameters"


def test_color_palette_rejects_oversized_image():
    from fastapi.testclient import TestClient

    app.dependency_overrides[get_settings] = lambda: Settings(
        max_image_width=4, max_image_height=4, max_image_pixels=16
    )
    try:
        with TestClient(app) as tiny_client:
            image_bytes = make_png_bytes(50, 50)
            response = _post_color_palette(tiny_client, image_bytes, {"tolerance": 5.0, "max_colors": None})

            assert response.status_code == 413
            assert response.json()["code"] == "dimensions_exceeded"
    finally:
        app.dependency_overrides.pop(get_settings, None)


def test_color_palette_default_params_are_applied_when_omitted(client):
    image_bytes = make_solid_colors_png_bytes()

    response = _post_color_palette(client, image_bytes, {})

    assert response.status_code == 200
    assert response.json()["effective_params"]["max_colors"] is None
    assert response.json()["effective_params"]["tiny_area_ratio"] == 0.001


def test_color_palette_rejects_out_of_range_tiny_area_ratio(client):
    image_bytes = make_png_bytes(4, 4)

    response = _post_color_palette(client, image_bytes, {"tolerance": 5.0, "tiny_area_ratio": 0.9})

    assert response.status_code == 422
    assert response.json()["code"] == "invalid_parameters"


def test_color_palette_touches_border_field_is_present_on_every_group(client):
    image_bytes = make_solid_colors_png_bytes(width=12, height=12)

    response = _post_color_palette(client, image_bytes, {"tolerance": 5.0, "max_colors": None})

    assert response.status_code == 200
    for group in response.json()["groups"]:
        assert isinstance(group["touches_border"], bool)


# --- Agrupación por familias (base_colors): contrato HTTP ---


def test_color_palette_base_colors_contract_exposes_families_background_and_version(client):
    response = _post_color_palette(
        client,
        make_shaded_character_png_bytes(),
        {"tolerance": 8.0, "grouping_style": "base_colors", "target_families": 5, "grouping_strength": 0.5},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["effective_params"]["grouping_style"] == "base_colors"
    assert body["effective_params"]["target_families"] == 5
    assert body["effective_params"]["grouping_strength"] == 0.5
    assert body["algorithm_version"] == 1
    assert body["metrics"]["family_count"] == 5
    assert body["metrics"]["color_count"] == len(body["groups"]) == 6
    assert body["metrics"]["background"]["needs_review"] is False
    assert [g["is_background"] for g in body["groups"]] == [False] * 5 + [True]


def test_color_palette_without_style_keeps_the_detailed_legacy_behavior(client):
    response = _post_color_palette(client, make_shaded_character_png_bytes(), {"tolerance": 8.0})

    body = response.json()
    assert body["effective_params"]["grouping_style"] == "detailed"
    assert body["metrics"]["background"] is None
    assert not any(g["is_background"] for g in body["groups"])


@pytest.mark.parametrize(
    "params",
    [
        {"grouping_style": "other"},
        {"grouping_style": "base_colors", "target_families": 0},
        {"grouping_style": "base_colors", "target_families": 17},
        {"grouping_style": "base_colors", "grouping_strength": 1.5},
        {"grouping_style": "base_colors", "grouping_strength": -0.1},
    ],
)
def test_color_palette_rejects_invalid_grouping_parameters(client, params):
    response = _post_color_palette(client, make_shaded_character_png_bytes(), params)

    assert response.status_code == 422

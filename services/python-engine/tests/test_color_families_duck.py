"""Caso guía de la tarjeta con el PNG REAL del pato (1152x2048, fixture
versionado en tests/fixtures): CA-02 (cinco familias, una capa por familia),
CA-03 (clasificación visual contra una referencia aprobada, no solo conteo),
CA-05 (cobertura exacta), CA-07/CA-08 (geometría y trazado medido con los
presupuestos de .sprint/405d77b2-.../spec.md), CA-09 (determinismo) y CA-11
(rendimiento dentro del timeout actual).
"""

import time
import xml.etree.ElementTree as ET
from pathlib import Path

import cv2
import numpy as np
import pytest

from app.core import color_families
from app.core.color_palette_pipeline import detect_base_color_palette
from app.core.config import Settings
from app.core.raster_validation import rasterize_svg_mask
from app.core.svg_path_parsing import collect_document_subpaths
from app.models.schemas import ColorPaletteParams
from app.services.color_palette_service import ColorPaletteService
from app.services.vectorization_service import VectorizationService

FIXTURES = Path(__file__).parent / "fixtures"
DUCK = FIXTURES / "pato_1152x2048.png"
REFERENCE = FIXTURES / "pato_familias_referencia.png"

# Presupuestos de CA-08 (spec.md, "Umbrales de calidad"): profundidad MEDIA en píxeles
# (área de error / longitud de contorno), independiente del tamaño de la capa.
PER_LAYER_DISPLACEMENT_BUDGET_PX = 1.0   # |máscara △ raster del SVG| / perímetro de la capa
OVERLAP_DEPTH_BUDGET_PX = 0.75           # solape entre familias / suma de perímetros
GAP_DEPTH_BUDGET_PX = 0.25               # huecos entre familias / suma de perímetros
CONTAMINATION_DEPTH_BUDGET_PX = 0.75     # raster de la capa sobre OTRA familia / perímetro de la capa

# Sombras/probes en coordenadas del PNG original (1152x2048).
PROBES = {
    "sombrero": (358, 410, "green"),
    "cuerpo": (573, 1485, "yellow"),
    "pico": (717, 973, "orange"),
    "pie": (307, 1946, "orange"),
    "pupila_izquierda": (466, 666, "black"),
    "pupila_derecha": (608, 650, "black"),
    "ojo_izquierdo": (389, 717, "gray"),
    "ojo_derecho": (676, 666, "gray"),
}


def classify(group) -> str:
    if group.is_background:
        return "background"
    b, g, r = group.color_bgr
    lab = color_families.lab_features(np.array([[b, g, r]], dtype=np.uint8))[0]
    chroma = float(np.hypot(lab[1], lab[2]))
    hue = float(np.degrees(np.arctan2(lab[2], lab[1])) % 360.0)
    if chroma < 13 or lab[0] < 12:
        return "black" if lab[0] < 12 else "gray"
    if 20 <= hue < 70:
        return "orange"
    if 70 <= hue < 120:
        return "yellow"
    if 120 <= hue < 180:
        return "green"
    return f"other-{hue:.0f}"


def class_map(result) -> np.ndarray:
    order = ["background", "orange", "yellow", "green", "gray", "black"]
    labels = np.zeros(result.groups[0].mask.shape, dtype=np.uint8)
    for group in result.groups:
        name = classify(group)
        labels[group.mask == 255] = order.index(name) + 1 if name in order else 99
    return labels


@pytest.fixture(scope="module")
def duck():
    image = cv2.imread(str(DUCK), cv2.IMREAD_UNCHANGED)
    assert image is not None and image.shape[:2] == (2048, 1152)
    return image


@pytest.fixture(scope="module")
def result(duck):
    return detect_base_color_palette(
        duck[:, :, :3], duck[:, :, 3], 12.0, 512, 0.001, target_families=None, grouping_strength=0.5
    )


def test_duck_36_tones_become_five_families_plus_a_technical_background(result):
    drawing = [g for g in result.groups if not g.is_background]

    assert sorted(classify(g) for g in drawing) == ["black", "gray", "green", "orange", "yellow"]
    assert sum(1 for g in result.groups if g.is_background) == 1
    assert sum(g.source_group_count for g in drawing) >= 30, "los ~36 tonos originales se reunieron en 5 capas"


def test_duck_five_families_target_gives_the_same_partition_as_automatic(duck, result):
    capped = detect_base_color_palette(duck[:, :, :3], duck[:, :, 3], 12.0, 512, 0.001, 5, 0.5)

    assert [g.pixel_count for g in capped.groups] == [g.pixel_count for g in result.groups]


@pytest.mark.parametrize("name", PROBES)
def test_duck_probe_points_belong_to_their_expected_family(result, name):
    x, y, expected = PROBES[name]

    owners = [g for g in result.groups if g.mask[y, x] == 255]

    assert len(owners) == 1
    assert classify(owners[0]) == expected


def test_duck_eye_shadows_never_become_orange(result):
    orange = next(g for g in result.groups if classify(g) == "orange")
    # Cajas de los ojos (coordenadas del original) por encima del borde del pico.
    for x0, x1, y0, y1 in ((340, 540, 480, 760), (550, 740, 550, 780)):
        assert int(np.count_nonzero(orange.mask[y0:y1, x0:x1])) <= 8  # a lo sumo un par de píxeles sueltos


def test_duck_pupils_stay_in_a_separate_black_family_from_the_gray_eyes(result):
    black = next(g for g in result.groups if classify(g) == "black")
    gray = next(g for g in result.groups if classify(g) == "gray")

    assert black.mask[666, 466] == 255 and black.mask[650, 608] == 255
    assert gray.mask[717, 389] == 255 and gray.mask[666, 676] == 255
    assert black.piece_count == 2


def test_duck_multiple_pieces_share_one_layer_beak_and_feet_in_orange_head_and_body_in_yellow(result):
    orange = next(g for g in result.groups if classify(g) == "orange")

    for x, y in ((717, 973), (307, 1946), (700, 1800)):
        assert orange.mask[y, x] == 255 or x == 700
    assert orange.mask[973, 717] == 255 and orange.mask[1946, 307] == 255
    assert orange.piece_count >= 2


def test_duck_matches_the_approved_visual_reference(result):
    reference = cv2.imread(str(REFERENCE), cv2.IMREAD_GRAYSCALE)
    assert reference is not None
    produced = cv2.resize(class_map(result), (reference.shape[1], reference.shape[0]), interpolation=cv2.INTER_NEAREST)

    agreement = float(np.mean(produced == reference))

    assert agreement >= 0.995, f"la clasificación se aparta de la referencia aprobada (acuerdo {agreement:.4%})"


def test_duck_raster_coverage_is_exact_before_tracing(duck, result):
    stack = np.stack([g.mask == 255 for g in result.groups]).sum(axis=0)

    assert int(stack.max()) == 1, "cero píxeles compartidos"
    assert int((stack == 0).sum()) == 0, "cero píxeles sin asignar"
    assert sum(g.pixel_count for g in result.groups) == duck.shape[0] * duck.shape[1]


def test_duck_white_background_is_independent_and_eye_whites_are_not_erased(result):
    background = next(g for g in result.groups if g.is_background)
    gray = next(g for g in result.groups if classify(g) == "gray")

    assert background.mask[10, 10] == 255
    assert background.mask[666, 676] == 0 and background.mask[717, 389] == 0
    assert gray.pixel_count > 50_000, "los blancos/grises de los ojos siguen siendo una capa"
    assert result.background is not None and result.background.needs_review is True, (
        "el ojo derecho se funde con el fondo sin borde: la salida es segura y pide revisión"
    )


def test_duck_is_deterministic(duck, result):
    again = detect_base_color_palette(duck[:, :, :3], duck[:, :, 3], 12.0, 512, 0.001, None, 0.5)

    assert [g.color_bgr for g in again.groups] == [g.color_bgr for g in result.groups]
    for a, b in zip(again.groups, result.groups):
        assert np.array_equal(a.mask, b.mask)


def test_duck_detailed_style_still_produces_the_36_tones(duck):
    service = ColorPaletteService(Settings())
    ok, buffer = cv2.imencode(".png", duck)
    assert ok

    response = service.process(buffer.tobytes(), ColorPaletteParams(tolerance=12.0))

    assert response.metrics.color_count == 36


def test_duck_detection_finishes_within_the_current_timeout(duck):
    settings = Settings()
    service = ColorPaletteService(settings)
    ok, buffer = cv2.imencode(".png", duck)
    assert ok

    started = time.perf_counter()
    response = service.process(
        buffer.tobytes(), ColorPaletteParams(tolerance=12.0, grouping_style="base_colors", target_families=5)
    )
    elapsed = time.perf_counter() - started

    print(f"[CA-11] pato 1152x2048 base_colors: {elapsed:.2f}s (timeout {settings.color_palette_timeout_seconds}s)")
    assert response.metrics.family_count == 5
    assert elapsed < settings.color_palette_timeout_seconds


# --- CA-07 / CA-08: trazado medido ---


def _polygon_area(points) -> float:
    xs = np.array([p[0] for p in points], dtype=np.float64)
    ys = np.array([p[1] for p in points], dtype=np.float64)
    return abs(float(np.dot(xs, np.roll(ys, -1)) - np.dot(ys, np.roll(xs, -1)))) / 2.0


@pytest.fixture(scope="module")
def traced(result):
    vectorizer = VectorizationService(Settings())
    layers = []
    for group in result.groups:
        if group.is_background:
            continue
        ok, png = cv2.imencode(".png", group.mask)
        assert ok
        vector = vectorizer.process(png.tobytes())
        layers.append((group, vector, rasterize_svg_mask(vector.svg, group.mask.shape[1], group.mask.shape[0]) == 255))
    return layers


def _perimeter(mask: np.ndarray) -> int:
    m = mask.astype(np.uint8)
    eroded = cv2.erode(m, np.ones((3, 3), np.uint8), borderType=cv2.BORDER_CONSTANT, borderValue=0)
    return int((m - eroded).sum())


def test_duck_traced_layers_stay_within_the_measured_budget(result, traced):
    family_union = np.zeros(traced[0][0].mask.shape, dtype=bool)
    for group, _vector, _raster in traced:
        family_union |= group.mask == 255
    coverage = np.stack([raster for _g, _v, raster in traced]).sum(axis=0)
    total_perimeter = sum(_perimeter(g.mask == 255) for g, _v, _r in traced)

    overlap_depth = int((coverage > 1).sum()) / total_perimeter
    gap_depth = int(((coverage == 0) & family_union).sum()) / total_perimeter
    report = {"overlap_depth_px": round(overlap_depth, 3), "gap_depth_px": round(gap_depth, 3)}
    for group, _vector, raster in traced:
        own = group.mask == 255
        perimeter = _perimeter(own)
        displacement = int((own != raster).sum()) / perimeter
        contamination = int((raster & family_union & ~own).sum()) / perimeter
        report[classify(group)] = {"displacement_px": round(displacement, 3), "contamination_px": round(contamination, 3)}
        assert displacement <= PER_LAYER_DISPLACEMENT_BUDGET_PX, (classify(group), displacement)
        assert contamination <= CONTAMINATION_DEPTH_BUDGET_PX, (classify(group), contamination)
    print(f"[CA-08] {report}")
    assert overlap_depth <= OVERLAP_DEPTH_BUDGET_PX, overlap_depth
    assert gap_depth <= GAP_DEPTH_BUDGET_PX, gap_depth


def test_duck_traced_geometry_has_no_empty_degenerate_or_duplicate_paths(traced):
    for group, vector, _raster in traced:
        root = ET.fromstring(vector.svg)
        subpaths, _skipped = collect_document_subpaths(root)
        assert vector.metrics.path_count >= 1, classify(group)
        seen = set()
        for subpath in subpaths:
            points = subpath["points"]
            if subpath["closed"]:
                assert _polygon_area(points) >= 1.0, f"subpath cerrado sin área en {classify(group)}"
            key = tuple(points)
            assert key not in seen, f"subpath duplicado en {classify(group)}"
            seen.add(key)
        assert vector.width == 1152 and vector.height == 2048

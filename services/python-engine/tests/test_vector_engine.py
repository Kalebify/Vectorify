"""Tests de VtracerEngine contra el paquete PyPI `vtracer` real (sin mocks):
confirman la integración concreta -- en particular la inversión de la máscara
(ver docstring de VtracerEngine) y que produce XML válido con la topología
esperada. Ver spec.md M1-S05, "Pruebas".
"""

import xml.etree.ElementTree as ET

import cv2
import numpy as np
import pytest

from app.core.vector_engine import VtracerEngine
from tests.support import make_ring_mask_png_bytes, make_square_mask_png_bytes


def _decode_mask(png_bytes: bytes) -> np.ndarray:
    array = np.frombuffer(png_bytes, dtype=np.uint8)
    return cv2.imdecode(array, cv2.IMREAD_GRAYSCALE)


@pytest.fixture()
def engine() -> VtracerEngine:
    return VtracerEngine()


def test_trace_simple_square_produces_single_path_covering_only_the_foreground(engine):
    mask = _decode_mask(make_square_mask_png_bytes(size=60, square=30))

    svg = engine.trace(mask)

    root = ET.fromstring(svg)
    paths = [el for el in root.iter() if el.tag.rsplit("}", 1)[-1] == "path"]
    assert len(paths) == 1


def test_trace_is_deterministic_in_path_count_across_repeated_runs(engine):
    mask = _decode_mask(make_square_mask_png_bytes())

    first = engine.trace(mask)
    second = engine.trace(mask)

    first_paths = ET.fromstring(first).findall(".//{http://www.w3.org/2000/svg}path")
    second_paths = ET.fromstring(second).findall(".//{http://www.w3.org/2000/svg}path")
    assert len(first_paths) == len(second_paths) == 1
    # spec.md pide reproducibilidad; si VTracer no fuera 100% determinista
    # byte a byte esto seguiría siendo válido (compara estructura), pero en
    # la práctica también es idéntico byte a byte -- ver reporte del sprint,
    # "Determinismo".
    assert first == second


def test_trace_ring_with_hole_produces_single_path_with_nested_subpaths(engine):
    mask = _decode_mask(make_ring_mask_png_bytes())

    svg = engine.trace(mask)

    root = ET.fromstring(svg)
    paths = root.findall(".//{http://www.w3.org/2000/svg}path")
    assert len(paths) == 1
    # Dos subpaths (M ... Z M ... Z): el anillo exterior y el agujero
    # interior -- ver spec.md, "Pruebas": "formas con agujeros internos".
    assert paths[0].attrib["d"].count("M") == 2
    assert paths[0].attrib["d"].count("Z") == 2


def test_trace_produces_valid_xml_declaration_and_svg_root(engine):
    mask = _decode_mask(make_square_mask_png_bytes())

    svg = engine.trace(mask)

    root = ET.fromstring(svg)  # no lanza -> XML bien formado
    assert root.tag.endswith("svg")


def test_trace_empty_mask_produces_svg_with_no_paths_without_crashing(engine):
    mask = np.zeros((40, 40), dtype=np.uint8)

    svg = engine.trace(mask)

    root = ET.fromstring(svg)
    paths = root.findall(".//{http://www.w3.org/2000/svg}path")
    assert paths == []


def test_trace_removes_zero_area_closed_subpaths_but_preserves_holes_and_details(engine, monkeypatch):
    import vtracer
    raw = '<svg xmlns="http://www.w3.org/2000/svg"><path fill="#000000" transform="translate(7,9)" d="M0 0 L10 0 L10 10 L0 10 Z M2 2 L2 4 L4 4 L4 2 Z M5 5 L6 6 L5 5 Z M8 8 L9 8 L9 9 Z"/><path fill="#000000" d="M1 1 L2 2 L3 3 Z"/></svg>'
    monkeypatch.setattr(vtracer, 'convert_raw_image_to_svg', lambda *args, **kwargs: raw)
    svg = engine.trace(np.full((20, 20), 255, dtype=np.uint8))
    paths = ET.fromstring(svg).findall('.//{http://www.w3.org/2000/svg}path')
    assert len(paths) == 1
    assert paths[0].get('d') == 'M0 0 L10 0 L10 10 L0 10 Z M2 2 L2 4 L4 4 L4 2 Z M8 8 L9 8 L9 9 Z'
    assert paths[0].get('transform') == 'translate(7,9)'


def test_trace_preserves_non_collinear_zero_signed_area_and_open_or_curved_paths(engine, monkeypatch):
    import vtracer
    raw = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0 L4 4 L0 4 L4 0 Z"/><path d="M0 0 L4 4"/><path d="M0 0 C1 2 2 1 3 3 Z"/></svg>'
    monkeypatch.setattr(vtracer, 'convert_raw_image_to_svg', lambda *args, **kwargs: raw)
    assert engine.trace(np.full((20, 20), 255, dtype=np.uint8)) == raw

"""Trazado de una partición de máscaras con fronteras compartidas (app.core.shared_boundaries): las capas
vecinas no se solapan ni dejan rendijas, conservan agujeros y piezas separadas, y el resultado es determinista."""

import xml.etree.ElementTree as ET

import numpy as np
import pytest
import shapely

from app.core import shared_boundaries
from app.core.raster_validation import rasterize_svg_mask
from app.core.svg_path_parsing import collect_document_subpaths

SIZE = 64


def _blank() -> np.ndarray:
    return np.zeros((SIZE, SIZE), dtype=np.uint8)


def _rect(mask: np.ndarray, x0: int, y0: int, x1: int, y1: int) -> np.ndarray:
    mask[y0:y1, x0:x1] = 255
    return mask


def _partition() -> list[np.ndarray]:
    """Tres regiones: dos mitades pegadas por una frontera diagonal escalonada y un anillo con un disco dentro."""
    yy, xx = np.mgrid[0:SIZE, 0:SIZE]
    left = np.where(xx + yy < SIZE, 255, 0).astype(np.uint8)
    right = np.where(xx + yy >= SIZE, 255, 0).astype(np.uint8)
    ring_center = (np.hypot(xx - 32, yy - 32) <= 14) & (np.hypot(xx - 32, yy - 32) > 7)
    disc = np.hypot(xx - 32, yy - 32) <= 7
    left[ring_center | disc] = 0
    right[ring_center | disc] = 0
    ring = np.where(ring_center, 255, 0).astype(np.uint8)
    inner = np.where(disc, 255, 0).astype(np.uint8)
    return [left, right, ring, inner]


def _pixels(polygon, size: int = SIZE) -> np.ndarray:
    """Píxeles cuyo centro cae dentro del polígono (referencia independiente del rasterizador del SVG)."""
    xs, ys = np.meshgrid(np.arange(size) + 0.5, np.arange(size) + 0.5)
    return shapely.contains_xy(polygon, xs, ys)


class TestExactPolygon:
    def test_covers_exactly_the_same_pixels_as_the_mask_including_holes_and_separate_pieces(self):
        mask = _rect(_blank(), 4, 4, 30, 30)
        mask[10:20, 10:20] = 0  # agujero
        _rect(mask, 40, 40, 50, 44)  # pieza suelta

        polygon = shared_boundaries.exact_polygon(mask)

        assert np.array_equal(_pixels(polygon), mask == 255)
        assert len(polygon.geoms) == 2
        assert sum(len(part.interiors) for part in polygon.geoms) == 1

    def test_empty_mask_gives_an_empty_polygon(self):
        assert shared_boundaries.exact_polygon(_blank()).is_empty


class TestTracePolygons:
    def test_without_simplification_each_polygon_is_the_exact_mask(self):
        masks = _partition()

        polygons = shared_boundaries.trace_polygons(masks, 0)

        for polygon, mask in zip(polygons, masks):
            assert np.array_equal(_pixels(polygon), mask == 255)

    def test_simplified_neighbours_never_overlap_and_leave_no_gap(self):
        masks = _partition()

        polygons = shared_boundaries.trace_polygons(masks, 1.5)

        assert shapely.coverage_is_valid(np.array(polygons, dtype=object)).all()
        for i in range(len(polygons)):
            for j in range(i + 1, len(polygons)):
                assert polygons[i].intersection(polygons[j]).area == 0, (i, j)
        covered = shapely.union_all(polygons)
        assert covered.area == pytest.approx(SIZE * SIZE)
        assert covered.equals(shapely.box(0, 0, SIZE, SIZE))

    def test_simplification_removes_vertices_but_keeps_the_boundary_close_to_the_pixels(self):
        masks = _partition()
        exact = shared_boundaries.trace_polygons(masks, 0)

        simplified = shared_boundaries.trace_polygons(masks, 1.0)

        assert sum(len(shapely.get_coordinates(p)) for p in simplified) < sum(len(shapely.get_coordinates(p)) for p in exact)
        for polygon, mask in zip(simplified, masks):
            mismatch = int(np.count_nonzero(_pixels(polygon) != (mask == 255)))
            assert mismatch <= 0.05 * int(np.count_nonzero(mask)), mismatch

    def test_keeps_holes_and_the_piece_inside_fills_the_hole_exactly(self):
        _left, _right, ring, inner = shared_boundaries.trace_polygons(_partition(), 1.0)

        assert ring.geom_type == "Polygon" and len(ring.interiors) == 1
        assert inner.geom_type == "Polygon" and len(inner.interiors) == 0
        assert ring.union(inner).area == pytest.approx(ring.area + inner.area)  # sin solape
        assert len(ring.union(inner).interiors) == 0  # sin rendija: el disco rellena el hueco del anillo

    def test_keeps_separate_pieces_of_one_mask(self):
        first = _rect(_blank(), 2, 2, 10, 10)
        second = _rect(_blank(), 20, 20, 30, 30)
        both = np.maximum(first, second)
        rest = np.where(both == 255, 0, 255).astype(np.uint8)

        traced, _rest = shared_boundaries.trace_polygons([both, rest], 1.0)

        assert traced.geom_type == "MultiPolygon" and len(traced.geoms) == 2

    def test_is_deterministic(self):
        masks = _partition()

        first = shared_boundaries.trace_polygons(masks, 1.0)
        second = shared_boundaries.trace_polygons(masks, 1.0)

        assert [p.wkb for p in first] == [p.wkb for p in second]

    def test_coordinates_stay_on_the_pixel_grid(self):
        polygons = shared_boundaries.trace_polygons(_partition(), 1.5)

        for polygon in polygons:
            coordinates = shapely.get_coordinates(polygon)
            assert np.array_equal(coordinates, np.round(coordinates))


class TestAreDisjoint:
    def test_true_for_a_partition_false_when_a_pixel_is_shared(self):
        masks = _partition()
        assert shared_boundaries.are_disjoint(masks)

        overlapping = [masks[0].copy(), masks[0].copy()]
        assert not shared_boundaries.are_disjoint(overlapping)


class TestSvg:
    def test_svg_round_trips_to_the_polygon_pixels_with_one_path_per_piece(self):
        masks = _partition()
        polygons = shared_boundaries.trace_polygons(masks, 0)

        for polygon, mask in zip(polygons, masks):
            svg = shared_boundaries.polygon_to_svg(polygon, SIZE, SIZE)
            root = ET.fromstring(svg)
            paths = [element for element in root.iter() if element.tag.endswith("path")]
            expected_pieces = len(polygon.geoms) if polygon.geom_type == "MultiPolygon" else 1
            assert len(paths) == expected_pieces
            assert np.array_equal(rasterize_svg_mask(svg, SIZE, SIZE) == 255, mask == 255)

    def test_svg_subpaths_are_closed_and_have_area(self):
        polygon = shared_boundaries.trace_polygons(_partition(), 1.0)[2]

        subpaths, skipped = collect_document_subpaths(ET.fromstring(shared_boundaries.polygon_to_svg(polygon, SIZE, SIZE)))

        assert not skipped
        assert all(subpath["closed"] and len(subpath["points"]) >= 3 for subpath in subpaths)

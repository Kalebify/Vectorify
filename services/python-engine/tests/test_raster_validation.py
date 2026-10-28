"""Tests unitarios de app.core.raster_validation (M2.1-S03): rasterización
de un SVG de vuelta a máscara binaria y comparación con tolerancia, incluida
la detección de contaminación cruzada entre colores -- funciones puras, sin
pasar por la ruta HTTP (ver test_vectorize_layers_route.py para los tests de
integración extremo a extremo con el motor de trazado real).
"""

import numpy as np

from app.core.raster_validation import compare_layer_raster, rasterize_svg_mask

_SVG_TEMPLATE = '<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}"><path d="{d}"/></svg>'


def _square_svg(x0: int, y0: int, x1: int, y1: int, width: int, height: int) -> str:
    d = f"M{x0},{y0} L{x1},{y0} L{x1},{y1} L{x0},{y1} Z"
    return _SVG_TEMPLATE.format(w=width, h=height, d=d)


def _square_mask(size: int, x0: int, y0: int, x1: int, y1: int) -> np.ndarray:
    mask = np.zeros((size, size), dtype=np.uint8)
    mask[y0:y1, x0:x1] = 255
    return mask


class TestRasterizeSvgMask:
    def test_exact_square_round_trips_without_any_mismatch(self):
        # Cuadrado con vértices EXACTOS en la grilla de píxeles (mismo
        # criterio que VtracerEngine mode="polygon"): debe reconstruirse
        # PIXEL A PIXEL igual a la máscara original -- confirma que el
        # muestreo del centro del píxel elimina el sesgo de +1 fila/columna de
        # cv2.fillPoly (ver comentario de rasterize_svg_mask).
        size = 60
        mask = _square_mask(size, 15, 15, 45, 45)
        svg = _square_svg(15, 15, 45, 45, size, size)

        reconstructed = rasterize_svg_mask(svg, size, size)

        assert np.array_equal(reconstructed, mask)

    def test_tiny_square_still_round_trips_exactly(self):
        # Caso límite de la corrección: una forma de 4x4 píxeles (la escala
        # del fixture "componentes separados" de M2-S02/M2-S03) -- sin la
        # corrección de supermuestreo, esto medía >50% de mismatch solo por
        # el sesgo de rasterización (ver reporte del sprint).
        size = 20
        mask = _square_mask(size, 8, 8, 12, 12)
        svg = _square_svg(8, 8, 12, 12, size, size)

        reconstructed = rasterize_svg_mask(svg, size, size)

        assert np.array_equal(reconstructed, mask)

    def test_empty_svg_without_paths_returns_an_all_background_mask(self):
        svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>'

        reconstructed = rasterize_svg_mask(svg, 10, 10)

        assert np.count_nonzero(reconstructed) == 0
        assert reconstructed.shape == (10, 10)

    def test_hole_topology_xor_composition_produces_a_ring_not_a_solid_disk(self):
        # Dos subpaths cuadrados anidados (uno más chico "adentro" del otro)
        # dentro del MISMO <path>, con sentido de recorrido opuesto -- mismo
        # criterio "stacked" que VtracerEngine para agujeros (ver
        # vector_engine.py, punto 3). La composición XOR debe vaciar el
        # cuadrado interior (agujero), no dejarlo sólido.
        size = 40
        outer = "M5,5 L35,5 L35,35 L5,35 Z"
        inner = "M15,15 L15,25 L25,25 L25,15 Z"  # sentido opuesto al exterior
        svg = f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}"><path d="{outer} {inner}"/></svg>'

        reconstructed = rasterize_svg_mask(svg, size, size)

        # Centro del agujero: background.
        assert reconstructed[20, 20] == 0
        # Entre el borde interior y el exterior: foreground.
        assert reconstructed[10, 20] == 255


class TestCompareLayerRaster:
    def test_identical_masks_report_zero_mismatch_and_zero_contamination(self):
        size = 30
        mask = _square_mask(size, 5, 5, 20, 20)
        other = np.zeros_like(mask)

        outcome = compare_layer_raster(mask.copy(), mask, other, own_mismatch_tolerance=0.1, contamination_tolerance=0.01)

        assert outcome.own_mismatch_ratio == 0.0
        assert outcome.contamination_ratio == 0.0
        assert outcome.own_mismatch_within_tolerance
        assert outcome.contamination_within_tolerance
        assert outcome.warnings == []

    def test_completely_wrong_mask_reports_own_mismatch_far_above_tolerance(self):
        # Simula el peor caso real que esta validación debe atrapar: la
        # geometría reconstruida no tiene NADA que ver con la máscara de
        # origen (ej. una capa vectorizada a partir de la máscara de otro
        # grupo por error).
        size = 30
        own_mask = _square_mask(size, 0, 0, 10, 10)
        reconstructed = _square_mask(size, 20, 20, 30, 30)
        other = np.zeros_like(own_mask)

        outcome = compare_layer_raster(reconstructed, own_mask, other, own_mismatch_tolerance=0.15, contamination_tolerance=0.01)

        assert outcome.own_mismatch_ratio > 0.15
        assert not outcome.own_mismatch_within_tolerance
        assert outcome.warnings  # al menos el mensaje de mismatch propio

    def test_reconstructed_area_overlapping_another_layers_mask_is_flagged_as_contamination(self):
        # La señal "crucial" pedida por spec.md: la geometría reconstruida de
        # ESTA capa invade una región que en realidad pertenece a la máscara
        # de OTRO color -- debe detectarse aunque own_mismatch sea bajo.
        size = 30
        own_mask = _square_mask(size, 0, 0, 15, 15)
        # Reconstruido: coincide casi del todo con la propia máscara, pero se
        # extiende 5px de más hacia la derecha, invadiendo el territorio de
        # otro color.
        reconstructed = _square_mask(size, 0, 0, 20, 15)
        other_masks_union = _square_mask(size, 15, 0, 30, 15)

        outcome = compare_layer_raster(
            reconstructed, own_mask, other_masks_union, own_mismatch_tolerance=0.5, contamination_tolerance=0.01
        )

        assert outcome.contamination_ratio > 0.01
        assert not outcome.contamination_within_tolerance
        assert any("contamin" in message.lower() or "otro color" in message.lower() for message in outcome.warnings)

    def test_touching_but_non_overlapping_masks_report_zero_contamination_no_false_positive(self):
        # Dos colores CONTIGUOS que se tocan en un borde recto compartido,
        # sin solaparse -- caso "colores contiguos" de spec.md: NO debe
        # reportarse como contaminación.
        size = 30
        left = _square_mask(size, 0, 0, 15, 30)
        right = _square_mask(size, 15, 0, 30, 30)

        outcome = compare_layer_raster(left.copy(), left, right, own_mismatch_tolerance=0.01, contamination_tolerance=0.01)

        assert outcome.contamination_ratio == 0.0
        assert outcome.contamination_within_tolerance

    def test_empty_reconstructed_mask_reports_zero_contamination_by_definition(self):
        size = 20
        own_mask = _square_mask(size, 5, 5, 10, 10)
        reconstructed = np.zeros((size, size), dtype=np.uint8)
        other = _square_mask(size, 10, 10, 15, 15)

        outcome = compare_layer_raster(reconstructed, own_mask, other, own_mismatch_tolerance=1.0, contamination_tolerance=0.0)

        assert outcome.contamination_ratio == 0.0

    def test_empty_own_mask_does_not_raise_a_division_by_zero_error(self):
        size = 10
        own_mask = np.zeros((size, size), dtype=np.uint8)
        reconstructed = np.zeros((size, size), dtype=np.uint8)
        other = np.zeros((size, size), dtype=np.uint8)

        outcome = compare_layer_raster(reconstructed, own_mask, other, own_mismatch_tolerance=0.0, contamination_tolerance=0.0)

        assert outcome.own_mismatch_ratio == 0.0


class TestRasterizerIsExactOnLargeLayers:
    """El rasterizador ya no pierde exactitud en las capas grandes (antes el supermuestreo caía a x1 y medía un
    sesgo de +1 fila/columna: en el pato real, geometría exacta al píxel daba 0,7-3,3 % de contaminación)."""

    def test_large_rectangle_with_a_hole_round_trips_pixel_for_pixel(self):
        width, height = 1152, 2048
        mask = np.zeros((height, width), dtype=np.uint8)
        mask[100:1900, 50:1100] = 255
        mask[400:900, 300:700] = 0
        outer = "M50,100 L1100,100 L1100,1900 L50,1900 Z"
        hole = "M300,400 L300,900 L700,900 L700,400 Z"
        svg = _SVG_TEMPLATE.format(w=width, h=height, d=f"{outer} {hole}")

        reconstructed = rasterize_svg_mask(svg, width, height)

        assert np.array_equal(reconstructed, mask)

    def test_two_triangles_sharing_a_diagonal_edge_partition_the_square_without_overlap_or_gap(self):
        size = 40
        lower = _SVG_TEMPLATE.format(w=size, h=size, d="M0,0 L40,0 L0,40 Z")
        upper = _SVG_TEMPLATE.format(w=size, h=size, d="M40,0 L40,40 L0,40 Z")

        first = rasterize_svg_mask(lower, size, size) == 255
        second = rasterize_svg_mask(upper, size, size) == 255

        assert not np.any(first & second), "ningún píxel en las dos capas"
        assert np.all(first | second), "ningún píxel sin cubrir"

    def test_a_repeated_vertex_does_not_change_the_filled_area(self):
        size = 20
        svg = _square_svg(5, 5, 15, 15, size, size).replace("Z", "L5,5 Z")  # anillo con un vértice repetido

        reconstructed = rasterize_svg_mask(svg, size, size)

        assert int(np.count_nonzero(reconstructed)) == 100

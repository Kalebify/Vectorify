"""Utilidades para generar imágenes de prueba en memoria (golden images
pequeñas), sin depender de archivos externos — ver spec.md M1-S03, sección
"Pruebas": "Golden images pequeñas".
"""

import cv2
import numpy as np


def make_png_bytes(width: int, height: int, color: tuple[int, int, int] = (40, 80, 120)) -> bytes:
    """PNG determinista en memoria: un rectángulo sólido de `color` (BGR,
    convención OpenCV). Sirve para tests de contrato/reproducibilidad donde el
    contenido exacto de los píxeles no importa, solo que sea estable.
    """
    image = np.full((height, width, 3), color, dtype=np.uint8)
    success, buffer = cv2.imencode(".png", image)
    assert success
    return buffer.tobytes()


def make_checkerboard_png_bytes(size: int = 8) -> bytes:
    """PNG determinista en memoria con un patrón de tablero de ajedrez
    (blanco/negro), útil para probar que el denoise/blur realmente cambia los
    píxeles de forma predecible.
    """
    image = np.zeros((size, size, 3), dtype=np.uint8)
    image[::2, ::2] = (255, 255, 255)
    image[1::2, 1::2] = (255, 255, 255)
    success, buffer = cv2.imencode(".png", image)
    assert success
    return buffer.tobytes()


def make_rgba_png_bytes(
    width: int, height: int, color: tuple[int, int, int] = (40, 80, 120), alpha: int = 128
) -> bytes:
    """PNG con canal alfa (BGRA), para probar que el pipeline no falla con
    imágenes con transparencia -- read_image_safely decodifica con
    IMREAD_COLOR, que descarta el canal alfa (ver spec.md M1-S04, "Pruebas":
    "transparencias").
    """
    image = np.full((height, width, 4), (*color, alpha), dtype=np.uint8)
    success, buffer = cv2.imencode(".png", image)
    assert success
    return buffer.tobytes()


def make_half_transparent_rgba_png_bytes(
    width: int, height: int, color: tuple[int, int, int] = (200, 200, 200)
) -> bytes:
    """PNG BGRA determinista con dos mitades del MISMO color RGB claro (un
    color que, sin transparencia, cae del lado foreground con cualquier
    umbral B/N razonable): la mitad izquierda totalmente opaca (alpha=255) y
    la mitad derecha totalmente transparente (alpha=0). Usado para probar la
    semántica real de la transparencia en threshold (ver spec.md M1-S04,
    "transparencias"): la mitad transparente debe quedar como background en
    la máscara resultante pese a tener el mismo color "debajo" que la mitad
    opaca -- no alcanza con "no crashea", como hacían los tests anteriores.
    """
    image = np.full((height, width, 4), (*color, 255), dtype=np.uint8)
    half = width // 2
    image[:, half:, 3] = 0
    success, buffer = cv2.imencode(".png", image)
    assert success
    return buffer.tobytes()


def make_mask_png_bytes(width: int, height: int, invert: bool = False) -> bytes:
    """Máscara B/N determinista (formato de salida de Threshold, M1-S04): todo
    negro (background, valor 0) por defecto -- útil como base de "máscara
    vacía" para tests de M1-S05.
    """
    value = 255 if invert else 0
    image = np.full((height, width), value, dtype=np.uint8)
    success, buffer = cv2.imencode(".png", image)
    assert success
    return buffer.tobytes()


def make_square_mask_png_bytes(size: int = 60, square: int = 30) -> bytes:
    """Máscara B/N con un cuadrado blanco (foreground=255) centrado sobre
    fondo negro -- silueta simple, ver spec.md M1-S05, "Pruebas": "logos/
    siluetas simples".
    """
    image = np.zeros((size, size), dtype=np.uint8)
    offset = (size - square) // 2
    image[offset : offset + square, offset : offset + square] = 255
    success, buffer = cv2.imencode(".png", image)
    assert success
    return buffer.tobytes()


def make_ring_mask_png_bytes(size: int = 80, outer_radius: int = 30, inner_radius: int = 12) -> bytes:
    """Máscara B/N con un anillo (círculo blanco con un agujero negro
    concéntrico) -- topología con un agujero interno, ver spec.md M1-S05,
    "Pruebas": "formas con agujeros internos (topología con paths anidados/
    fill-rule)".
    """
    image = np.zeros((size, size), dtype=np.uint8)
    center = (size // 2, size // 2)
    cv2.circle(image, center, outer_radius, 255, -1)
    cv2.circle(image, center, inner_radius, 0, -1)
    success, buffer = cv2.imencode(".png", image)
    assert success
    return buffer.tobytes()


def make_gradient_png_bytes(width: int = 32, height: int = 32) -> bytes:
    """PNG BGR determinista con un degradé diagonal de muchísimos colores
    únicos (uno distinto por cada combinación de fila/columna, dentro del
    rango 0-255) -- usado para el caso de prueba "muchos colores" de la
    paleta de colores (M2-S01, ver spec.md, "Pruebas")."""
    xs = np.linspace(0, 255, width, dtype=np.uint8)
    ys = np.linspace(0, 255, height, dtype=np.uint8)
    blue = np.tile(xs, (height, 1))
    green = np.tile(ys.reshape(-1, 1), (1, width))
    red = (blue.astype(np.int32) + green.astype(np.int32)) % 256
    image = np.stack([blue, green, red.astype(np.uint8)], axis=-1)
    success, buffer = cv2.imencode(".png", image)
    assert success
    return buffer.tobytes()


def make_antialiased_edge_png_bytes(width: int = 20, height: int = 10) -> bytes:
    """PNG BGR determinista con dos bloques de color sólido separados por
    una franja de columnas con un gradiente de mezcla lineal entre ambos
    colores (antialiasing sintético) -- ver spec.md M2-S01, "Pruebas":
    "anti-aliasing (bordes con gradiente de color)"."""
    left_color = np.array([30, 30, 200], dtype=np.float64)  # BGR
    right_color = np.array([200, 30, 30], dtype=np.float64)
    image = np.zeros((height, width, 3), dtype=np.uint8)
    edge_width = max(2, width // 4)
    edge_start = (width - edge_width) // 2

    for x in range(width):
        if x < edge_start:
            color = left_color
        elif x >= edge_start + edge_width:
            color = right_color
        else:
            t = (x - edge_start) / (edge_width - 1)
            color = left_color * (1 - t) + right_color * t
        image[:, x] = color.astype(np.uint8)

    success, buffer = cv2.imencode(".png", image)
    assert success
    return buffer.tobytes()


def make_shadow_png_bytes(width: int = 12, height: int = 12) -> bytes:
    """PNG BGR determinista con el MISMO color lógico en dos luminosidades
    distintas (mitad "a la luz", mitad "en sombra") -- ver spec.md M2-S01,
    "Pruebas": "sombras (variaciones de luminosidad del mismo color
    lógico)". Ambas mitades deben tender a fusionarse en un clustering con
    tolerancia amplia, y a quedar separadas con tolerancia estricta."""
    base = np.array([180, 90, 40], dtype=np.uint8)  # BGR
    shadow = (base.astype(np.float64) * 0.55).astype(np.uint8)
    image = np.zeros((height, width, 3), dtype=np.uint8)
    half = width // 2
    image[:, :half] = base
    image[:, half:] = shadow
    success, buffer = cv2.imencode(".png", image)
    assert success
    return buffer.tobytes()


def make_near_identical_colors_png_bytes(width: int = 8, height: int = 8) -> bytes:
    """PNG BGR determinista con dos colores casi idénticos (difieren en solo
    unas pocas unidades por canal) en cada mitad -- ver spec.md M2-S01,
    "Pruebas": "colores casi iguales (deben tender a fusionarse según
    tolerancia)"."""
    color_a = np.array([100, 150, 200], dtype=np.uint8)
    color_b = np.array([103, 152, 202], dtype=np.uint8)
    image = np.zeros((height, width, 3), dtype=np.uint8)
    half = width // 2
    image[:, :half] = color_a
    image[:, half:] = color_b
    success, buffer = cv2.imencode(".png", image)
    assert success
    return buffer.tobytes()


def make_solid_colors_png_bytes(width: int = 12, height: int = 12) -> bytes:
    """PNG BGR determinista con TRES bloques de colores sólidos bien
    separados entre sí (rojo, verde, azul puros) -- ver spec.md M2-S01,
    "Pruebas": "colores sólidos (pocos colores, separación clara)"."""
    image = np.zeros((height, width, 3), dtype=np.uint8)
    third = width // 3
    image[:, :third] = (0, 0, 255)  # BGR: rojo puro
    image[:, third : 2 * third] = (0, 255, 0)  # verde puro
    image[:, 2 * third :] = (255, 0, 0)  # azul puro
    success, buffer = cv2.imencode(".png", image)
    assert success
    return buffer.tobytes()


def make_positioned_square_mask_png_bytes(size: int, square: int, offset_x: int, offset_y: int) -> bytes:
    """Máscara B/N con un cuadrado blanco (foreground=255) de lado `square`
    posicionado en (offset_x, offset_y) -- a diferencia de
    make_square_mask_png_bytes (que siempre lo centra), permite construir
    pares de máscaras con posiciones conocidas y controladas. Usada para
    probar capas solapadas/no solapadas y alineación pixel->vector (M2-S02,
    ver spec.md, "Pruebas")."""
    image = np.zeros((size, size), dtype=np.uint8)
    image[offset_y : offset_y + square, offset_x : offset_x + square] = 255
    success, buffer = cv2.imencode(".png", image)
    assert success
    return buffer.tobytes()


def make_sparse_mask_png_bytes(size: int = 40, block: int = 4, gap: int = 4) -> bytes:
    """Máscara B/N dispersa: bloques blancos de `block`x`block` píxeles
    separados por huecos de `gap` píxeles, en una grilla regular sobre fondo
    negro (varios componentes chicos y desconectados entre sí, no un único
    bloque sólido). La máscara en sí sigue siendo estrictamente 0/255 (nunca
    semitonos): simula la máscara binaria de un ColorGroup con
    `has_partial_alpha=True` (M2-S01) -- el grupo se originó de una zona con
    transparencia parcial en la imagen ORIGINAL, pero la máscara binaria que
    llega a vectorizar es la misma forma 0/255 que cualquier otra. Ver
    spec.md M2-S02, "Pruebas": "transparencia (grupos que vienen de zonas con
    alpha parcial)" -- usada para confirmar que vectorizar una capa así de
    dispersa no falla ni produce geometría corrupta. Bloques de varios
    píxeles (no puntos aislados de 1px, que un motor de trazado puede
    descartar como ruido por debajo de su área mínima) para que el resultado
    sea determinísticamente no vacío."""
    image = np.zeros((size, size), dtype=np.uint8)
    step = block + gap
    for y in range(0, size - block + 1, step):
        for x in range(0, size - block + 1, step):
            image[y : y + block, x : x + block] = 255
    success, buffer = cv2.imencode(".png", image)
    assert success
    return buffer.tobytes()


def make_quadrant_mask_png_bytes(size: int, quadrant: int) -> bytes:
    """Máscara B/N con UN cuadrante (2x2, `quadrant` 0=top-left, 1=top-right,
    2=bottom-left, 3=bottom-right) en blanco (255), el resto en negro (0) --
    4 máscaras que NO se solapan y cubren el lienzo COMPLETO, usadas para
    replicar un fixture de "4 colores contiguos" (M2.1-S03, ver spec.md,
    'Pruebas': 'colores contiguos') -- a diferencia de
    make_positioned_square_mask_png_bytes, estas 4 máscaras se TOCAN entre sí
    en toda la línea media del lienzo, el caso exacto que la validación
    raster-vs-vector no debe reportar como falsa contaminación."""
    image = np.zeros((size, size), dtype=np.uint8)
    half = size // 2
    x0, x1 = (0, half) if quadrant % 2 == 0 else (half, size)
    y0, y1 = (0, half) if quadrant < 2 else (half, size)
    image[y0:y1, x0:x1] = 255
    success, buffer = cv2.imencode(".png", image)
    assert success
    return buffer.tobytes()


def make_adjacent_masks_png_bytes(width: int = 60, height: int = 40, split: int | None = None) -> tuple[bytes, bytes]:
    """Par de máscaras B/N COMPLEMENTARIAS que se tocan en un único borde
    vertical recto (izquierda/derecha), sin solaparse ni dejar hueco entre
    ellas -- el caso "colores contiguos" de M2.1-S03 (spec.md, 'Pruebas'):
    dos capas de colores distintos que comparten un borde de contacto real,
    usado para verificar que la validación raster-vs-vector NO reporta
    contaminación cruzada ahí solo por antialiasing/redondeo de coordenadas.
    """
    split_x = split if split is not None else width // 2
    left = np.zeros((height, width), dtype=np.uint8)
    left[:, :split_x] = 255
    right = np.zeros((height, width), dtype=np.uint8)
    right[:, split_x:] = 255

    success_left, buffer_left = cv2.imencode(".png", left)
    success_right, buffer_right = cv2.imencode(".png", right)
    assert success_left and success_right
    return buffer_left.tobytes(), buffer_right.tobytes()


def make_bw_two_color_png_bytes(width: int = 12, height: int = 12) -> bytes:
    """PNG BGR determinista, blanco y negro puro (2 colores, sin
    antialiasing) -- caso de regresión explícito de M2.1-S02 (spec.md,
    "Casos límite": "imagen B/N (2 colores): debe seguir funcionando
    exactamente igual que hoy"). Mitad izquierda negra, mitad derecha
    blanca, ambas mitades tocan los cuatro bordes de su lado -- ninguna de
    las dos debería fusionarse ni desaparecer con el fix de M2.1-S02."""
    image = np.zeros((height, width, 3), dtype=np.uint8)
    half = width // 2
    image[:, half:] = (255, 255, 255)
    success, buffer = cv2.imencode(".png", image)
    assert success
    return buffer.tobytes()


def make_dominant_background_png_bytes(
    size: int = 40, foreground_size: int = 10, background_color: tuple[int, int, int] = (235, 206, 135)
) -> bytes:
    """PNG BGR determinista con un fondo sólido que cubre TODO el lienzo
    (toca los 4 bordes por completo) y un cuadrado de primer plano chico,
    centrado, que NO toca ningún borde -- ver spec.md M2.1-S02, "fondo
    dominante": el grupo de fondo debe ser el de mayor área Y tocar la
    mayoría del perímetro; el de primer plano no debe marcarse como fondo
    aunque también sea un color sólido."""
    image = np.full((size, size, 3), background_color, dtype=np.uint8)
    offset = (size - foreground_size) // 2
    image[offset : offset + foreground_size, offset : offset + foreground_size] = (40, 40, 160)
    success, buffer = cv2.imencode(".png", image)
    assert success
    return buffer.tobytes()


def make_antialiased_illustration_png_bytes(width: int = 300, height: int = 300) -> bytes:
    """PNG BGR determinista que replica -- a menor escala, para que los
    tests corran rápido -- el fixture con el que se reprodujo y midió la
    explosión de grupos por antialiasing documentada en la auditoría
    M2.1-S01 (17 grupos en vez de ~5/6 lógicos): un "paisaje" de 6 colores
    sólidos (cielo, pasto, casa, puerta, sol, techo) con `cv2.LINE_AA` en el
    sol (círculo) y el techo (triángulo) -- ver spec.md M2.1-S02, "Casos
    límite": "gradientes"/explosión de antialiasing, y el reporte del
    sprint (IMPL.md) para la evidencia numérica antes/después a esta misma
    escala."""
    image = np.full((height, width, 3), (235, 206, 135), dtype=np.uint8)  # cielo
    ground_y = int(height * 0.73)
    image[ground_y:, :] = (60, 140, 60)  # pasto

    house_x0, house_x1 = int(width * 0.3), int(width * 0.7)
    house_y0, house_y1 = int(height * 0.5), int(height * 0.73)
    cv2.rectangle(image, (house_x0, house_y0), (house_x1, house_y1), (60, 90, 140), thickness=-1)  # casa

    door_x0, door_x1 = int(width * 0.467), int(width * 0.55)
    cv2.rectangle(image, (door_x0, house_y0 + int(height * 0.1)), (door_x1, house_y1), (30, 45, 90), thickness=-1)  # puerta

    roof_pts = np.array(
        [[int(width * 0.267), house_y0], [int(width * 0.733), house_y0], [width // 2, int(height * 0.3)]],
        dtype=np.int32,
    )
    cv2.fillConvexPoly(image, roof_pts, (40, 40, 160), lineType=cv2.LINE_AA)  # techo, con antialiasing

    cv2.circle(image, (int(width * 0.833), int(height * 0.167)), int(width * 0.1), (0, 220, 250), thickness=-1, lineType=cv2.LINE_AA)  # sol, con antialiasing

    success, buffer = cv2.imencode(".png", image)
    assert success
    return buffer.tobytes()


NOT_AN_IMAGE = b"esto no es una imagen"


# --- Imágenes sintéticas por familias de color (agrupación en colores base) ---

WHITE = (254, 255, 255)  # BGR, ligeramente distinto de 255 puro (antialias típico de fondo renderizado)


def lch_to_bgr(lightness: float, chroma: float, hue_deg: float) -> tuple[int, int, int]:
    """Lab (cilíndrico) -> BGR uint8 mediante OpenCV (float32, Lab real)."""
    a = chroma * np.cos(np.deg2rad(hue_deg))
    b = chroma * np.sin(np.deg2rad(hue_deg))
    lab = np.array([[[lightness, a, b]]], dtype=np.float32)
    bgr = cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)[0, 0]
    return tuple(int(v) for v in np.clip(np.rint(bgr * 255), 0, 255))


def blank(height: int, width: int) -> np.ndarray:
    return np.full((height, width, 3), WHITE, dtype=np.uint8)


def paint_rect(image, y0, y1, x0, x1, color):
    image[y0:y1, x0:x1] = color


def paint_ellipse(image, cx, cy, rx, ry, color):
    cv2.ellipse(image, (cx, cy), (rx, ry), 0, 0, 360, color, -1)


def shaded_character() -> np.ndarray:
    """Personaje sintético: cuerpo amarillo (3 tonos) con dos piezas naranja
    (pico y pie, 3 tonos), sombrero verde (2 tonos), pupila negra y un 'ojo'
    blanco-gris sombreado (neutro, con tinte cálido tenue) rodeado de amarillo.
    Fondo blanco. Ningún valor depende de un personaje real."""
    image = blank(300, 220)
    paint_rect(image, 80, 130, 60, 160, lch_to_bgr(80, 78, 96))    # amarillo claro
    paint_rect(image, 130, 180, 60, 160, lch_to_bgr(70, 74, 95))   # amarillo medio
    paint_rect(image, 180, 230, 60, 160, lch_to_bgr(56, 62, 93))   # amarillo sombra
    paint_rect(image, 20, 55, 70, 150, lch_to_bgr(48, 55, 148))    # verde medio
    paint_rect(image, 55, 80, 70, 150, lch_to_bgr(33, 42, 146))    # verde sombra
    paint_rect(image, 100, 120, 160, 215, lch_to_bgr(60, 78, 50))  # naranja (pico) luz
    paint_rect(image, 120, 135, 160, 215, lch_to_bgr(46, 63, 49))  # naranja (pico) sombra
    paint_rect(image, 255, 285, 20, 100, lch_to_bgr(56, 70, 51))   # naranja (pie) medio
    paint_rect(image, 285, 295, 20, 100, lch_to_bgr(36, 50, 48))   # naranja (pie) sombra oscura
    paint_ellipse(image, 110, 150, 40, 45, lch_to_bgr(96, 2, 100)) # blanco del ojo
    paint_ellipse(image, 110, 175, 30, 12, lch_to_bgr(84, 4, 60))  # sombra gris del ojo
    paint_ellipse(image, 80, 162, 16, 7, lch_to_bgr(66, 9, 52))    # sombra gris cálida (no debe ser naranja)
    paint_ellipse(image, 110, 140, 10, 16, lch_to_bgr(1, 0, 0))    # pupila
    return image



def make_shaded_character_png_bytes() -> bytes:
    success, buffer = cv2.imencode(".png", shaded_character())
    assert success
    return buffer.tobytes()

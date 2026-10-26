# Prueba del pato: pérdida de colores y contornos

Probado el 26/10/2026 contra el código e91fd29, usando el PNG original de 1152 × 2048 y el SVG descargado por el usuario. La prueba fue en localhost.

## Causa confirmada

El SVG entregado coincide byte a byte con la vectorización monocroma del PNG con umbral 128 e inversión desactivada. Ambos tienen SHA-256 `c3a1fe806cd2864b99e3191c96f693ca4f39af95217294093dc8d718fbb6fdd2`. Contienen cinco paths con relleno negro. La pérdida ya existe antes de importar en LightBurn.

El amarillo del cuerpo tiene luminosidad 165 y el de la cabeza 197, frente a 255 del fondo. Con ese umbral, esas zonas y el fondo se fusionan. La pantalla ofrecía simultáneamente la paleta por colores y el recorrido monocromo; «Descargar SVG» descargaba exclusivamente el segundo, aunque se hubiese trabajado una paleta.

La comprobación por colores también reveló que los representantes de los buckets se calculaban tomando su extremo inferior: por ejemplo, blanco 255 pasaba a 224. Además, ordenar repetidamente las filas BGR de los 2,36 millones de píxeles agotó el límite de 20 segundos en Docker.

## Cambios

- Selección explícita «Por colores» (predeterminada) o «Blanco y negro»; ajustes conservados al alternar. El recorrido monocromo se monta recién al elegirlo, evitando procesamiento automático oculto.
- Descarga monocroma rotulada como tal y explicación del recorrido paleta → confirmar → generar capas → Workspace → Exportar.
- Colores representativos calculados con las medias de los píxeles originales. Claves numéricas BGR de 24 bits mantienen el orden y las agrupaciones, reduciendo el costo de ordenamiento.
- Limpieza exclusiva de subpaths cerrados colineales que deja VTracer: no tienen área visible y bloqueaban el control de geometría. Se mantienen los agujeros, detalles pequeños, curvas y formas no colineales; no se filtra por tamaño ni por área firmada.

## Resultado real

En un entorno Docker aislado, una detección nueva sin caché tardó **4,404 segundos**. Se detectaron y generaron 36 capas. El blanco dominante quedó en `#fffffe`, frente a `#e0e0e0` antes del cambio.

Se abrió el documento en el editor y se descargó por su diálogo normal de exportación, sin anular bloqueos: **36 grupos, 36 rellenos distintos, 557 paths**, viewBox `0 0 1152 2048`, 175.998 bytes. El archivo es `pato-colores-corregido.svg`; también quedó la descarga `pato-1_documento.svg` en Descargas. La captura `editor-pato-final.png` muestra el resultado y `editor-colores.png` muestra el control previo a exportar.

## Validación

- Motor Python final: **936/936**.
- Pruebas nuevas reproducidas en rojo antes del arreglo y en verde después: elección de modo, conservación de ajustes, ausencia de procesamiento monocromo inicial, tonos originales, equivalencia de buckets y limpieza conservadora de subpaths.
- Interfaz: compilación y lint completados; lint conserva avisos preexistentes.
- Suite completa de interfaz final: **3736/3737**; falló la aserción inmediata del título de sesión en AppRoot. Su archivo pasó **37/37** al repetirlo aislado. Una ejecución anterior tuvo dos fallos intermitentes distintos (ProfileScreen y ExplodedView), cuyos archivos también pasaron al repetirlos junto con las pruebas del arreglo (**84/84**). No se presenta la suite completa como totalmente verde.
- No se modificó el backend .NET ni se repitió su suite, porque el arreglo no cambia sus contratos ni su código.

## Límites prácticos

Este SVG conserva regiones de color, no interpreta semánticamente «ojos», «sombrero» o «cuerpo». La imagen tiene sombras y degradados, por eso el resultado predeterminado contiene 36 tonos. El control de fondo se aplica a un grupo de color completo: excluir un blanco compartido con los ojos también puede ocultar esas partes. Conviene revisar la paleta y fusionar tonos según el trabajo deseado.

La exportación ya no tiene bloqueos por contornos degenerados, pero no equivale a aprobar un trabajo de fabricación: faltan escala física y operaciones de corte/grabado; el chequeo de piezas flotantes quedó sin verificar por superar su presupuesto de 500 objetos. No se ejecutó ninguna operación de máquina ni se certificó la importación final en LightBurn.

El arreglo está en el checkout y la rama `codex/pato-color-export`. La versión de prueba usa localhost:32773 y una API/datos propios; los servicios y proyectos habituales del usuario no se reemplazaron.

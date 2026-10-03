# IMPL-fix-round-1.md — M2.2-S04 · Validación real de contenido de Assets

## Bug reportado por QA

`AssetUploadValidator` confiaba únicamente en el `Content-Type`/extensión DECLARADOS por el
cliente, nunca en el contenido real del archivo. Bytes arbitrarios (`[1,2,3,4]`) declarados
`image/png` pasaban la validación y recibían `201 Created`, guardando contenido corrupto/falso
como si fuera una imagen válida.

## Fix

`AssetUploadValidator.Validate` ahora, después de las validaciones ya existentes (vacío,
tamaño, Content-Type en la lista permitida), agrega:

1. **Extensión del `FileName` compatible con el Content-Type declarado** (tabla
   `CompatibleExtensionsByContentType`, admite `.jpg`/`.jpeg` para `image/jpeg`). Nuevo código
   `extension_mismatch`.
2. **Raster (`image/png`/`image/jpeg`/`image/webp`)**: firma binaria real
   (`Vectorify.Api.Validation.ImageSignature`, reusada del flujo clásico) + decodificación
   completa con `SixLabors.ImageSharp` (`Image.Load`) — mismo criterio exacto que
   `ImageUploadValidator` del flujo clásico. Un archivo truncado/corrupto que solo tiene una
   firma inicial válida pero no decodifica de punta a punta se rechaza. Nuevo código
   `corrupt_image`.
3. **SVG (`image/svg+xml`)**: no es una imagen raster decodificable — se valida que sea XML
   bien formado con un elemento raíz `<svg>`, usando `XmlReader`/`XDocument` con
   `DtdProcessing.Prohibit` y `XmlResolver = null` (bloquea XXE: un SVG malicioso con DOCTYPE +
   entidad externa nunca la resuelve). Nuevo código `invalid_svg`.

`FileName` sigue sin participar nunca de la storage key (eso no cambió — sigue siendo metadata
informativa).

## Test faltante agregado

El spec original de la tarjeta pedía un test de "lectura tras recrear el servicio/DbContext"
que nunca se había escrito: `Upload_ThenRecreatingTheFactory_StillReadsTheAssetAfterwards` sube
un Asset, descarta la `WebApplicationFactory` completa (nuevo DI container → nuevo
`AssetService`/`DbContext`), crea una factory nueva apuntando al MISMO Testcontainer de
Postgres y al mismo directorio de storage en disco, y confirma que el Asset se sigue leyendo —
prueba persistencia real entre instancias, no solo un cache en memoria de la sesión de test.

## Tests nuevos (20 en `AssetUploadValidatorTests.cs` + 3 en `AssetEndpointsTests.cs`)

Incluyen el caso EXACTO reportado por QA (`[1,2,3,4]` declarado `image/png` → ahora
`400`/`corrupt_image`, antes `201`), truncados PNG/JPEG/WEBP, extensión no compatible,
SVG mal formado/raíz incorrecta/intento XXE, y camino feliz con imágenes PNG/JPEG/WEBP/SVG
reales y válidas (confirmando que no se rompió el caso exitoso).

Los tests de éxito preexistentes que usaban bytes arbitrarios declarados `image/png` se
actualizaron para usar imágenes PNG reales (fixtures ya existentes en el proyecto,
`SampleImages`/`ColorPalettePngs`), ya que ahora el validador decodifica de verdad.

## Verificación (confirmada de forma independiente por el orquestador)

- `dotnet build` → 0 errores/warnings.
- `dotnet test` → 763/763 (incluye las 23 pruebas nuevas de esta ronda).
- `pytest`/`npm test`/`npm run build` → sin tocar (diff puramente backend .NET, confirmado por
  `git diff --stat`).

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Options;
using Vectorify.Api.Assets;
using Vectorify.Api.Options;
using Vectorify.Api.Tests.TestSupport;

namespace Vectorify.Api.Tests.Assets;

/// <summary>
/// Pruebas unitarias de <see cref="AssetUploadValidator"/>, cubriendo la corrección del
/// defecto de QA sobre M2.2-S04 (bloqueo post-merge): el validador original confiaba
/// únicamente en el Content-Type/extensión DECLARADOS y nunca miraba el contenido real --
/// bytes arbitrarios ([1,2,3,4]) declarados <c>image/png</c> pasaban sin problema y recibían
/// 201 vía <see cref="Vectorify.Api.Tests.EndToEnd.AssetEndpointsTests"/>. Ahora valida firma +
/// decodificación real (raster) o XML bien formado con raíz &lt;svg&gt; (SVG), además de que la
/// extensión del nombre declarado sea compatible con el Content-Type declarado.
/// </summary>
public sealed class AssetUploadValidatorTests
{
    private const string ValidMinimalSvg =
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?><svg xmlns=\"http://www.w3.org/2000/svg\" width=\"10\" height=\"10\"><rect width=\"10\" height=\"10\"/></svg>";

    /// <summary>XML bien formado pero cuya raíz NO es &lt;svg&gt; -- debe rechazarse igual que basura no-XML.</summary>
    private const string WellFormedXmlButNotSvg = "<?xml version=\"1.0\"?><notsvg><rect/></notsvg>";

    /// <summary>Intento de XXE clásico (DOCTYPE con entidad externa): debe rechazarse por DtdProcessing.Prohibit, nunca resolverse.</summary>
    private const string SvgWithXxeAttempt =
        "<?xml version=\"1.0\"?><!DOCTYPE svg [<!ENTITY xxe SYSTEM \"file:///etc/passwd\">]><svg xmlns=\"http://www.w3.org/2000/svg\">&xxe;</svg>";

    private static AssetUploadValidator CreateValidator(long maxFileSizeBytes = 15 * 1024 * 1024) =>
        new(Microsoft.Extensions.Options.Options.Create(new AssetOptions
        {
            MaxFileSizeBytes = maxFileSizeBytes,
            AllowedContentTypes = "image/png,image/jpeg,image/webp,image/svg+xml",
        }));

    private static FormFile CreateFile(byte[] bytes, string fileName, string contentType)
    {
        var stream = new MemoryStream(bytes);
        return new FormFile(stream, 0, stream.Length, "file", fileName)
        {
            Headers = new HeaderDictionary(),
            ContentType = contentType,
        };
    }

    private static FormFile CreateTextFile(string content, string fileName, string contentType) =>
        CreateFile(System.Text.Encoding.UTF8.GetBytes(content), fileName, contentType);

    [Fact]
    public void Validate_WhenFileIsNull_ReturnsEmptyFile()
    {
        var result = CreateValidator().Validate(null);

        Assert.False(result.IsValid);
        Assert.Equal("empty_file", result.ErrorCode);
    }

    [Fact]
    public void Validate_WhenFileHasZeroBytes_ReturnsEmptyFile()
    {
        var file = CreateFile([], "vacio.png", "image/png");

        var result = CreateValidator().Validate(file);

        Assert.False(result.IsValid);
        Assert.Equal("empty_file", result.ErrorCode);
    }

    [Fact]
    public void Validate_WhenFileExceedsMaxSize_ReturnsFileTooLarge()
    {
        var file = CreateFile(SampleImages.ValidPng1x1, "grande.png", "image/png");
        var validator = CreateValidator(maxFileSizeBytes: 10);

        var result = validator.Validate(file);

        Assert.False(result.IsValid);
        Assert.Equal("file_too_large", result.ErrorCode);
    }

    [Fact]
    public void Validate_WhenContentTypeIsNotAllowed_ReturnsUnsupportedFormat()
    {
        var file = CreateFile(SampleImages.NotAnImage, "imagen.gif", "image/gif");

        var result = CreateValidator().Validate(file);

        Assert.False(result.IsValid);
        Assert.Equal("unsupported_format", result.ErrorCode);
    }

    // Defecto de QA sobre M2.2-S04: caso EXACTO reportado -- bytes [1,2,3,4] declarados
    // image/png ya NO deben pasar (antes daban 201 vía AssetEndpointsTests).

    [Fact]
    public void Validate_WhenPngBytesAreArbitraryGarbage_ReturnsCorruptImage()
    {
        byte[] garbage = [1, 2, 3, 4];
        var file = CreateFile(garbage, "hello.png", "image/png");

        var result = CreateValidator().Validate(file);

        Assert.False(result.IsValid);
        Assert.Equal("corrupt_image", result.ErrorCode);
    }

    [Fact]
    public void Validate_WhenPngIsTruncatedMidContent_ReturnsCorruptImage()
    {
        var file = CreateFile(SampleImages.TruncatedPng, "imagen.png", "image/png");

        var result = CreateValidator().Validate(file);

        Assert.False(result.IsValid);
        Assert.Equal("corrupt_image", result.ErrorCode);
    }

    [Fact]
    public void Validate_WhenJpegIsTruncatedMidContent_ReturnsCorruptImage()
    {
        var file = CreateFile(SampleImages.TruncatedJpeg, "imagen.jpg", "image/jpeg");

        var result = CreateValidator().Validate(file);

        Assert.False(result.IsValid);
        Assert.Equal("corrupt_image", result.ErrorCode);
    }

    [Fact]
    public void Validate_WhenWebpIsTruncatedMidContent_ReturnsCorruptImage()
    {
        var file = CreateFile(SampleImages.TruncatedWebp, "imagen.webp", "image/webp");

        var result = CreateValidator().Validate(file);

        Assert.False(result.IsValid);
        Assert.Equal("corrupt_image", result.ErrorCode);
    }

    // Defecto de QA sobre M2.2-S04: la extensión del FileName declarado nunca se comparaba
    // contra el Content-Type declarado.

    [Fact]
    public void Validate_WhenFileNameExtensionDoesNotMatchDeclaredContentType_ReturnsExtensionMismatch()
    {
        var file = CreateFile(SampleImages.ValidPng1x1, "foo.txt", "image/png");

        var result = CreateValidator().Validate(file);

        Assert.False(result.IsValid);
        Assert.Equal("extension_mismatch", result.ErrorCode);
    }

    [Fact]
    public void Validate_WhenSvgFileNameHasPngExtension_ReturnsExtensionMismatch()
    {
        var file = CreateTextFile(ValidMinimalSvg, "imagen.png", "image/svg+xml");

        var result = CreateValidator().Validate(file);

        Assert.False(result.IsValid);
        Assert.Equal("extension_mismatch", result.ErrorCode);
    }

    [Fact]
    public void Validate_WhenJpegFileNameUsesTheAlternateJpegExtension_ReturnsSuccess()
    {
        var file = CreateFile(SampleImages.ValidJpegHeader32x16, "imagen.jpeg", "image/jpeg");

        var result = CreateValidator().Validate(file);

        Assert.True(result.IsValid);
    }

    // SVG: XML bien formado con raíz <svg>, parseo seguro (sin DTD/entidades externas).

    [Fact]
    public void Validate_WhenSvgIsNotWellFormedXml_ReturnsInvalidSvg()
    {
        var file = CreateTextFile("<svg><unclosed></svg>", "roto.svg", "image/svg+xml");

        var result = CreateValidator().Validate(file);

        Assert.False(result.IsValid);
        Assert.Equal("invalid_svg", result.ErrorCode);
    }

    [Fact]
    public void Validate_WhenXmlIsWellFormedButRootIsNotSvg_ReturnsInvalidSvg()
    {
        var file = CreateTextFile(WellFormedXmlButNotSvg, "noessvg.svg", "image/svg+xml");

        var result = CreateValidator().Validate(file);

        Assert.False(result.IsValid);
        Assert.Equal("invalid_svg", result.ErrorCode);
    }

    [Fact]
    public void Validate_WhenSvgAttemptsXxeViaExternalEntity_ReturnsInvalidSvgAndNeverResolvesIt()
    {
        var file = CreateTextFile(SvgWithXxeAttempt, "malicioso.svg", "image/svg+xml");

        // DtdProcessing.Prohibit hace que XmlReader lance ante el DOCTYPE -- nunca llega a
        // intentar resolver la entidad externa (XmlResolver = null de cualquier forma la
        // bloquearía). El resultado esperado es un rechazo controlado, no una excepción ni
        // una lectura de archivo real.
        var result = CreateValidator().Validate(file);

        Assert.False(result.IsValid);
        Assert.Equal("invalid_svg", result.ErrorCode);
    }

    [Fact]
    public void Validate_WhenSvgIsValid_ReturnsSuccess()
    {
        var file = CreateTextFile(ValidMinimalSvg, "imagen.svg", "image/svg+xml");

        var result = CreateValidator().Validate(file);

        Assert.True(result.IsValid);
        Assert.Equal("image/svg+xml", result.ContentType);
    }

    [Fact]
    public void Validate_WhenPngIsValid_ReturnsSuccess()
    {
        var file = CreateFile(SampleImages.ValidPng1x1, "imagen.png", "image/png");

        var result = CreateValidator().Validate(file);

        Assert.True(result.IsValid);
        Assert.Equal("image/png", result.ContentType);
    }

    [Fact]
    public void Validate_WhenJpegIsValid_ReturnsSuccess()
    {
        var file = CreateFile(SampleImages.ValidJpegHeader32x16, "imagen.jpg", "image/jpeg");

        var result = CreateValidator().Validate(file);

        Assert.True(result.IsValid);
        Assert.Equal("image/jpeg", result.ContentType);
    }

    [Fact]
    public void Validate_WhenWebpIsValid_ReturnsSuccess()
    {
        var file = CreateFile(SampleImages.ValidWebpVp8x100x200, "imagen.webp", "image/webp");

        var result = CreateValidator().Validate(file);

        Assert.True(result.IsValid);
        Assert.Equal("image/webp", result.ContentType);
    }
}

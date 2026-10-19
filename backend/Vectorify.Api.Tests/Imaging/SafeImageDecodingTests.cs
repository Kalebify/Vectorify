using Microsoft.AspNetCore.Http;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Formats;
using SixLabors.ImageSharp.Formats.Bmp;
using SixLabors.ImageSharp.Formats.Gif;
using SixLabors.ImageSharp.Formats.Tiff;
using SixLabors.ImageSharp.PixelFormats;
using Vectorify.Api.Assets;
using Vectorify.Api.Imaging;
using Vectorify.Api.Options;
using Vectorify.Api.Tests.TestSupport;
using Vectorify.Api.Validation;

namespace Vectorify.Api.Tests.Imaging;

/// <summary>
/// Mitigación de los avisos de SixLabors.ImageSharp 2.1.13 (M3.1-S09, hallazgo H-1): decodificación solo PNG/JPEG/WEBP (ningún contenido subido llega al código de TIFF, donde están tres de los
/// cinco avisos) y tope de píxeles leído de la cabecera antes de decodificar (bomba de descompresión).
/// </summary>
public sealed class SafeImageDecodingTests
{
    private static byte[] Encode(Action<Image<Rgba32>, Stream> save)
    {
        using var image = new Image<Rgba32>(4, 4, new Rgba32(10, 20, 30, 255));
        using var stream = new MemoryStream();
        save(image, stream);
        return stream.ToArray();
    }

    private static uint Crc32(ReadOnlySpan<byte> data)
    {
        var crc = 0xFFFFFFFFu;
        foreach (var b in data)
        {
            crc ^= b;
            for (var k = 0; k < 8; k++)
            {
                crc = (crc & 1) != 0 ? 0xEDB88320u ^ (crc >> 1) : crc >> 1;
            }
        }

        return ~crc;
    }

    /// <summary>PNG que SOLO declara dimensiones gigantes en la cabecera (firma + IHDR + IDAT vacío + IEND): ocupa unos 70 bytes y pediría gigabytes al decodificarse.</summary>
    private static byte[] PngDeclaring(uint width, uint height)
    {
        using var output = new MemoryStream();
        output.Write([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

        void Chunk(string type, byte[] data)
        {
            var length = new byte[4];
            System.Buffers.Binary.BinaryPrimitives.WriteUInt32BigEndian(length, (uint)data.Length);
            output.Write(length);
            var body = System.Text.Encoding.ASCII.GetBytes(type).Concat(data).ToArray();
            output.Write(body);
            var crc = new byte[4];
            System.Buffers.Binary.BinaryPrimitives.WriteUInt32BigEndian(crc, Crc32(body));
            output.Write(crc);
        }

        var header = new byte[13];
        System.Buffers.Binary.BinaryPrimitives.WriteUInt32BigEndian(header.AsSpan(0, 4), width);
        System.Buffers.Binary.BinaryPrimitives.WriteUInt32BigEndian(header.AsSpan(4, 4), height);
        header[8] = 8; // profundidad
        header[9] = 6; // RGBA
        Chunk("IHDR", header);
        Chunk("IDAT", [0x78, 0x9C, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01]);
        Chunk("IEND", []);
        return output.ToArray();
    }

    private static FormFile CreateFile(byte[] bytes, string fileName, string contentType)
    {
        var stream = new MemoryStream(bytes);
        return new FormFile(stream, 0, stream.Length, "file", fileName) { Headers = new HeaderDictionary(), ContentType = contentType };
    }

    // --------------------------------------------------------------------------------------------- solo PNG / JPEG / WEBP

    [Fact]
    public void RestrictedOptions_StillDecodeThePngAndJpegTheProductAccepts()
    {
        var png = SampleImages.ValidPng1x1;
        var jpeg = Encode((image, stream) => image.SaveAsJpeg(stream));

        using var decodedPng = Image.Load(SafeImageDecoding.Options, png);
        using var decodedJpeg = Image.Load(SafeImageDecoding.Options, jpeg);

        Assert.Equal(1, decodedPng.Width);
        Assert.Equal(4, decodedJpeg.Width);
    }

    [Fact]
    public void RestrictedOptions_NeverReachTheTiffGifBmpCode_EvenThoughTheDefaultConfigurationDecodesThem()
    {
        var tiff = Encode((image, stream) => image.SaveAsTiff(stream));
        var gif = Encode((image, stream) => image.SaveAsGif(stream));
        var bmp = Encode((image, stream) => image.SaveAsBmp(stream));

        foreach (var bytes in new[] { tiff, gif, bmp })
        {
            using (Image.Load(bytes))
            {
                // la configuración global SÍ los decodifica (es la superficie que se evita)
            }

            Assert.Throws<UnknownImageFormatException>(() => Image.Load(SafeImageDecoding.Options, bytes));
            Assert.Equal(PixelCheckResult.Unreadable, SafeImageDecoding.CheckPixelLimit(new MemoryStream(bytes), long.MaxValue));
        }
    }

    [Fact]
    public void TheUploadValidators_RejectATiffDeclaredAsPng_BeforeAnyDecoder()
    {
        var tiff = Encode((image, stream) => image.SaveAsTiff(stream));
        var upload = new ImageUploadValidator(Microsoft.Extensions.Options.Options.Create(new UploadOptions()));
        var asset = new AssetUploadValidator(Microsoft.Extensions.Options.Options.Create(new AssetOptions()));

        var uploadResult = upload.Validate(CreateFile(tiff, "x.png", "image/png"));
        var assetResult = asset.Validate(CreateFile(tiff, "x.png", "image/png"));

        Assert.False(uploadResult.IsValid);
        Assert.Equal("corrupt_file", uploadResult.ErrorCode);
        Assert.False(assetResult.IsValid);
        Assert.Equal("corrupt_image", assetResult.ErrorCode);
    }

    // ---------------------------------------------------------------------------------------------- tope de píxeles

    [Fact]
    public void CheckPixelLimit_ReadsOnlyTheHeader_AndRestoresTheStreamPosition()
    {
        var bomb = PngDeclaring(60_000, 60_000); // 3 600 Mpx declarados, ~70 bytes reales
        Assert.True(bomb.Length < 200);
        using var stream = new MemoryStream(bomb);

        var result = SafeImageDecoding.CheckPixelLimit(stream, SafeImageDecoding.DefaultMaxPixels);

        Assert.Equal(PixelCheckResult.TooLarge, result);
        Assert.Equal(0, stream.Position);
    }

    [Fact]
    public void CheckPixelLimit_AcceptsNormalImages_AndTheExactLimit()
    {
        using var stream = new MemoryStream(PngDeclaring(8000, 8000));
        Assert.Equal(PixelCheckResult.WithinLimit, SafeImageDecoding.CheckPixelLimit(stream, 64_000_000));
        Assert.Equal(PixelCheckResult.TooLarge, SafeImageDecoding.CheckPixelLimit(stream, 63_999_999));
        Assert.Equal(PixelCheckResult.WithinLimit, SafeImageDecoding.CheckPixelLimit(new MemoryStream(SampleImages.ValidPng1x1), 1));
    }

    [Fact]
    public void TheUploadValidators_RejectAnImageThatDeclaresTooManyPixels_WithoutDecodingIt()
    {
        var bomb = PngDeclaring(60_000, 60_000);
        var upload = new ImageUploadValidator(Microsoft.Extensions.Options.Options.Create(new UploadOptions()));
        var asset = new AssetUploadValidator(Microsoft.Extensions.Options.Options.Create(new AssetOptions()));

        var uploadResult = upload.Validate(CreateFile(bomb, "bomba.png", "image/png"));
        var assetResult = asset.Validate(CreateFile(bomb, "bomba.png", "image/png"));

        Assert.False(uploadResult.IsValid);
        Assert.Equal("file_too_large", uploadResult.ErrorCode);
        Assert.Contains("píxeles", uploadResult.ErrorMessage);
        Assert.False(assetResult.IsValid);
        Assert.Equal("file_too_large", assetResult.ErrorCode);
    }

    [Fact]
    public void TheLimit_IsConfigurable()
    {
        var png = Encode((image, stream) => image.SaveAsPng(stream)); // 4×4 = 16 px
        var strict = new ImageUploadValidator(Microsoft.Extensions.Options.Options.Create(new UploadOptions { MaxPixels = 15 }));
        var enough = new ImageUploadValidator(Microsoft.Extensions.Options.Options.Create(new UploadOptions { MaxPixels = 16 }));

        Assert.Equal("file_too_large", strict.Validate(CreateFile(png, "a.png", "image/png")).ErrorCode);
        Assert.True(enough.Validate(CreateFile(png, "a.png", "image/png")).IsValid);
    }

    [Fact]
    public void ACorruptFileWithAValidSignature_IsStillReportedAsCorrupt_NotAsTooLarge()
    {
        var truncated = SampleImages.ValidPng1x1.Take(20).ToArray();
        var upload = new ImageUploadValidator(Microsoft.Extensions.Options.Options.Create(new UploadOptions()));

        var result = upload.Validate(CreateFile(truncated, "x.png", "image/png"));

        Assert.False(result.IsValid);
        Assert.Equal("corrupt_file", result.ErrorCode);
    }

    [Fact]
    public void TheThumbnailGenerator_GivesUpOnAnImageOverTheLimit_WithoutThrowing()
    {
        var png = Encode((image, stream) => image.SaveAsPng(stream));

        Assert.Null(ThumbnailGenerator.TryCreate(new MemoryStream(png), maxPixels: 15));
        Assert.NotNull(ThumbnailGenerator.TryCreate(new MemoryStream(png), maxPixels: 16));
        Assert.Null(ThumbnailGenerator.TryCreate(new MemoryStream(PngDeclaring(60_000, 60_000))));
    }
}

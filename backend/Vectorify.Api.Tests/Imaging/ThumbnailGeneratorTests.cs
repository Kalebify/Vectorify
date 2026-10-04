using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Formats.Jpeg;
using SixLabors.ImageSharp.Formats.Png;
using SixLabors.ImageSharp.PixelFormats;
using Vectorify.Api.Imaging;
using Vectorify.Api.Tests.TestSupport;

namespace Vectorify.Api.Tests.Imaging;

/// <summary>Pruebas de <see cref="ThumbnailGenerator"/> (M2.2-S08): reducción a ≤ 320 px, sin agrandar, formato de salida y tolerancia a entradas no decodificables.</summary>
public sealed class ThumbnailGeneratorTests
{
    [Fact]
    public void TryCreate_LargePng_IsReducedToAtMost320PxOnTheLongestSide_PreservingAspectRatio()
    {
        using var source = new MemoryStream(EncodePng(1000, 500));

        var thumbnail = ThumbnailGenerator.TryCreate(source);

        Assert.NotNull(thumbnail);
        Assert.Equal("image/png", thumbnail!.ContentType);
        using var result = Image.Load(thumbnail.Content);
        Assert.Equal(320, result.Width);
        Assert.Equal(160, result.Height);
    }

    [Fact]
    public void TryCreate_TallImage_LimitsTheHeight()
    {
        using var source = new MemoryStream(EncodePng(200, 800));

        var thumbnail = ThumbnailGenerator.TryCreate(source);

        using var result = Image.Load(thumbnail!.Content);
        Assert.Equal(320, result.Height);
        Assert.Equal(80, result.Width);
    }

    [Fact]
    public void TryCreate_SmallImage_IsNeverEnlarged()
    {
        using var source = new MemoryStream(SampleImages.ValidPng1x1);

        var thumbnail = ThumbnailGenerator.TryCreate(source);

        Assert.NotNull(thumbnail);
        using var result = Image.Load(thumbnail!.Content);
        Assert.Equal(1, result.Width);
        Assert.Equal(1, result.Height);
    }

    [Fact]
    public void TryCreate_Jpeg_StaysJpeg()
    {
        using var source = new MemoryStream(EncodeJpeg(640, 480));

        var thumbnail = ThumbnailGenerator.TryCreate(source);

        Assert.NotNull(thumbnail);
        Assert.Equal("image/jpeg", thumbnail!.ContentType);
        using var result = Image.Load(thumbnail.Content);
        Assert.Equal(320, result.Width);
        Assert.Equal(240, result.Height);
    }

    [Fact]
    public void TryCreate_Webp_IsEncodedAsPng()
    {
        using var source = new MemoryStream(SampleImages.ValidWebpVp8x100x200);

        var thumbnail = ThumbnailGenerator.TryCreate(source);

        Assert.NotNull(thumbnail);
        Assert.Equal("image/png", thumbnail!.ContentType);
    }

    [Fact]
    public void TryCreate_NotAnImage_ReturnsNullWithoutThrowing()
    {
        using var source = new MemoryStream(SampleImages.NotAnImage);

        Assert.Null(ThumbnailGenerator.TryCreate(source));
    }

    [Fact]
    public void TryCreate_TruncatedImage_ReturnsNullWithoutThrowing()
    {
        using var source = new MemoryStream(SampleImages.TruncatedPng);

        Assert.Null(ThumbnailGenerator.TryCreate(source));
    }

    [Fact]
    public void TryCreate_EmptyStream_ReturnsNull()
    {
        using var source = new MemoryStream();

        Assert.Null(ThumbnailGenerator.TryCreate(source));
    }

    private static byte[] EncodePng(int width, int height)
    {
        using var image = new Image<Rgba32>(width, height, new Rgba32(10, 120, 200, 255));
        using var output = new MemoryStream();
        image.Save(output, new PngEncoder());
        return output.ToArray();
    }

    private static byte[] EncodeJpeg(int width, int height)
    {
        using var image = new Image<Rgb24>(width, height, new Rgb24(200, 30, 30));
        using var output = new MemoryStream();
        image.Save(output, new JpegEncoder());
        return output.ToArray();
    }
}

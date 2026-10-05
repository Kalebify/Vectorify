using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;

namespace Vectorify.Api.Tests.TestSupport;

/// <summary>
/// "Volumen" de datos en disco de un host de pruebas (M2.2-S10): un directorio temporal con la misma
/// disposición que <c>App_Data/</c> del contenedor (originales/assets en <c>uploads/</c> y un sidecar JSON por
/// cada registro clásico). Dos hosts consecutivos que apuntan al MISMO <see cref="PersistenceDataRoot"/> y a
/// la misma base Postgres reproducen un <c>docker compose down</c> + <c>up</c> que conserva los volúmenes:
/// ningún estado en memoria sobrevive entre uno y otro.
/// </summary>
internal sealed class PersistenceDataRoot : IDisposable
{
    private static readonly (string ConfigKey, string Folder)[] Folders =
    [
        ("Storage:RootPath", "uploads"),
        ("ProjectRegistry:RootPath", "projects"),
        ("ThresholdRegistry:RootPath", "thresholds"),
        ("VectorRegistry:RootPath", "vectors"),
        ("SimplificationRegistry:RootPath", "simplifications"),
        ("DimensionsRegistry:RootPath", "dimensions"),
        ("ColorPaletteRegistry:RootPath", "color-palettes"),
        ("VectorLayerRegistry:RootPath", "vector-layers"),
        ("ComponentRegistry:RootPath", "components"),
        ("ComponentGroupRegistry:RootPath", "component-groups"),
        ("PhysicalUnionRegistry:RootPath", "physical-unions"),
        ("ManufacturingOperationRegistry:RootPath", "manufacturing-operations"),
        ("LayerLayoutRegistry:RootPath", "layer-layout"),
    ];

    public PersistenceDataRoot(string label)
    {
        Path = System.IO.Path.Combine(
            System.IO.Path.GetTempPath(), $"vectorify-{label}-" + Guid.NewGuid().ToString("n"));
    }

    public string Path { get; }

    /// <summary>Equivalente al directorio de storage de assets/originales (<c>Storage:RootPath</c>).</summary>
    public string StoragePath => System.IO.Path.Combine(Path, "uploads");

    public Dictionary<string, string?> ToConfiguration() =>
        Folders.ToDictionary(f => f.ConfigKey, f => (string?)System.IO.Path.Combine(Path, f.Folder));

    public void Dispose()
    {
        if (Directory.Exists(Path))
        {
            Directory.Delete(Path, recursive: true);
        }
    }
}

/// <summary>Construcción de hosts reales de la Web API (WebApplicationFactory) para los tests de persistencia de M2.2-S10.</summary>
internal static class PersistenceHosts
{
    /// <summary>
    /// Levanta un host NUEVO de la Web API (DI real, sin sustituciones salvo las que pida
    /// <paramref name="configureServices"/>) sobre <paramref name="connectionString"/> y
    /// <paramref name="dataRoot"/>. Cada llamada construye una factory distinta: los singletons (registries,
    /// caches, IFileStorage) arrancan vacíos y releen todo del disco/la base, como un proceso recién iniciado.
    /// </summary>
    public static WebApplicationFactory<Program> Create(
        string connectionString,
        string pythonBaseUrl,
        PersistenceDataRoot dataRoot,
        Action<IServiceCollection>? configureServices = null) =>
        new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
        {
            builder.ConfigureAppConfiguration((_, config) =>
            {
                var values = dataRoot.ToConfiguration();
                values["Postgres:ConnectionString"] = connectionString;
                values["PythonEngine:BaseUrl"] = pythonBaseUrl;
                values["Cors:AllowedOrigins"] = "http://localhost:5173";
                config.AddInMemoryCollection(values);
            });

            if (configureServices is not null)
            {
                builder.ConfigureServices(configureServices);
            }
        });

    /// <summary>PNG RGBA real de franjas verticales de colores sólidos (original "multicolor" de los tests de persistencia).</summary>
    public static byte[] StripedPng(int width, int height, params Rgba32[] colors)
    {
        using var image = new Image<Rgba32>(width, height);
        for (var y = 0; y < height; y++)
        {
            for (var x = 0; x < width; x++)
            {
                image[x, y] = colors[Math.Min(colors.Length - 1, x * colors.Length / width)];
            }
        }

        using var stream = new MemoryStream();
        image.SaveAsPng(stream);
        return stream.ToArray();
    }
}

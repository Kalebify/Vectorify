using System.Net;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Vectorify.Api.Tests.TestSupport;

/// <summary>
/// Servidor Kestrel con respuestas simuladas de POST /api/v1/preprocess y
/// POST /api/v1/threshold; no ejecuta el motor Python real ni OpenCV.
/// `respond`/`respondThreshold`/`respondVectorize`/`respondSimplify`/`respondCheck` reciben el número de
/// solicitud (1-based, por endpoint) y devuelven (statusCode, body JSON), lo
/// que permite probar el cache de la Web API (una segunda solicitud con los
/// mismos parámetros no debería llegar acá). `respondThreshold`/
/// `respondVectorize`/`respondSimplify`/`respondCheck` son opcionales (default: éxito genérico) para no romper
/// los tests de sprints anteriores que solo ejercitan preprocess/threshold/vectorize/simplify.
/// </summary>
public sealed class FakePythonPreprocessServer : IAsyncDisposable
{
    private readonly WebApplication _app;
    private int _requestCount;
    private int _thresholdRequestCount;
    private int _vectorizeRequestCount;
    private int _simplifyRequestCount;
    private int _checkRequestCount;
    private int _colorPaletteRequestCount;
    private int _vectorizeLayersRequestCount;
    private int _componentsRequestCount;

    public string BaseUrl { get; private set; } = string.Empty;
    public int RequestCount => _requestCount;
    public int ThresholdRequestCount => _thresholdRequestCount;
    public int VectorizeRequestCount => _vectorizeRequestCount;
    public int SimplifyRequestCount => _simplifyRequestCount;
    public int CheckRequestCount => _checkRequestCount;
    public int ColorPaletteRequestCount => _colorPaletteRequestCount;
    public int VectorizeLayersRequestCount => _vectorizeLayersRequestCount;
    public int ComponentsRequestCount => _componentsRequestCount;

    /// <summary>Campo <c>params</c> (JSON) de la última petición a /api/v1/color-palette.</summary>
    public string? LastColorPaletteParams { get; private set; }

    /// <summary>Si la última petición a /api/v1/vectorize-layers pidió fronteras compartidas.</summary>
    public bool? LastVectorizeLayersSharedBoundaries { get; private set; }

    private FakePythonPreprocessServer(WebApplication app)
    {
        _app = app;
    }

    public static async Task<FakePythonPreprocessServer> StartAsync(
        Func<int, (int StatusCode, string Body)> respond,
        Func<int, (int StatusCode, string Body)>? respondThreshold = null,
        Func<int, (int StatusCode, string Body)>? respondVectorize = null,
        Func<int, (int StatusCode, string Body)>? respondSimplify = null,
        Func<int, (int StatusCode, string Body)>? respondCheck = null,
        Func<int, (int StatusCode, string Body)>? respondColorPalette = null,
        Func<int, IReadOnlyList<string>, (int StatusCode, string Body)>? respondVectorizeLayers = null,
        Func<int, (int StatusCode, string Body)>? respondComponents = null)
    {
        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.ConfigureKestrel(options => options.Listen(IPAddress.Loopback, 0));
        var app = builder.Build();

        var server = new FakePythonPreprocessServer(app);

        app.MapPost("/api/v1/preprocess", async context =>
        {
            var count = Interlocked.Increment(ref server._requestCount);
            var (statusCode, body) = respond(count);
            context.Response.StatusCode = statusCode;
            context.Response.ContentType = "application/json";
            await context.Response.WriteAsync(body, context.RequestAborted);
        });

        app.MapPost("/api/v1/threshold", async context =>
        {
            var count = Interlocked.Increment(ref server._thresholdRequestCount);
            var (statusCode, body) = (respondThreshold ?? (_ => (200, ThresholdPayloads.SuccessBody())))(count);
            context.Response.StatusCode = statusCode;
            context.Response.ContentType = "application/json";
            await context.Response.WriteAsync(body, context.RequestAborted);
        });

        app.MapPost("/api/v1/vectorize", async context =>
        {
            var count = Interlocked.Increment(ref server._vectorizeRequestCount);
            var (statusCode, body) = (respondVectorize ?? (_ => (200, VectorizePayloads.SuccessBody())))(count);
            context.Response.StatusCode = statusCode;
            context.Response.ContentType = "application/json";
            await context.Response.WriteAsync(body, context.RequestAborted);
        });

        app.MapPost("/api/v1/simplify", async context =>
        {
            var count = Interlocked.Increment(ref server._simplifyRequestCount);
            var (statusCode, body) = (respondSimplify ?? (_ => (200, SimplifyPayloads.SuccessBody())))(count);
            context.Response.StatusCode = statusCode;
            context.Response.ContentType = "application/json";
            await context.Response.WriteAsync(body, context.RequestAborted);
        });

        app.MapPost("/api/v1/color-palette", async context =>
        {
            var count = Interlocked.Increment(ref server._colorPaletteRequestCount);
            var paletteForm = await context.Request.ReadFormAsync(context.RequestAborted);
            server.LastColorPaletteParams = paletteForm["params"].ToString();
            var (statusCode, body) = (respondColorPalette ?? (_ => (200, ColorPalettePayloads.SuccessBody())))(count);
            context.Response.StatusCode = statusCode;
            context.Response.ContentType = "application/json";
            await context.Response.WriteAsync(body, context.RequestAborted);
        });

        app.MapPost("/api/v1/vectorize-layers", async context =>
        {
            var count = Interlocked.Increment(ref server._vectorizeLayersRequestCount);
            var form = await context.Request.ReadFormAsync(context.RequestAborted);
            var groupIdsJson = form["group_ids"].ToString();
            server.LastVectorizeLayersSharedBoundaries = form["shared_boundaries"].ToString() == "true";
            var groupIds = string.IsNullOrEmpty(groupIdsJson)
                ? new List<string>()
                : System.Text.Json.JsonSerializer.Deserialize<List<string>>(groupIdsJson) ?? new List<string>();

            var (statusCode, body) = respondVectorizeLayers is not null
                ? respondVectorizeLayers(count, groupIds)
                : (200, DefaultVectorizeLayersSuccessBody(groupIds));

            context.Response.StatusCode = statusCode;
            context.Response.ContentType = "application/json";
            await context.Response.WriteAsync(body, context.RequestAborted);
        });

        app.MapPost("/api/v1/components", async context =>
        {
            var count = Interlocked.Increment(ref server._componentsRequestCount);
            var (statusCode, body) = (respondComponents ?? (_ => (200, ComponentPayloads.SuccessBody())))(count);
            context.Response.StatusCode = statusCode;
            context.Response.ContentType = "application/json";
            await context.Response.WriteAsync(body, context.RequestAborted);
        });

        app.MapPost("/api/v1/check", async context =>
        {
            var count = Interlocked.Increment(ref server._checkRequestCount);
            var (statusCode, body) = (respondCheck ?? (_ => (200, CheckPayloads.SuccessBody())))(count);
            context.Response.StatusCode = statusCode;
            context.Response.ContentType = "application/json";
            await context.Response.WriteAsync(body, context.RequestAborted);
        });

        try
        {
            await app.StartAsync();
            var addresses = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!;
            server.BaseUrl = addresses.Addresses.Single();
            return server;
        }
        catch
        {
            await app.DisposeAsync();
            throw;
        }
    }

    /// <summary>Un layer por cada group_id RECIBIDO (mismo criterio "eco" que el motor Python real) -- necesario porque PythonVectorLayerClient valida que los group_id devueltos coincidan exactamente con los enviados (GUIDs generados server-side, no predecibles de antemano por el test).</summary>
    private static string DefaultVectorizeLayersSuccessBody(IReadOnlyList<string> groupIds) =>
        $$"""{"layers": [{{string.Join(",", groupIds.Select(id => VectorizeLayersPayloads.LayerJson(id)))}}]}""";

    public async ValueTask DisposeAsync()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        try
        {
            await _app.StopAsync(timeout.Token);
        }
        finally
        {
            await _app.DisposeAsync();
        }
    }
}

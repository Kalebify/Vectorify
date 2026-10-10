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
/// Motor Python simulado SOLO para el servicio de geometría (M3-S04, M3-S09): Kestrel en loopback con POST /api/v1/geometry/boolean y
/// /api/v1/geometry/offset (la misma respuesta para ambas rutas: cada test levanta el suyo y solo llama a una).
/// No calcula geometría (eso lo prueban services/python-engine/tests con Shapely real): devuelve lo que el test le pida y
/// registra cuántas veces lo llamaron y con qué cuerpo, para verificar que una petición inválida NUNCA llega a Python.
/// </summary>
public sealed class FakePythonGeometryServer : IAsyncDisposable
{
    private readonly WebApplication _app;
    private readonly List<string> _bodies = [];
    private readonly List<string> _paths = [];
    private readonly object _lock = new();

    public string BaseUrl { get; }

    public int RequestCount
    {
        get { lock (_lock) { return _bodies.Count; } }
    }

    /// <summary>Ruta de cada petición recibida (para verificar que offset y booleanas llegan a la ruta correcta de Python).</summary>
    public IReadOnlyList<string> Paths
    {
        get { lock (_lock) { return [.. _paths]; } }
    }

    public IReadOnlyList<string> Bodies
    {
        get { lock (_lock) { return [.. _bodies]; } }
    }

    private FakePythonGeometryServer(WebApplication app, string baseUrl)
    {
        _app = app;
        BaseUrl = baseUrl;
    }

    public static async Task<FakePythonGeometryServer> StartAsync(
        Func<string, (int StatusCode, string Body)> respond, TimeSpan? delay = null)
    {
        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.ConfigureKestrel(options => options.Listen(IPAddress.Loopback, 0));
        var app = builder.Build();
        FakePythonGeometryServer? server = null;

        RequestDelegate handler = async context =>
        {
            using var reader = new StreamReader(context.Request.Body);
            var body = await reader.ReadToEndAsync(context.RequestAborted);
            lock (server!._lock)
            {
                server._bodies.Add(body);
                server._paths.Add(context.Request.Path.Value ?? string.Empty);
            }

            if (delay is { } duration)
            {
                await Task.Delay(duration, context.RequestAborted);
            }

            var (statusCode, responseBody) = respond(body);
            context.Response.StatusCode = statusCode;
            context.Response.ContentType = "application/json";
            await context.Response.WriteAsync(responseBody, context.RequestAborted);
        };
        app.MapPost("/api/v1/geometry/boolean", handler);
        app.MapPost("/api/v1/geometry/offset", handler);

        try
        {
            await app.StartAsync();
            var addresses = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!;
            server = new FakePythonGeometryServer(app, addresses.Addresses.Single());
            return server;
        }
        catch
        {
            await app.DisposeAsync();
            throw;
        }
    }

    public async ValueTask DisposeAsync()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        try { await _app.StopAsync(timeout.Token); }
        finally { await _app.DisposeAsync(); }
    }
}

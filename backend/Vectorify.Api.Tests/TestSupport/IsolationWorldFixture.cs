using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Vectorify.Api.Contracts;
using Vectorify.Api.Endpoints;

namespace Vectorify.Api.Tests.TestSupport;

/// <summary>Una persona REAL del sistema: cuenta registrada por <c>/register</c> y sesión abierta por <c>/login</c>; la cookie la emitió el servidor.</summary>
public sealed record TestUser(Guid Id, string Email, HttpClient Client);

/// <summary>Todo lo que un usuario tiene en el sistema: su flujo clásico completo y su proyecto v2 guardado (documento, capas, asset).</summary>
public sealed record IsolationWorld(
    Guid ProjectId,
    Guid AssetId,
    Guid LayerGroupId,
    ClassicWorkspaceSession Classic,
    IReadOnlyList<Guid> VectorIds,
    string IdempotencyKey,
    string Name)
{
    public string ClassicBase => $"/api/v1/projects/{Classic.ProjectId}/images/{Classic.ImageId}";

    public static async Task<IsolationWorld> CreateAsync(HttpClient client, string name)
    {
        var classic = await ClassicWorkspaceFlow.RunAsync(client);

        var layers = (await client.GetFromJsonAsync<VectorLayerSetResponse>(
            $"/api/v1/projects/{classic.ProjectId}/images/{classic.ImageId}/color-palette/{classic.PaletteId}/layers"))!;

        var idempotencyKey = Guid.NewGuid().ToString("n");
        var saveResponse = await client.PostAsJsonAsync("/api/v2/workspaces/save", classic.ToSaveRequest(null, name, idempotencyKey));
        Assert.Equal(HttpStatusCode.Created, saveResponse.StatusCode);
        var saved = (await saveResponse.Content.ReadFromJsonAsync<VectorDocumentSaveResponse>())!;

        var document = (await client.GetFromJsonAsync<VectorDocumentResponse>($"/api/v2/projects/{saved.ProjectId}/document"))!;
        var layer = document.Layers.First();
        return new IsolationWorld(
            saved.ProjectId, layer.SvgAssetId!.Value, layer.Id, classic, layers.Layers.Select(l => l.VectorId).ToList(), idempotencyKey, name);
    }
}

/// <summary>
/// Escenario compartido de la suite de aislamiento de M3.1-S06: Postgres real (Testcontainers), la Web API real en
/// <c>Auth:Mode=Authenticated</c>, un motor Python simulado y TRES cuentas reales (A, B, C) creadas por <c>/register</c> + <c>/login</c> (cookies
/// emitidas por el servidor, cada cliente con su propio cookie jar y la cabecera anti-CSRF). A y B tienen su mundo completo creado y los tests
/// «de B contra A» no lo mutan (si lo hicieran, ese sería el fallo); C es para tests que SÍ ejecutan etapas con su propio recurso.
/// </summary>
public sealed class IsolationWorldFixture : IAsyncLifetime
{
    public const string Password = "una-contrasena-larga-1";

    private readonly AuthApiFixture _database = new();
    private FakePythonPreprocessServer? _python;

    public AuthApiFixture Database => _database;

    public string ConnectionString { get; private set; } = string.Empty;

    public WebApplicationFactory<Program> Factory { get; private set; } = null!;

    /// <summary>Cliente SIN sesión (pero con la cabecera anti-CSRF, para que el 401 lo decida la autorización y no el CsrfGuard).</summary>
    public HttpClient Anonymous { get; private set; } = null!;

    public TestUser A { get; private set; } = null!;

    public TestUser B { get; private set; } = null!;

    public TestUser C { get; private set; } = null!;

    public IsolationWorld WorldA { get; private set; } = null!;

    public IsolationWorld WorldB { get; private set; } = null!;

    public async Task InitializeAsync()
    {
        await _database.InitializeAsync();
        ConnectionString = await _database.CreateDatabaseAsync();
        _python = await StartPythonAsync();
        Factory = CreateAuthenticatedFactory(_database, ConnectionString, _python.BaseUrl);

        Anonymous = Factory.CreateClient().WithCsrf();
        A = await SignInAsync(Factory);
        B = await SignInAsync(Factory);
        C = await SignInAsync(Factory);
        WorldA = await IsolationWorld.CreateAsync(A.Client, "Proyecto secreto de A");
        WorldB = await IsolationWorld.CreateAsync(B.Client, "Proyecto secreto de B");
    }

    public async Task DisposeAsync()
    {
        foreach (var client in new[] { Anonymous, A?.Client, B?.Client, C?.Client })
        {
            client?.Dispose();
        }

        if (Factory is not null)
        {
            await Factory.DisposeAsync();
        }

        if (_python is not null)
        {
            await _python.DisposeAsync();
        }

        await _database.DisposeAsync();
    }

    public static Task<FakePythonPreprocessServer> StartPythonAsync() =>
        FakePythonPreprocessServer.StartAsync(_ => (200, "{}"), respondColorPalette: _ => (200, ColorPalettePayloads.SuccessBody()));

    /// <summary>La Web API en modo Authenticated con la revalidación del SecurityStamp en 0 (determinista, como los demás tests de auth).</summary>
    public static WebApplicationFactory<Program> CreateAuthenticatedFactory(
        AuthApiFixture database,
        string connectionString,
        string pythonBaseUrl,
        Microsoft.Extensions.Logging.ILoggerProvider? logProvider = null,
        Action<Microsoft.Extensions.DependencyInjection.IServiceCollection>? configureServices = null) =>
        database.CreateFactory(
            connectionString,
            authenticated: true,
            logProvider: logProvider,
            configureServices: configureServices,
            settings: new Dictionary<string, string?>
            {
                ["PythonEngine:BaseUrl"] = pythonBaseUrl,
                ["Auth:Session:RevalidationInterval"] = "00:00:00",
            });

    /// <summary>Registra una cuenta nueva por HTTP, inicia sesión y devuelve el cliente con la cookie que emitió el servidor.</summary>
    public static async Task<TestUser> SignInAsync(WebApplicationFactory<Program> factory)
    {
        var client = factory.CreateClient().WithCsrf();
        var email = $"user-{Guid.NewGuid():N}@vectorify.test";

        var register = await client.PostAsJsonAsync(AuthEndpoints.RegisterPath, new RegisterRequest(email, Password));
        Assert.Equal(HttpStatusCode.Accepted, register.StatusCode);
        var login = await client.PostAsJsonAsync(AuthEndpoints.LoginPath, new LoginRequest(email, Password));
        Assert.Equal(HttpStatusCode.OK, login.StatusCode);
        var user = (await login.Content.ReadFromJsonAsync<CurrentUserResponse>())!;
        return new TestUser(user.Id, email, client);
    }
}

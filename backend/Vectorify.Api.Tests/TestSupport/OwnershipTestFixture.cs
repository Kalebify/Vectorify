using System.Net.Http.Json;
using System.Security.Claims;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Testcontainers.PostgreSql;
using Vectorify.Api.Contracts;
using Vectorify.Api.Data;
using Vectorify.Api.Users;

namespace Vectorify.Api.Tests.TestSupport;

/// <summary>
/// Infraestructura de M2.2-S09 para correr la API real "como Usuario A" y "como Usuario B"
/// contra la MISMA base PostgreSQL (Testcontainers, nunca InMemory) y el MISMO storage. Hay dos
/// mecanismos, ambos con el DI real de la Web API:
/// <list type="bullet">
/// <item><see cref="CreateFactory"/> con <c>simulatedAuthentication: true</c> (default): reemplaza
/// <see cref="DevelopmentUserContext"/> por <see cref="SimulatedAuthenticatedUserContext"/> (el
/// doble de test de un <c>AuthenticatedUserContext</c> de MVP 3.1) y cada cliente de
/// <see cref="CreateClientFor"/> se identifica con un header de prueba. Una sola factory sirve a
/// A y a B a la vez, así comparten también los registries clásicos en memoria.</item>
/// <item><see cref="CreateFactory"/> con <c>developmentUserId</c>: mantiene el
/// <see cref="DevelopmentUserContext"/> real y fija <c>DevelopmentUser:UserId</c> por
/// configuración (una factory por usuario, contra la misma base).</item>
/// </list>
/// Se usa como <c>IClassFixture</c>: un único container Postgres por clase de tests (los tests
/// aíslan sus datos usando usuarios nuevos, nunca contando filas globales).
/// </summary>
public sealed class OwnershipTestFixture : IAsyncLifetime
{
    private readonly PostgreSqlContainer _postgres = new PostgreSqlBuilder("postgres:17-alpine").Build();

    public string StorageRoot { get; } =
        Path.Combine(Path.GetTempPath(), "vectorify-ownership-tests-" + Guid.NewGuid().ToString("n"));

    public string ProjectRegistryRoot { get; } =
        Path.Combine(Path.GetTempPath(), "vectorify-ownership-tests-registry-" + Guid.NewGuid().ToString("n"));

    public string ConnectionString => _postgres.GetConnectionString();

    public Task InitializeAsync() => _postgres.StartAsync();

    public async Task DisposeAsync()
    {
        foreach (var directory in new[] { StorageRoot, ProjectRegistryRoot })
        {
            if (Directory.Exists(directory))
            {
                Directory.Delete(directory, recursive: true);
            }
        }

        await _postgres.DisposeAsync();
    }

    public WebApplicationFactory<Program> CreateFactory(
        string pythonBaseUrl, bool simulatedAuthentication = true, Guid? developmentUserId = null) =>
        new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
        {
            builder.ConfigureAppConfiguration((_, config) =>
            {
                var values = new Dictionary<string, string?>
                {
                    ["Postgres:ConnectionString"] = ConnectionString,
                    ["PythonEngine:BaseUrl"] = pythonBaseUrl,
                    ["Cors:AllowedOrigins"] = "http://localhost:5173",
                    ["Storage:RootPath"] = StorageRoot,
                    ["ProjectRegistry:RootPath"] = ProjectRegistryRoot,
                };

                if (developmentUserId is { } userId)
                {
                    values["DevelopmentUser:UserId"] = userId.ToString();
                    values["DevelopmentUser:Email"] = $"{userId:N}@vectorify.test";
                }

                config.AddInMemoryCollection(values);
            });

            if (simulatedAuthentication)
            {
                builder.ConfigureServices(services =>
                {
                    services.AddHttpContextAccessor();
                    services.RemoveAll<IUserContext>();
                    services.AddScoped<IUserContext, SimulatedAuthenticatedUserContext>();
                });
            }
        });

    /// <summary>Cliente HTTP que se identifica como <paramref name="userId"/> ante <see cref="SimulatedAuthenticatedUserContext"/>.</summary>
    public static HttpClient CreateClientFor(WebApplicationFactory<Program> factory, Guid userId)
    {
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Add(SimulatedAuthenticatedUserContext.UserIdHeader, userId.ToString());
        client.DefaultRequestHeaders.Add(SimulatedAuthenticatedUserContext.EmailHeader, $"{userId:N}@vectorify.test");
        return client;
    }

    /// <summary>Crea (si no existe) la fila <c>users</c> de <paramref name="userId"/> -- la FK Project.OwnerId -&gt; Users.Id la exige (en producción la crearía el login de MVP 3.1).</summary>
    public static async Task EnsureUserAsync(WebApplicationFactory<Program> factory, Guid userId)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var dbContext = scope.ServiceProvider.GetRequiredService<VectorizationDbContext>();
        if (await dbContext.Users.AnyAsync(u => u.Id == userId))
        {
            return;
        }

        dbContext.Users.Add(new User
        {
            Id = userId,
            Email = $"{userId:N}@vectorify.test",
            DisplayName = $"Usuario de prueba {userId:N}",
            CreatedAt = DateTimeOffset.UtcNow,
        });
        await dbContext.SaveChangesAsync();
    }

    /// <summary>Crea un usuario nuevo en la base y devuelve un cliente identificado como él.</summary>
    public static async Task<(Guid UserId, HttpClient Client)> CreateUserWithClientAsync(WebApplicationFactory<Program> factory)
    {
        var userId = Guid.NewGuid();
        await EnsureUserAsync(factory, userId);
        return (userId, CreateClientFor(factory, userId));
    }
}

/// <summary>
/// Doble de test de un <c>AuthenticatedUserContext</c> (MVP 3.1): resuelve Id/Email/
/// IsAuthenticated desde un <see cref="ClaimsPrincipal"/> simulado (armado a partir de headers
/// de prueba) en vez del usuario fijo de <see cref="DevelopmentUserContext"/>. Sirve para
/// demostrar el DoD de M2.2-S09: intercambiar la implementación de <see cref="IUserContext"/>
/// no requiere tocar Project/Asset/VectorDocument.
/// </summary>
public sealed class SimulatedAuthenticatedUserContext : IUserContext
{
    public const string UserIdHeader = "X-Test-User-Id";
    public const string EmailHeader = "X-Test-User-Email";

    private readonly IHttpContextAccessor _httpContextAccessor;
    private ClaimsPrincipal? _principal;

    public SimulatedAuthenticatedUserContext(IHttpContextAccessor httpContextAccessor)
    {
        _httpContextAccessor = httpContextAccessor;
    }

    private ClaimsPrincipal Principal => _principal ??= BuildPrincipal();

    public Guid GetEffectiveUserId() =>
        Guid.TryParse(Principal.FindFirstValue(ClaimTypes.NameIdentifier), out var userId)
            ? userId
            : throw new InvalidOperationException("Request sin identidad de prueba (falta el header X-Test-User-Id).");

    public string? Email => Principal.FindFirstValue(ClaimTypes.Email);

    public bool IsAuthenticated => Principal.Identity?.IsAuthenticated == true;

    private ClaimsPrincipal BuildPrincipal()
    {
        var headers = _httpContextAccessor.HttpContext?.Request.Headers;
        var userId = headers?[UserIdHeader].FirstOrDefault();
        if (string.IsNullOrWhiteSpace(userId))
        {
            return new ClaimsPrincipal(new ClaimsIdentity());
        }

        var claims = new List<Claim> { new(ClaimTypes.NameIdentifier, userId) };
        var email = headers![EmailHeader].FirstOrDefault();
        if (!string.IsNullOrWhiteSpace(email))
        {
            claims.Add(new Claim(ClaimTypes.Email, email));
        }

        return new ClaimsPrincipal(new ClaimsIdentity(claims, authenticationType: "TestAuthentication"));
    }
}

/// <summary>Triple clásico (upload -&gt; paleta confirmada -&gt; capas) listo para guardar en v2.</summary>
public sealed record ClassicWorkspaceSession(Guid ProjectId, Guid ImageId, Guid PaletteId, int PaletteVersion, IReadOnlyList<Guid> LayerGroupIds)
{
    public VectorDocumentSaveRequest ToSaveRequest(Guid? projectId, string? name, string? idempotencyKey = null) =>
        new(projectId, name, ProjectId, ImageId, PaletteId, PaletteVersion, DimensionId: null, IdempotencyKey: idempotencyKey);
}

/// <summary>Recorre el flujo clásico (upload -&gt; detect -&gt; confirm -&gt; layers) contra la Web API real, como el usuario del <see cref="HttpClient"/> recibido.</summary>
public static class ClassicWorkspaceFlow
{
    public static async Task<UploadImageResponse> UploadAsync(HttpClient client, string? idempotencyKey = null)
    {
        using var content = new MultipartFormDataContent();
        var fileContent = new ByteArrayContent(SampleImages.ValidPng1x1);
        fileContent.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("image/png");
        content.Add(fileContent, "file", "logo.png");

        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/projects") { Content = content };
        if (idempotencyKey is not null)
        {
            request.Headers.Add("Idempotency-Key", idempotencyKey);
        }

        var response = await client.SendAsync(request);
        response.EnsureSuccessStatusCode();
        return (await response.Content.ReadFromJsonAsync<UploadImageResponse>())!;
    }

    public static async Task<ClassicWorkspaceSession> RunAsync(HttpClient client)
    {
        var upload = await UploadAsync(client);

        var detectResponse = await client.PostAsJsonAsync(
            $"/api/v1/projects/{upload.ProjectId}/images/{upload.ImageId}/color-palette/detect",
            new ColorPaletteDetectRequest(null, null, null));
        detectResponse.EnsureSuccessStatusCode();
        var palette = await detectResponse.Content.ReadFromJsonAsync<ColorPaletteResponse>();

        var confirmResponse = await client.PostAsync(
            $"/api/v1/projects/{upload.ProjectId}/images/{upload.ImageId}/color-palette/{palette!.PaletteId}/confirm", null);
        confirmResponse.EnsureSuccessStatusCode();

        var layersResponse = await client.PostAsync(
            $"/api/v1/projects/{upload.ProjectId}/images/{upload.ImageId}/color-palette/{palette.PaletteId}/layers", null);
        layersResponse.EnsureSuccessStatusCode();
        var layerSet = await layersResponse.Content.ReadFromJsonAsync<VectorLayerSetResponse>();

        return new ClassicWorkspaceSession(
            upload.ProjectId, upload.ImageId, palette.PaletteId, palette.Version,
            layerSet!.Layers.Select(layer => layer.GroupId).ToList());
    }
}

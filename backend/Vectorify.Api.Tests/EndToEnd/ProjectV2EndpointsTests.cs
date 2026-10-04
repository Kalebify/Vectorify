using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Testcontainers.PostgreSql;
using Vectorify.Api.Contracts;
using Vectorify.Api.Data;

namespace Vectorify.Api.Tests.EndToEnd;

/// <summary>
/// Pruebas de integración HTTP de la API CRUD NUEVA de proyectos persistentes
/// (M2.2-S03), bajo /api/v2/projects: levantan la Web API real (WebApplicationFactory)
/// contra PostgreSQL real (Testcontainers, nunca InMemory). Cubre el contrato HTTP
/// completo (status codes, shape de las respuestas, DTOs versionados) -- la lógica
/// detallada de paginación/orden/duplicate/concurrencia ya la cubre
/// Vectorify.Api.Tests.Projects.Persistence.ProjectRepositoryTests contra el repositorio
/// directamente.
/// </summary>
public sealed class ProjectV2EndpointsTests : IAsyncLifetime
{
    private readonly PostgreSqlContainer _postgres = new PostgreSqlBuilder("postgres:17-alpine").Build();

    public Task InitializeAsync() => _postgres.StartAsync();

    public Task DisposeAsync() => _postgres.DisposeAsync().AsTask();

    [Fact]
    public async Task PostProjects_WithValidName_CreatesProject()
    {
        await using var factory = CreateFactory();
        var client = factory.CreateClient();

        var response = await client.PostAsJsonAsync(
            "/api/v2/projects", new CreateProjectRequest("Placa grabada", "Una descripción"));

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<ProjectResponse>();
        Assert.NotNull(body);
        Assert.NotEqual(Guid.Empty, body!.Id);
        Assert.Equal("Placa grabada", body.Name);
        Assert.Equal("Una descripción", body.Description);
        Assert.NotNull(response.Headers.Location);
    }

    [Fact]
    public async Task PostProjects_WithEmptyName_ReturnsBadRequest()
    {
        await using var factory = CreateFactory();
        var client = factory.CreateClient();

        var response = await client.PostAsJsonAsync("/api/v2/projects", new CreateProjectRequest("   ", null));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var error = await response.Content.ReadFromJsonAsync<ApiErrorResponse>();
        Assert.Equal("invalid_name", error!.Code);
    }

    [Fact]
    public async Task GetProject_WhenItExists_ReturnsIt()
    {
        await using var factory = CreateFactory();
        var client = factory.CreateClient();
        var created = await CreateProjectAsync(client, "Mi proyecto");

        var response = await client.GetAsync($"/api/v2/projects/{created.Id}");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<ProjectResponse>();
        Assert.Equal(created.Id, body!.Id);
        Assert.Equal("Mi proyecto", body.Name);
    }

    [Fact]
    public async Task GetProject_WhenIdDoesNotExist_ReturnsNotFound()
    {
        await using var factory = CreateFactory();
        var client = factory.CreateClient();

        var response = await client.GetAsync($"/api/v2/projects/{Guid.NewGuid()}");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        var error = await response.Content.ReadFromJsonAsync<ApiErrorResponse>();
        Assert.Equal("not_found", error!.Code);
    }

    [Fact]
    public async Task GetPatchDelete_WhenProjectBelongsToAnotherOwner_AllReturnNotFound()
    {
        await using var factory = CreateFactory();
        var client = factory.CreateClient();

        var foreignProjectId = await SeedProjectForAnotherOwnerAsync(factory, "Proyecto ajeno");

        var getResponse = await client.GetAsync($"/api/v2/projects/{foreignProjectId}");
        Assert.Equal(HttpStatusCode.NotFound, getResponse.StatusCode);

        var patchResponse = await client.PatchAsJsonAsync(
            $"/api/v2/projects/{foreignProjectId}", new UpdateProjectRequest("Nombre nuevo", null));
        Assert.Equal(HttpStatusCode.NotFound, patchResponse.StatusCode);

        var deleteResponse = await client.DeleteAsync($"/api/v2/projects/{foreignProjectId}");
        Assert.Equal(HttpStatusCode.NotFound, deleteResponse.StatusCode);
    }

    [Fact]
    public async Task PatchProject_RenamesIt()
    {
        await using var factory = CreateFactory();
        var client = factory.CreateClient();
        var created = await CreateProjectAsync(client, "Nombre original");

        var response = await client.PatchAsJsonAsync(
            $"/api/v2/projects/{created.Id}", new UpdateProjectRequest("Nombre renombrado", "Nueva descripción"));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<ProjectResponse>();
        Assert.Equal("Nombre renombrado", body!.Name);
        Assert.Equal("Nueva descripción", body.Description);
    }

    [Fact]
    public async Task DeleteProject_SoftDeletesIt_SoItNoLongerAppearsInGetOrList()
    {
        await using var factory = CreateFactory();
        var client = factory.CreateClient();
        var created = await CreateProjectAsync(client, "Proyecto a borrar");

        var deleteResponse = await client.DeleteAsync($"/api/v2/projects/{created.Id}");
        Assert.Equal(HttpStatusCode.NoContent, deleteResponse.StatusCode);

        var getResponse = await client.GetAsync($"/api/v2/projects/{created.Id}");
        Assert.Equal(HttpStatusCode.NotFound, getResponse.StatusCode);

        var listResponse = await client.GetAsync("/api/v2/projects");
        var listBody = await listResponse.Content.ReadFromJsonAsync<ProjectListResponse>();
        Assert.DoesNotContain(listBody!.Items, p => p.Id == created.Id);
    }

    [Fact]
    public async Task PostDuplicate_CreatesNewProjectWithCopyPrefixAndDistinctId()
    {
        await using var factory = CreateFactory();
        var client = factory.CreateClient();
        var created = await CreateProjectAsync(client, "Original", "Descripción original");

        var response = await client.PostAsync($"/api/v2/projects/{created.Id}/duplicate", content: null);

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<ProjectResponse>();
        Assert.NotNull(body);
        Assert.NotEqual(created.Id, body!.Id);
        Assert.Equal("Copia de Original", body.Name);
        Assert.Equal("Descripción original", body.Description);
    }

    [Fact]
    public async Task PostDuplicate_WhenIdDoesNotExist_ReturnsNotFound()
    {
        await using var factory = CreateFactory();
        var client = factory.CreateClient();

        var response = await client.PostAsync($"/api/v2/projects/{Guid.NewGuid()}/duplicate", content: null);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task GetProjects_DefaultsToFirstPageOrderedByLastModified()
    {
        await using var factory = CreateFactory();
        var client = factory.CreateClient();
        await CreateProjectAsync(client, "Proyecto A");
        await CreateProjectAsync(client, "Proyecto B");

        var response = await client.GetAsync("/api/v2/projects");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<ProjectListResponse>();
        Assert.NotNull(body);
        Assert.Equal(1, body!.Page);
        Assert.Equal(2, body.TotalCount);
        Assert.Equal(2, body.Items.Count);
    }

    [Fact]
    public async Task GetProjects_WithInvalidSortBy_ReturnsBadRequest()
    {
        await using var factory = CreateFactory();
        var client = factory.CreateClient();

        var response = await client.GetAsync("/api/v2/projects?sortBy=NotARealSort");

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var error = await response.Content.ReadFromJsonAsync<ApiErrorResponse>();
        Assert.Equal("invalid_sort", error!.Code);
    }

    [Fact]
    public async Task GetProjects_ForAProjectCreatedWithoutSave_ReportsZeroLayersAndNoThumbnailNorTriple()
    {
        // M2.2-S08: un proyecto "vacío" de POST /api/v2/projects (sin Save) se lista igual, pero sin
        // capas, sin thumbnail y sin triple clásico (la UI lo trata como "no se puede reabrir").
        await using var factory = CreateFactory();
        var client = factory.CreateClient();
        var created = await CreateProjectAsync(client, "Vacío");

        Assert.Null(created.ClassicProjectId);
        Assert.Null(created.ClassicImageId);
        Assert.Null(created.ClassicPaletteId);

        var list = await client.GetFromJsonAsync<ProjectListResponse>("/api/v2/projects");
        var item = Assert.Single(list!.Items);
        Assert.Equal(created.Id, item.Id);
        Assert.Equal(0, item.LayerCount);
        Assert.Null(item.ThumbnailAssetId);
        Assert.Null(item.ThumbnailUrl);
        Assert.Null(item.ClassicProjectId);
        Assert.Null(item.ClassicImageId);
        Assert.Null(item.ClassicPaletteId);
    }

    [Fact]
    public async Task GetProjects_ListingShape_UsesCamelCaseJsonForTheNewFields()
    {
        await using var factory = CreateFactory();
        var client = factory.CreateClient();
        await CreateProjectAsync(client, "Forma JSON");

        var json = await client.GetStringAsync("/api/v2/projects");

        // El frontend (types/projectsV2.ts) depende de estos nombres exactos.
        Assert.Contains("\"layerCount\":0", json);
        Assert.Contains("\"thumbnailUrl\":null", json);
        Assert.Contains("\"classicProjectId\":null", json);
        Assert.Contains("\"classicImageId\":null", json);
        Assert.Contains("\"classicPaletteId\":null", json);
        Assert.Contains("\"totalCount\":1", json);
    }

    [Fact]
    public async Task GetProjects_DoesNotListAProjectOfAnotherOwner()
    {
        await using var factory = CreateFactory();
        var client = factory.CreateClient();
        await CreateProjectAsync(client, "Mío");
        var strangerProjectId = await SeedProjectForAnotherOwnerAsync(factory, "Ajeno");

        var list = await client.GetFromJsonAsync<ProjectListResponse>("/api/v2/projects");

        Assert.Equal(["Mío"], list!.Items.Select(i => i.Name));
        // Y pedir el ajeno por Id sigue siendo el 404 uniforme (no revela que existe).
        var response = await client.GetAsync($"/api/v2/projects/{strangerProjectId}");
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    private static async Task<ProjectResponse> CreateProjectAsync(HttpClient client, string name, string? description = null)
    {
        var response = await client.PostAsJsonAsync("/api/v2/projects", new CreateProjectRequest(name, description));
        response.EnsureSuccessStatusCode();
        return (await response.Content.ReadFromJsonAsync<ProjectResponse>())!;
    }

    /// <summary>Inserta un Project directamente en la base (bypass de la API) con un OwnerId AJENO al usuario "dev" fijo que la API siempre usa -- simula "proyecto de otro usuario" de verdad.</summary>
    private static async Task<Guid> SeedProjectForAnotherOwnerAsync(WebApplicationFactory<Program> factory, string name)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var dbContext = scope.ServiceProvider.GetRequiredService<VectorizationDbContext>();

        var stranger = new User
        {
            Id = Guid.NewGuid(),
            DisplayName = "Usuario ajeno",
            CreatedAt = DateTimeOffset.UtcNow,
        };
        var project = new Project
        {
            Id = Guid.NewGuid(),
            OwnerId = stranger.Id,
            Name = name,
            CreatedAt = DateTimeOffset.UtcNow,
            UpdatedAt = DateTimeOffset.UtcNow,
        };

        dbContext.Users.Add(stranger);
        dbContext.Projects.Add(project);
        await dbContext.SaveChangesAsync();

        return project.Id;
    }

    private WebApplicationFactory<Program> CreateFactory() =>
        new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
        {
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["Postgres:ConnectionString"] = _postgres.GetConnectionString(),
                    ["Cors:AllowedOrigins"] = "http://localhost:5173",
                });
            });
        });
}

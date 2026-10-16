using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using AuthPoc.Tests.Support;
using AuthPoc.Users;
using Microsoft.Extensions.DependencyInjection;
using Vectorify.Api.ProjectManagement;
using Vectorify.Api.Projects.Persistence;
using Vectorify.Api.Users;

// El producto (M3.1-S02) tiene un AuthenticatedUserContext homonimo: aqui se prueba el del PoC.
using AuthenticatedUserContext = AuthPoc.Users.AuthenticatedUserContext;

namespace AuthPoc.Tests.Contract;

/// <summary>
/// CONTRATO unico de la frontera de identidad. Lo ejecutan las dos fuentes (A: emisor OIDC simulado, B: ASP.NET Core Identity con
/// cookie) contra el MISMO <c>AuthenticatedUserContext</c>, el MISMO mapeo (Provider, Subject) -&gt; User y los MISMOS endpoints reales
/// del producto. Si una de las dos fallara aqui, el dominio estaria enterandose de quien autentica.
/// </summary>
public abstract class IdentityBoundaryContract : IAsyncLifetime
{
    protected IdentityBoundaryContract(PostgresFixture postgres)
    {
        Postgres = postgres;
    }

    protected PostgresFixture Postgres { get; }

    protected abstract AuthSourceHarness Harness { get; }

    public abstract Task InitializeAsync();

    public Task DisposeAsync() => Harness.DisposeAsync().AsTask();

    [Fact]
    public async Task NewUser_CreatesTheLocalUserExactlyOnce_AndRepeatedRequestsDoNotDuplicateIt()
    {
        var actor = await Harness.SignUpAsync();
        Assert.Equal(0, await LinksAsync(actor));

        var ids = new List<Guid>();
        for (var i = 0; i < 3; i++)
        {
            ids.Add((await GetMeAsync(actor.Client)).UserId);
        }

        Assert.Single(ids.Distinct());
        Assert.NotEqual(Guid.Empty, ids[0]);
        Assert.Equal(1, await LinksAsync(actor));
        Assert.Equal(1, await UsersWithEmailAsync(actor.Email));
        Assert.Equal(1, await Postgres.ScalarAsync<long>(
            "SELECT count(*) FROM users u JOIN poc_auth.user_identities i ON i.\"UserId\" = u.\"Id\" " +
            "WHERE i.\"Provider\" = @p AND i.\"Subject\" = @s",
            ("p", actor.Provider), ("s", actor.Subject)));
    }

    [Fact]
    public async Task ParallelFirstRequests_CreateASingleUser_WithoutOrphans()
    {
        var actor = await Harness.SignUpAsync();

        var responses = await Task.WhenAll(Enumerable.Range(0, 12).Select(_ => GetMeAsync(actor.Client)));

        Assert.Single(responses.Select(r => r.UserId).Distinct());
        Assert.Equal(1, await LinksAsync(actor));
        Assert.Equal(1, await UsersWithEmailAsync(actor.Email));   // las perdedoras de la carrera revirtieron su User
    }

    [Fact]
    public async Task TwoUsers_SeeOnlyTheirOwnProjects_AndAForeignIdIsA404()
    {
        var alice = await Harness.SignUpAsync();
        var bob = await Harness.SignUpAsync();
        var aliceId = (await GetMeAsync(alice.Client)).UserId;
        var bobId = (await GetMeAsync(bob.Client)).UserId;
        Assert.NotEqual(aliceId, bobId);

        var aliceProject1 = await CreateProjectAsync(alice.Client, "alice-1");
        var aliceProject2 = await CreateProjectAsync(alice.Client, "alice-2");
        var bobProject = await CreateProjectAsync(bob.Client, "bob-1");

        // El OwnerId lo pone el servidor a partir de la identidad autenticada, nunca el cliente.
        Assert.Equal(aliceId, aliceProject1.OwnerId);
        Assert.Equal(bobId, bobProject.OwnerId);
        Assert.Equal(aliceId, await Postgres.ScalarAsync<Guid>("SELECT \"OwnerId\" FROM projects WHERE \"Id\" = @id", ("id", aliceProject2.Id)));

        Assert.Equal(["alice-1", "alice-2"], (await ListNamesAsync(alice.Client)).Order());
        Assert.Equal(["bob-1"], await ListNamesAsync(bob.Client));

        // IDs conocidos del otro: 404 (no 403: no se revela que existen), en lectura y en escritura.
        Assert.Equal(HttpStatusCode.NotFound, (await bob.Client.GetAsync($"/api/v2/projects/{aliceProject1.Id}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await alice.Client.GetAsync($"/api/v2/projects/{bobProject.Id}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await bob.Client.PatchAsJsonAsync($"/api/v2/projects/{aliceProject1.Id}", new { name = "hijacked" })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await bob.Client.DeleteAsync($"/api/v2/projects/{aliceProject1.Id}")).StatusCode);

        // ... y el dueno lo sigue viendo intacto.
        var stillThere = await alice.Client.GetAsync($"/api/v2/projects/{aliceProject1.Id}");
        Assert.Equal(HttpStatusCode.OK, stillThere.StatusCode);
        Assert.Equal("alice-1", (await stillThere.Content.ReadFromJsonAsync<ProjectDto>())!.Name);
    }

    [Fact]
    public async Task WithoutCredential_EveryEndpointIs401_AndNoUserIsCreated()
    {
        var usersBefore = await Postgres.ScalarAsync<long>("SELECT count(*) FROM users");
        using var anonymous = Harness.CreateAnonymousClient();

        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync("/api/v2/projects")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync($"/api/v2/projects/{Guid.NewGuid()}")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.PostAsJsonAsync("/api/v2/projects", new { name = "x" })).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync("/poc/me")).StatusCode);

        Assert.Equal(usersBefore, await Postgres.ScalarAsync<long>("SELECT count(*) FROM users"));
    }

    [Fact]
    public void ProductTypes_AreTheRealOnes_AndOnlyTheUserContextWasReplaced()
    {
        using var scope = Harness.Services.CreateScope();

        // Dominio del producto: los mismos tipos de Vectorify.Api, sin sustitutos.
        Assert.IsType<ProjectService>(scope.ServiceProvider.GetRequiredService<IProjectService>());
        Assert.IsType<ProjectRepository>(scope.ServiceProvider.GetRequiredService<IProjectRepository>());

        // La unica pieza distinta: IUserContext. No es DevelopmentUserContext y no pasa por UserContextRegistration.
        var userContext = scope.ServiceProvider.GetRequiredService<IUserContext>();
        Assert.IsType<AuthenticatedUserContext>(userContext);
        Assert.IsNotType<DevelopmentUserContext>(userContext);
    }

    // ---- ayudas ----

    protected static async Task<MeDto> GetMeAsync(HttpClient client)
    {
        var response = await client.GetAsync("/poc/me");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<MeDto>())!;
    }

    protected static async Task<ProjectDto> CreateProjectAsync(HttpClient client, string name)
    {
        var response = await client.PostAsJsonAsync("/api/v2/projects", new { name });
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<ProjectDto>())!;
    }

    protected static async Task<List<string>> ListNamesAsync(HttpClient client)
    {
        var response = await client.GetAsync("/api/v2/projects");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var page = await response.Content.ReadFromJsonAsync<JsonElement>();
        return page.GetProperty("items").EnumerateArray().Select(i => i.GetProperty("name").GetString()!).ToList();
    }

    protected Task<long> LinksAsync(Actor actor) =>
        Postgres.ScalarAsync<long>(
            "SELECT count(*) FROM poc_auth.user_identities WHERE \"Provider\" = @p AND \"Subject\" = @s",
            ("p", actor.Provider), ("s", actor.Subject));

    protected Task<long> UsersWithEmailAsync(string email) =>
        Postgres.ScalarAsync<long>("SELECT count(*) FROM users WHERE \"Email\" = @e", ("e", email));

    protected sealed record MeDto(Guid UserId, string? Email, bool IsAuthenticated, string[] PrincipalIdentities);

    protected sealed record ProjectDto(Guid Id, Guid OwnerId, string Name);
}

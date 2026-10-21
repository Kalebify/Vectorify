using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Vectorify.Api.Contracts;
using Vectorify.Api.Data;
using Vectorify.Api.Data.Auth;
using Vectorify.Api.Maintenance;
using Vectorify.Api.Options;
using Vectorify.Api.Projects;
using Vectorify.Api.Tests.TestSupport;

namespace Vectorify.Api.Tests.Maintenance;

/// <summary>
/// Herramienta de reasignación de datos legados (M3.1-S10, ADR P10) contra la Web API real y PostgreSQL real (Testcontainers):
/// datos creados en modo Development (usuario de desarrollo y registros clásicos sin dueño) y luego, con la MISMA base y la MISMA carpeta
/// de registros pero <c>Auth:Mode=Authenticated</c>, la herramienta los pasa a una cuenta real. Demuestra: DRY-RUN por defecto (no escribe nada),
/// <c>--apply</c> explícito, destino por correo de una cuenta existente, idempotencia, transaccionalidad (si la base falla ningún archivo cambia),
/// que nada ajeno se toca y que, tras reiniciar la API, A ve los proyectos (v2 y clásicos) y B no.
/// </summary>
public sealed class ReassignLegacyDataCommandTests : IClassFixture<AuthApiFixture>
{
    private const string Password = "una-contrasena-larga-1";

    private static readonly Guid DevUser = DevelopmentUserOptions.DefaultUserId;
    private static readonly JsonSerializerOptions RecordJson = new() { WriteIndented = true };

    private readonly AuthApiFixture _fixture;

    public ReassignLegacyDataCommandTests(AuthApiFixture fixture)
    {
        _fixture = fixture;
    }

    private sealed class World
    {
        public string ConnectionString { get; init; } = string.Empty;
        public string RegistryRoot { get; init; } = string.Empty;
        public List<Guid> LiveProjects { get; } = [];
        public Guid DeletedProject { get; set; }
        public string DevOwnedPath { get; set; } = string.Empty;
        public string OwnerlessNullPath { get; set; } = string.Empty;
        public string OwnerlessMissingPath { get; set; } = string.Empty;
        public string OtherOwnerPath { get; set; } = string.Empty;
        public string GarbagePath { get; set; } = string.Empty;
        public string NotARecordPath { get; set; } = string.Empty;
        public ProjectRecord DevOwned { get; set; } = null!;
        public ProjectRecord OwnerlessNull { get; set; } = null!;
        public ProjectRecord OwnerlessMissing { get; set; } = null!;
        public ProjectRecord OtherOwner { get; set; } = null!;
    }

    private IDictionary<string, string?> SettingsFor(string registryRoot) =>
        new Dictionary<string, string?> { ["ProjectRegistry:RootPath"] = registryRoot };

    /// <summary>Crea, en modo Development y antes de que exista ninguna cuenta, lo que dejó el desarrollo anterior a la autenticación.</summary>
    private async Task<World> CreateLegacyWorldAsync()
    {
        var connectionString = await _fixture.CreateDatabaseAsync();
        var registryRoot = Path.Combine(Path.GetTempPath(), "vectorify-reassign-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(registryRoot);
        var world = new World { ConnectionString = connectionString, RegistryRoot = registryRoot };

        await using (var development = _fixture.CreateFactory(connectionString, settings: SettingsFor(registryRoot)))
        {
            using var client = development.CreateClient();
            foreach (var name in new[] { "Legado uno", "Legado dos" })
            {
                var created = await client.PostAsJsonAsync("/api/v2/projects", new CreateProjectRequest(name, null));
                Assert.Equal(HttpStatusCode.Created, created.StatusCode);
                world.LiveProjects.Add((await created.Content.ReadFromJsonAsync<ProjectResponse>())!.Id);
            }

            var doomed = await client.PostAsJsonAsync("/api/v2/projects", new CreateProjectRequest("Legado borrado", null));
            world.DeletedProject = (await doomed.Content.ReadFromJsonAsync<ProjectResponse>())!.Id;
            Assert.Equal(HttpStatusCode.NoContent, (await client.DeleteAsync($"/api/v2/projects/{world.DeletedProject}")).StatusCode);
        }

        ProjectRecord NewRecord(Guid? owner) => new(
            Guid.NewGuid(), Guid.NewGuid(), "logo.png", "image/png", 123, 10, 10, "uploaded", "projects/x/y.png", null, DateTimeOffset.UtcNow, owner);

        world.DevOwned = NewRecord(DevUser);
        world.OwnerlessNull = NewRecord(null);
        world.OwnerlessMissing = NewRecord(null);
        world.OtherOwner = NewRecord(Guid.NewGuid());
        world.DevOwnedPath = WriteRecord(registryRoot, world.DevOwned, removeOwner: false);
        world.OwnerlessNullPath = WriteRecord(registryRoot, world.OwnerlessNull, removeOwner: false); // «OwnerId": null»
        world.OwnerlessMissingPath = WriteRecord(registryRoot, world.OwnerlessMissing, removeOwner: true); // JSON anterior a M2.2-S09: sin la propiedad
        world.OtherOwnerPath = WriteRecord(registryRoot, world.OtherOwner, removeOwner: false);

        var garbageDir = Path.Combine(registryRoot, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(garbageDir);
        world.GarbagePath = Path.Combine(garbageDir, Guid.NewGuid().ToString("N") + ".json");
        File.WriteAllText(world.GarbagePath, "{ esto no es json");
        world.NotARecordPath = Path.Combine(garbageDir, Guid.NewGuid().ToString("N") + ".json");
        File.WriteAllText(world.NotARecordPath, "{\"hello\": 1}");
        return world;
    }

    private static string WriteRecord(string root, ProjectRecord record, bool removeOwner)
    {
        var directory = Path.Combine(root, record.ProjectId.ToString("N"));
        Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, $"{record.ImageId:N}.json");
        var json = JsonSerializer.Serialize(record, RecordJson);
        if (removeOwner)
        {
            var node = JsonNode.Parse(json)!.AsObject();
            node.Remove("OwnerId");
            json = node.ToJsonString(RecordJson);
        }

        File.WriteAllText(path, json);
        return path;
    }

    private static async Task<(HttpClient Client, string Email)> RegisterAsync(WebApplicationFactory<Program> factory, string label)
    {
        var email = $"{label}-{Guid.NewGuid():N}@vectorify.test";
        var client = factory.CreateClient().WithCsrf();
        Assert.Equal(HttpStatusCode.Accepted, (await client.PostAsJsonAsync("/api/v1/auth/register", new RegisterRequest(email, Password))).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync("/api/v1/auth/login", new LoginRequest(email, Password))).StatusCode);
        return (client, email);
    }

    private static async Task<(int Exit, string Output)> RunAsync(WebApplicationFactory<Program> factory, params string[] args)
    {
        var writer = new StringWriter();
        var exit = await ReassignLegacyDataCommand.RunAsync(factory.Services, [ReassignLegacyDataCommand.Flag, .. args], writer);
        return (exit, writer.ToString());
    }

    private static async Task<Dictionary<Guid, Guid>> OwnersAsync(string connectionString)
    {
        await using var db = AuthApiFixture.CreateDomainContext(connectionString);
        return await db.Projects.IgnoreQueryFilters().AsNoTracking().ToDictionaryAsync(p => p.Id, p => p.OwnerId);
    }

    private static string[] AllRegistryFiles(string root) =>
        Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories).OrderBy(f => f, StringComparer.Ordinal).ToArray();

    private static Dictionary<string, string> Snapshot(string root) =>
        AllRegistryFiles(root).ToDictionary(f => f, File.ReadAllText);

    private static string OwnerIdOf(string path)
    {
        var node = JsonNode.Parse(File.ReadAllText(path))!.AsObject();
        return node["OwnerId"]?.GetValue<string>() ?? "<null>";
    }

    [Fact]
    public async Task DryRun_IsTheDefault_ReportsWhatWouldChange_AndWritesNothing()
    {
        var world = await CreateLegacyWorldAsync();
        await using var authenticated = _fixture.CreateFactory(world.ConnectionString, authenticated: true, settings: SettingsFor(world.RegistryRoot));
        var (_, email) = await RegisterAsync(authenticated, "a");
        var ownersBefore = await OwnersAsync(world.ConnectionString);
        var filesBefore = Snapshot(world.RegistryRoot);

        var (exit, output) = await RunAsync(authenticated, $"--target-email={email}"); // SIN --apply

        Assert.Equal(0, exit);
        Assert.Contains("DRY-RUN", output);
        Assert.Contains("Proyectos v2 (projects.OwnerId) del usuario de desarrollo a reasignar: 2", output);
        Assert.Contains("Registros clásicos (sidecars JSON) a reasignar: 3 (sin dueño: 2, del usuario de desarrollo: 1)", output);
        Assert.Contains("1 de otra cuenta, 2 ilegibles", output);
        Assert.Contains("ya ELIMINADOS", output);
        Assert.Contains("HAGA UNA COPIA DE SEGURIDAD", output);
        Assert.DoesNotContain(email, output); // no vuelca el correo en la salida
        Assert.Equal(ownersBefore, await OwnersAsync(world.ConnectionString));
        Assert.Equal(filesBefore, Snapshot(world.RegistryRoot)); // ni un byte: ni JSON, ni copias, ni temporales
    }

    [Fact]
    public async Task Apply_ReassignsProjectsAndClassicRecordsToTheTarget_AndAfterARestartAUserSeesThemAndAnotherDoesNot()
    {
        var world = await CreateLegacyWorldAsync();
        string emailA;
        await using (var authenticated = _fixture.CreateFactory(world.ConnectionString, authenticated: true, settings: SettingsFor(world.RegistryRoot)))
        {
            (_, emailA) = await RegisterAsync(authenticated, "a");
            await RegisterAsync(authenticated, "b");
            var otherBefore = File.ReadAllText(world.OtherOwnerPath);
            var garbageBefore = File.ReadAllText(world.GarbagePath);
            var notARecordBefore = File.ReadAllText(world.NotARecordPath);
            var devOwnedBefore = File.ReadAllText(world.DevOwnedPath);
            var missingBefore = File.ReadAllText(world.OwnerlessMissingPath);

            var (exit, output) = await RunAsync(authenticated, $"--target-email={emailA.ToUpperInvariant()}", "--apply");

            Assert.True(exit == 0, output);
            Assert.Contains("2 proyecto(s) reasignado(s)", output);
            Assert.Contains("3 reasignado(s)", output);
            Assert.Contains("ARRANQUE (o reinicie) la API", output);
            Assert.Equal(otherBefore, File.ReadAllText(world.OtherOwnerPath)); // la cuenta ajena no se toca
            Assert.Equal(garbageBefore, File.ReadAllText(world.GarbagePath));
            Assert.Equal(notARecordBefore, File.ReadAllText(world.NotARecordPath));

            // Copias previas con el contenido ORIGINAL; sin temporales sobrantes.
            Assert.Equal(devOwnedBefore, File.ReadAllText(world.DevOwnedPath + ReassignLegacyDataCommand.BackupSuffix));
            Assert.Equal(missingBefore, File.ReadAllText(world.OwnerlessMissingPath + ReassignLegacyDataCommand.BackupSuffix));
            Assert.DoesNotContain(AllRegistryFiles(world.RegistryRoot), f => f.EndsWith(".tmp", StringComparison.Ordinal));
            Assert.False(File.Exists(world.OtherOwnerPath + ReassignLegacyDataCommand.BackupSuffix));

            // Solo cambió OwnerId: el resto de campos del JSON es idéntico al original.
            foreach (var (path, original) in new[] { (world.DevOwnedPath, devOwnedBefore), (world.OwnerlessMissingPath, missingBefore) })
            {
                var after = JsonNode.Parse(File.ReadAllText(path))!.AsObject();
                var before = JsonNode.Parse(original)!.AsObject();
                after.Remove("OwnerId");
                before.Remove("OwnerId");
                Assert.Equal(before.ToJsonString(), after.ToJsonString());
            }
        }

        var owners = await OwnersAsync(world.ConnectionString);
        await using var db = AuthApiFixture.CreateDomainContext(world.ConnectionString);
        var targetUserId = await db.UserIdentities.AsNoTracking().Select(i => i.UserId).Where(id => id != DevUser).ToListAsync();
        Assert.Contains(owners[world.LiveProjects[0]], targetUserId);
        Assert.All(world.LiveProjects, id => Assert.Equal(owners[world.LiveProjects[0]], owners[id]));
        Assert.Equal(DevUser, owners[world.DeletedProject]); // el borrado lógico no se toca

        // «Reinicio» de la API (host nuevo): rehidrata los sidecars. A los ve, B no.
        await using var restarted = _fixture.CreateFactory(world.ConnectionString, authenticated: true, settings: SettingsFor(world.RegistryRoot));
        var clientA = restarted.CreateClient().WithCsrf();
        Assert.Equal(HttpStatusCode.OK, (await clientA.PostAsJsonAsync("/api/v1/auth/login", new LoginRequest(emailA, Password))).StatusCode);
        var (clientB, _) = await RegisterAsync(restarted, "b2");

        var listA = (await clientA.GetFromJsonAsync<ProjectListResponse>("/api/v2/projects"))!;
        var listB = (await clientB.GetFromJsonAsync<ProjectListResponse>("/api/v2/projects"))!;
        Assert.Equal(world.LiveProjects.OrderBy(x => x), listA.Items.Select(i => i.Id).OrderBy(x => x));
        Assert.Empty(listB.Items);
        foreach (var id in world.LiveProjects)
        {
            Assert.Equal(HttpStatusCode.OK, (await clientA.GetAsync($"/api/v2/projects/{id}")).StatusCode);
            Assert.Equal(HttpStatusCode.NotFound, (await clientB.GetAsync($"/api/v2/projects/{id}")).StatusCode);
        }

        Assert.Equal(HttpStatusCode.NotFound, (await clientA.GetAsync($"/api/v2/projects/{world.DeletedProject}")).StatusCode);

        foreach (var record in new[] { world.DevOwned, world.OwnerlessNull, world.OwnerlessMissing })
        {
            var url = $"/api/v1/projects/{record.ProjectId}/images/{record.ImageId}";
            Assert.Equal(HttpStatusCode.OK, (await clientA.GetAsync(url)).StatusCode);
            Assert.Equal(HttpStatusCode.NotFound, (await clientB.GetAsync(url)).StatusCode);
        }

        // El registro de OTRA cuenta sigue siendo inaccesible para A y para B.
        var otherUrl = $"/api/v1/projects/{world.OtherOwner.ProjectId}/images/{world.OtherOwner.ImageId}";
        Assert.Equal(HttpStatusCode.NotFound, (await clientA.GetAsync(otherUrl)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await clientB.GetAsync(otherUrl)).StatusCode);
    }

    [Fact]
    public async Task Apply_IsIdempotent_ASecondRunFindsNothingAndChangesNothing()
    {
        var world = await CreateLegacyWorldAsync();
        await using var authenticated = _fixture.CreateFactory(world.ConnectionString, authenticated: true, settings: SettingsFor(world.RegistryRoot));
        var (_, email) = await RegisterAsync(authenticated, "a");
        Assert.Equal(0, (await RunAsync(authenticated, $"--target-email={email}", "--apply")).Exit);
        var ownersAfterFirst = await OwnersAsync(world.ConnectionString);
        var filesAfterFirst = Snapshot(world.RegistryRoot);

        var (exit, output) = await RunAsync(authenticated, $"--target-email={email}", "--apply");

        Assert.Equal(0, exit);
        Assert.Contains("nada que reasignar", output);
        Assert.Equal(ownersAfterFirst, await OwnersAsync(world.ConnectionString));
        Assert.Equal(filesAfterFirst, Snapshot(world.RegistryRoot));
        Assert.Equal(OwnerIdOf(world.OwnerlessMissingPath), OwnerIdOf(world.DevOwnedPath));
    }

    [Fact]
    public async Task Apply_WhenTheDatabaseUpdateFails_RollsBack_LeavesEveryFileUntouched_AndNoTemporaryFiles()
    {
        var world = await CreateLegacyWorldAsync();
        await using var authenticated = _fixture.CreateFactory(world.ConnectionString, authenticated: true, settings: SettingsFor(world.RegistryRoot));
        var (_, email) = await RegisterAsync(authenticated, "a");
        await ExecuteSqlAsync(
            world.ConnectionString,
            """
            CREATE FUNCTION block_owner_change() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'cambio de dueño bloqueado por la prueba'; END; $$ LANGUAGE plpgsql;
            CREATE TRIGGER block_owner_change BEFORE UPDATE OF "OwnerId" ON projects FOR EACH ROW EXECUTE FUNCTION block_owner_change();
            """);
        var ownersBefore = await OwnersAsync(world.ConnectionString);
        var filesBefore = Snapshot(world.RegistryRoot);

        var (exit, output) = await RunAsync(authenticated, $"--target-email={email}", "--apply");

        Assert.Equal(2, exit);
        Assert.Contains("ERROR", output);
        Assert.DoesNotContain("Password", output);
        Assert.Equal(ownersBefore, await OwnersAsync(world.ConnectionString)); // ningún proyecto cambió
        Assert.Equal(filesBefore.Where(p => !p.Key.EndsWith(ReassignLegacyDataCommand.BackupSuffix, StringComparison.Ordinal)).ToDictionary(), Snapshot(world.RegistryRoot)
            .Where(p => !p.Key.EndsWith(ReassignLegacyDataCommand.BackupSuffix, StringComparison.Ordinal)).ToDictionary());
        Assert.DoesNotContain(AllRegistryFiles(world.RegistryRoot), f => f.EndsWith(".tmp", StringComparison.Ordinal)); // los temporales se descartan
    }

    [Fact]
    public async Task ATargetThatCannotReceiveTheData_IsRejectedWithExitCode2_AndNothingChanges()
    {
        var world = await CreateLegacyWorldAsync();
        await using var authenticated = _fixture.CreateFactory(world.ConnectionString, authenticated: true, settings: SettingsFor(world.RegistryRoot));
        var (_, email) = await RegisterAsync(authenticated, "a");

        // Cuenta de Identity SIN User interno (nunca inició sesión y el aprovisionamiento no corrió).
        var orphanEmail = $"sin-user-{Guid.NewGuid():N}@vectorify.test";
        using (var scope = authenticated.Services.CreateScope())
        {
            var created = await scope.ServiceProvider.GetRequiredService<UserManager<ApplicationUser>>().CreateAsync(
                new ApplicationUser { Id = Guid.NewGuid(), UserName = orphanEmail, Email = orphanEmail, CreatedAt = DateTimeOffset.UtcNow }, Password);
            Assert.True(created.Succeeded);
        }

        var ownersBefore = await OwnersAsync(world.ConnectionString);
        var filesBefore = Snapshot(world.RegistryRoot);

        foreach (var args in new[]
        {
            new[] { "--apply" },                                                       // sin destino
            new[] { "--target-email=", "--apply" },                                    // destino vacío
            new[] { "--target-email=nadie@vectorify.test", "--apply" },                // la cuenta no existe
            new[] { $"--target-email={orphanEmail}", "--apply" },                      // existe pero no tiene User interno
            new[] { $"--target-email={email}", "--apply", "--force" },                 // argumento desconocido
            new[] { $"--target-email={email}", "--apply", "--delete-everything" },     // argumento desconocido
        })
        {
            var (exit, output) = await RunAsync(authenticated, args);
            Assert.True(exit == 2, $"args=[{string.Join(' ', args)}] salida={output}");
            Assert.Contains("ERROR", output);
            Assert.Equal(ownersBefore, await OwnersAsync(world.ConnectionString));
            Assert.Equal(filesBefore, Snapshot(world.RegistryRoot));
        }
    }

    [Fact]
    public async Task TheDevelopmentUser_CannotBeTheTarget()
    {
        var world = await CreateLegacyWorldAsync();
        // El usuario de desarrollo no tiene cuenta de Identity: se simula una cuenta cuyo User interno ES el de desarrollo.
        await using var authenticated = _fixture.CreateFactory(world.ConnectionString, authenticated: true, settings: SettingsFor(world.RegistryRoot));
        var (_, email) = await RegisterAsync(authenticated, "a");
        await ExecuteSqlAsync(
            world.ConnectionString,
            $"""UPDATE user_identities SET "UserId" = '{DevUser}' WHERE "Subject" = (SELECT "Id"::text FROM auth."AspNetUsers" WHERE "Email" = '{email}')""");
        var ownersBefore = await OwnersAsync(world.ConnectionString);

        var (exit, output) = await RunAsync(authenticated, $"--target-email={email}", "--apply");

        Assert.Equal(2, exit);
        Assert.Contains("no puede ser el propio usuario de desarrollo", output);
        Assert.Equal(ownersBefore, await OwnersAsync(world.ConnectionString));
    }

    private static async Task ExecuteSqlAsync(string connectionString, string sql)
    {
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync();
        await using var command = new NpgsqlCommand(sql, connection);
        await command.ExecuteNonQueryAsync();
    }
}

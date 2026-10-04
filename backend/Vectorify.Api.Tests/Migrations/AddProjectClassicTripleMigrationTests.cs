using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Testcontainers.PostgreSql;
using Vectorify.Api.Data;

namespace Vectorify.Api.Tests.Migrations;

/// <summary>
/// "Upgrade" real de la migración <c>AddProjectClassicTriple</c> (M2.2-S08) sobre datos existentes:
/// arranca la base en el esquema inmediatamente anterior, inserta proyectos ya guardados (con y sin
/// versión actual), aplica la migración y confirma que las filas sobreviven intactas con el triple en
/// null (no hay backfill: el dato nunca existió) y que el triple se puede escribir después.
/// Testcontainers PostgreSQL real, nunca <c>UseInMemoryDatabase</c>.
/// </summary>
public sealed class AddProjectClassicTripleMigrationTests : IAsyncLifetime
{
    private const string MigrationImmediatelyBefore = "20261003230452_AddDocumentVersionIdempotencyKey";

    private readonly PostgreSqlContainer _postgres = new PostgreSqlBuilder("postgres:17-alpine").Build();

    public Task InitializeAsync() => _postgres.StartAsync();

    public Task DisposeAsync() => _postgres.DisposeAsync().AsTask();

    [Fact]
    public async Task Upgrade_OverExistingProjects_PreservesThemWithNullTriple_AndAllowsWritingItAfterwards()
    {
        await using var dbContext = CreateDbContext();
        var migrator = dbContext.GetService<IMigrator>();
        await migrator.MigrateAsync(MigrationImmediatelyBefore);

        var userId = Guid.NewGuid();
        var projectWithDocumentId = Guid.NewGuid();
        var emptyProjectId = Guid.NewGuid();
        var now = DateTimeOffset.UtcNow;

        await dbContext.Database.ExecuteSqlInterpolatedAsync(
            $"""INSERT INTO "users" ("Id", "DisplayName", "CreatedAt") VALUES ({userId}, 'Usuario de prueba', {now})""");
        await dbContext.Database.ExecuteSqlInterpolatedAsync(
            $"""
            INSERT INTO "projects" ("Id", "OwnerId", "Name", "CreatedAt", "UpdatedAt")
            VALUES ({projectWithDocumentId}, {userId}, 'Guardado antes de S08', {now}, {now}),
                   ({emptyProjectId}, {userId}, 'Vacío', {now}, {now})
            """);

        // El esquema "viejo" realmente no tiene las columnas nuevas.
        var columnsBefore = await dbContext.Database
            .SqlQuery<string>($"""SELECT column_name AS "Value" FROM information_schema.columns WHERE table_name = 'projects'""")
            .ToListAsync();
        Assert.DoesNotContain("ClassicProjectId", columnsBefore);

        await dbContext.Database.MigrateAsync();

        await using var readContext = CreateDbContext();
        var projects = await readContext.Projects.OrderBy(p => p.Name).ToListAsync();
        Assert.Equal(["Guardado antes de S08", "Vacío"], projects.Select(p => p.Name));
        Assert.All(projects, project =>
        {
            Assert.Null(project.ClassicProjectId);
            Assert.Null(project.ClassicImageId);
            Assert.Null(project.ClassicPaletteId);
            Assert.Null(project.ThumbnailAssetId);
        });

        // El triple se puede escribir sobre una fila preexistente.
        var existing = projects[0];
        var classicProjectId = Guid.NewGuid();
        var classicImageId = Guid.NewGuid();
        var classicPaletteId = Guid.NewGuid();
        existing.ClassicProjectId = classicProjectId;
        existing.ClassicImageId = classicImageId;
        existing.ClassicPaletteId = classicPaletteId;
        await readContext.SaveChangesAsync();

        await using var verifyContext = CreateDbContext();
        var reloaded = await verifyContext.Projects.FirstAsync(p => p.Id == existing.Id);
        Assert.Equal(classicProjectId, reloaded.ClassicProjectId);
        Assert.Equal(classicImageId, reloaded.ClassicImageId);
        Assert.Equal(classicPaletteId, reloaded.ClassicPaletteId);
    }

    private VectorizationDbContext CreateDbContext()
    {
        var options = new DbContextOptionsBuilder<VectorizationDbContext>()
            .UseNpgsql(_postgres.GetConnectionString())
            .Options;
        return new VectorizationDbContext(options);
    }
}

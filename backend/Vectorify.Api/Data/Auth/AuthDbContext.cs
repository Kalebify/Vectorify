using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;

namespace Vectorify.Api.Data.Auth;

/// <summary>
/// DbContext de ASP.NET Core Identity (M3.1-S02, ADR docs/ADR_AUTH_MVP31.md): tablas <c>AspNetUsers</c>, <c>AspNetRoles</c>,
/// ... en el esquema <see cref="Schema"/> de la MISMA base del producto, con su propio historial de migraciones
/// (<c>auth.__EFMigrationsHistory</c>, ver <see cref="ConfigureNpgsql"/>) para que las migraciones de Identity y las del
/// dominio (<see cref="VectorizationDbContext"/>, esquema por defecto) evolucionen por separado.
/// </summary>
public sealed class AuthDbContext : IdentityDbContext<ApplicationUser, IdentityRole<Guid>, Guid>
{
    public const string Schema = "auth";

    public AuthDbContext(DbContextOptions<AuthDbContext> options)
        : base(options)
    {
    }

    /// <summary>Opciones de Npgsql compartidas por runtime y tooling: el historial de migraciones vive en el esquema <see cref="Schema"/>.</summary>
    public static void ConfigureNpgsql(Npgsql.EntityFrameworkCore.PostgreSQL.Infrastructure.NpgsqlDbContextOptionsBuilder npgsql) =>
        npgsql.MigrationsHistoryTable("__EFMigrationsHistory", Schema);

    protected override void OnModelCreating(ModelBuilder builder)
    {
        base.OnModelCreating(builder);
        builder.HasDefaultSchema(Schema);
    }
}

using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

namespace Vectorify.Api.Data.Auth;

/// <summary>
/// Fábrica de SOLO diseño para `dotnet ef ... --context AuthDbContext` (M3.1-S02); misma convención que
/// <see cref="VectorizationDbContextFactory"/>: la cadena sale de <c>Postgres__ConnectionString</c> y, si falta, del
/// default local NO secreto de .env.example. Nunca se usa en runtime.
/// </summary>
public sealed class AuthDbContextFactory : IDesignTimeDbContextFactory<AuthDbContext>
{
    public AuthDbContext CreateDbContext(string[] args)
    {
        var connectionString = Environment.GetEnvironmentVariable("Postgres__ConnectionString")
            ?? "Host=localhost;Port=5432;Database=vectorify;Username=vectorify;Password=vectorify_dev_password";

        var optionsBuilder = new DbContextOptionsBuilder<AuthDbContext>();
        optionsBuilder.UseNpgsql(connectionString, AuthDbContext.ConfigureNpgsql);

        return new AuthDbContext(optionsBuilder.Options);
    }
}

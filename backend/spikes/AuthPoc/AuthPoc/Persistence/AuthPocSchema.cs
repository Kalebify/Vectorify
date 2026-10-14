using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace AuthPoc.Persistence;

/// <summary>
/// Crea (si falta) el esquema <c>poc_auth</c>. El PoC no usa migraciones de EF: genera el script del modelo del spike y lo
/// ejecuta una sola vez, despues de las migraciones del producto (la FK apunta a <c>users</c>).
/// </summary>
public static class AuthPocSchema
{
    public static async Task EnsureCreatedAsync(string connectionString, CancellationToken cancellationToken = default)
    {
        var options = new DbContextOptionsBuilder<AuthPocDbContext>().UseNpgsql(connectionString).Options;
        await using var db = new AuthPocDbContext(options);

        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync(cancellationToken);

        await using (var probe = new NpgsqlCommand("SELECT to_regclass('poc_auth.user_identities') IS NOT NULL", connection))
        {
            if ((bool)(await probe.ExecuteScalarAsync(cancellationToken))!)
            {
                return;
            }
        }

        await using (var create = new NpgsqlCommand(db.Database.GenerateCreateScript(), connection))
        {
            await create.ExecuteNonQueryAsync(cancellationToken);
        }

        // En el producto (S02) esta FK la declara el modelo de EF. Restrict: borrar un User con identidades es una decision explicita.
        await using var foreignKey = new NpgsqlCommand(
            "ALTER TABLE poc_auth.user_identities " +
            "ADD CONSTRAINT fk_user_identities_users FOREIGN KEY (\"UserId\") REFERENCES public.users (\"Id\") ON DELETE RESTRICT",
            connection);
        await foreignKey.ExecuteNonQueryAsync(cancellationToken);
    }
}

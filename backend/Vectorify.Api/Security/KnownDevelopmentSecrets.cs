using Npgsql;

namespace Vectorify.Api.Security;

/// <summary>
/// Credenciales de ejemplo PUBLICADAS en el repositorio (docker-compose.yml, README) y que, por tanto, cualquiera conoce (M3.1-S09). Sirven para que el desarrollo arranque con un solo
/// comando, pero un entorno que no es de desarrollo no debe usarlas: <see cref="PostgresOptionsValidation"/> impide el arranque si la cadena de conexión lleva la contraseña de ejemplo.
/// </summary>
public static class KnownDevelopmentSecrets
{
    /// <summary>Valor por defecto de <c>POSTGRES_PASSWORD</c> en docker-compose.yml.</summary>
    public const string ComposePostgresPassword = "vectorify_dev_password";

    public static bool UsesKnownDevelopmentPassword(string? connectionString)
    {
        if (string.IsNullOrWhiteSpace(connectionString))
        {
            return false;
        }

        try
        {
            var password = new NpgsqlConnectionStringBuilder(connectionString).Password;
            return string.Equals(password, ComposePostgresPassword, StringComparison.Ordinal);
        }
        catch (ArgumentException)
        {
            // Cadena malformada: no es asunto de este control (Npgsql la rechazará al conectar).
            return false;
        }
    }
}

public static class PostgresOptionsValidation
{
    public const string FailureMessage =
        "Postgres:ConnectionString usa la contraseña de DESARROLLO publicada en el repositorio (vectorify_dev_password): no se permite fuera de Development/Testing/Test. " +
        "Defina POSTGRES_PASSWORD con un secreto propio (variable de entorno / gestor de secretos).";

    /// <summary>true si la configuración es aceptable para <paramref name="environment"/>.</summary>
    public static bool IsAcceptable(Options.PostgresOptions options, IHostEnvironment environment) =>
        Users.UserContextRegistration.IsDevelopmentUserAllowed(environment)
        || !KnownDevelopmentSecrets.UsesKnownDevelopmentPassword(options.ConnectionString);
}

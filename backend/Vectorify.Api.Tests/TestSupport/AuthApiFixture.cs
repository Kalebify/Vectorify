using System.Security.Claims;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Npgsql;
using Testcontainers.PostgreSql;
using Vectorify.Api.Data;
using Vectorify.Api.Data.Auth;

namespace Vectorify.Api.Tests.TestSupport;

/// <summary>
/// Infraestructura de los tests de identidad de M3.1-S02: un container PostgreSQL real por clase (Testcontainers, nunca
/// InMemory) y fábricas de la Web API real contra una base propia. Cada test usa correos/subjects únicos, así que no depende
/// de contar filas globales.
/// </summary>
public sealed class AuthApiFixture : IAsyncLifetime
{
    /// <summary>
    /// Opcional (M3.1-S09): si la variable de entorno <c>VECTORIFY_TEST_POSTGRES</c> trae la cadena de conexión de un PostgreSQL con permiso para crear bases (p. ej. `Host=localhost;Port=5432;Username=postgres;Password=...;Database=postgres`),
    /// los tests de identidad la usan en lugar de levantar un container con Testcontainers. Solo para máquinas SIN Docker; por defecto (variable ausente) todo sigue igual: container real, nunca InMemory.
    /// </summary>
    public const string ExternalPostgresVariable = "VECTORIFY_TEST_POSTGRES";

    private static readonly string? ExternalConnectionString =
        string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(ExternalPostgresVariable)) ? null : Environment.GetEnvironmentVariable(ExternalPostgresVariable);

    private readonly PostgreSqlContainer? _postgres = ExternalConnectionString is null ? new PostgreSqlBuilder("postgres:17-alpine").Build() : null;

    public string ConnectionString => ExternalConnectionString ?? _postgres!.GetConnectionString();

    public Task InitializeAsync() => _postgres?.StartAsync() ?? Task.CompletedTask;

    public Task DisposeAsync() => _postgres?.DisposeAsync().AsTask() ?? Task.CompletedTask;

    /// <summary>Crea una base vacía nueva en el container y devuelve su cadena de conexión.</summary>
    public async Task<string> CreateDatabaseAsync()
    {
        var name = "auth_" + Guid.NewGuid().ToString("N");
        await using (var admin = new NpgsqlConnection(ConnectionString))
        {
            await admin.OpenAsync();
            await using var create = new NpgsqlCommand($"CREATE DATABASE \"{name}\"", admin);
            await create.ExecuteNonQueryAsync();
        }

        return new NpgsqlConnectionStringBuilder(ConnectionString) { Database = name, Pooling = false }.ConnectionString;
    }

    /// <summary>
    /// Web API real sobre <paramref name="connectionString"/>. <paramref name="authenticated"/> fuerza
    /// <c>Auth:Mode=Authenticated</c> (UseSetting: Program.cs lee el modo al registrar servicios); si no, el entorno
    /// Development aplica el <c>Auth:Mode=Development</c> explícito de appsettings.Development.json, como el desarrollo real.
    /// </summary>
    public WebApplicationFactory<Program> CreateFactory(
        string connectionString,
        bool authenticated = false,
        bool testScheme = false,
        Action<IServiceCollection>? configureServices = null,
        ILoggerProvider? logProvider = null,
        IDictionary<string, string?>? settings = null) =>
        new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
        {
            if (authenticated)
            {
                builder.UseSetting("Auth:Mode", "Authenticated");
            }

            builder.ConfigureAppConfiguration((_, config) =>
            {
                var values = new Dictionary<string, string?>
                {
                    ["Postgres:ConnectionString"] = connectionString,
                    ["PythonEngine:BaseUrl"] = "http://127.0.0.1:1",
                    ["Cors:AllowedOrigins"] = "http://localhost:5173",
                    ["Storage:RootPath"] = Path.Combine(Path.GetTempPath(), "vectorify-auth-tests-" + Guid.NewGuid().ToString("n")),
                    ["ProjectRegistry:RootPath"] = Path.Combine(Path.GetTempPath(), "vectorify-auth-tests-reg-" + Guid.NewGuid().ToString("n")),
                    ["Logging:LogLevel:Default"] = "Trace",

                    // M3.1-S09: login/registro llevan límites reales (20 por IP y 10 por dirección cada 15 min por defecto). Los tests de identidad previos a esa tarjeta hacen
                    // decenas de logins/registros desde la misma «IP» (TestServer no tiene IP remota) y no prueban el límite, así que arrancan con topes altísimos; las pruebas
                    // del limitador (AuthLoginRegisterRateLimitTests) los bajan a propósito vía `settings`.
                    ["Auth:RateLimit:LoginIpPermitLimit"] = "100000",
                    ["Auth:RateLimit:LoginAddressPermitLimit"] = "100000",
                    ["Auth:RateLimit:RegisterIpPermitLimit"] = "100000",
                    ["Auth:RateLimit:RegisterAddressPermitLimit"] = "100000",
                };
                foreach (var pair in settings ?? new Dictionary<string, string?>())
                {
                    values[pair.Key] = pair.Value;
                }

                config.AddInMemoryCollection(values);
            });

            builder.ConfigureServices(services =>
            {
                if (logProvider is not null)
                {
                    services.AddSingleton(logProvider);
                }

                if (testScheme)
                {
                    services.AddAuthentication().AddScheme<AuthenticationSchemeOptions, HeaderTestAuthenticationHandler>(
                        HeaderTestAuthenticationHandler.SchemeName, _ => { });
                    services.PostConfigure<AuthenticationOptions>(options =>
                    {
                        options.DefaultScheme = HeaderTestAuthenticationHandler.SchemeName;
                        options.DefaultAuthenticateScheme = HeaderTestAuthenticationHandler.SchemeName;
                        options.DefaultChallengeScheme = HeaderTestAuthenticationHandler.SchemeName;
                    });
                }

                configureServices?.Invoke(services);
            });
        });

    public async Task<T> ScalarAsync<T>(string connectionString, string sql, params (string Name, object Value)[] parameters)
    {
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync();
        await using var command = new NpgsqlCommand(sql, connection);
        foreach (var (name, value) in parameters)
        {
            command.Parameters.AddWithValue(name, value);
        }

        var result = await command.ExecuteScalarAsync();
        return (T)Convert.ChangeType(result!, Nullable.GetUnderlyingType(typeof(T)) ?? typeof(T));
    }

    public static VectorizationDbContext CreateDomainContext(string connectionString) =>
        new(new DbContextOptionsBuilder<VectorizationDbContext>().UseNpgsql(connectionString).Options);

    public static AuthDbContext CreateAuthContext(string connectionString) =>
        new(new DbContextOptionsBuilder<AuthDbContext>().UseNpgsql(connectionString, AuthDbContext.ConfigureNpgsql).Options);
}

/// <summary>
/// Autenticación de prueba por cabeceras (solo tests): <c>X-Test-Sub</c> (NameIdentifier), <c>X-Test-Email</c> y
/// <c>X-Test-Forged-Uid</c> (un claim con el nombre del claim INTERNO, dentro de la identidad del "proveedor", para probar
/// que no puede suplantar a otro usuario). Sin <c>X-Test-Sub</c> no hay credencial (NoResult); con <c>X-Test-NoSubject</c>
/// el principal queda autenticado pero sin subject utilizable.
/// </summary>
public sealed class HeaderTestAuthenticationHandler : AuthenticationHandler<AuthenticationSchemeOptions>
{
    public const string SchemeName = "HeaderTest";

    public HeaderTestAuthenticationHandler(
        IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder)
        : base(options, logger, encoder)
    {
    }

    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        var headers = Request.Headers;
        var claims = new List<Claim>();

        if (headers.TryGetValue("X-Test-Sub", out var sub))
        {
            claims.Add(new Claim(ClaimTypes.NameIdentifier, sub.ToString()));
        }
        else if (!headers.ContainsKey("X-Test-NoSubject"))
        {
            return Task.FromResult(AuthenticateResult.NoResult());
        }

        if (headers.TryGetValue("X-Test-Email", out var email))
        {
            claims.Add(new Claim(ClaimTypes.Email, email.ToString()));
        }

        if (headers.TryGetValue("X-Test-Forged-Uid", out var forged))
        {
            claims.Add(new Claim(Vectorify.Api.Users.VectorifyClaimTypes.InternalUserId, forged.ToString()));
        }

        var identity = new ClaimsIdentity(claims, SchemeName);
        return Task.FromResult(AuthenticateResult.Success(
            new AuthenticationTicket(new ClaimsPrincipal(identity), SchemeName)));
    }
}

/// <summary>Captura todo lo que la aplicación escribe en el log (mensaje formateado, estado, scopes y excepción), a cualquier nivel.</summary>
public sealed class CapturingLoggerProvider : ILoggerProvider
{
    private readonly System.Collections.Concurrent.ConcurrentQueue<string> _entries = new();

    public IReadOnlyCollection<string> Entries => _entries.ToArray();

    public ILogger CreateLogger(string categoryName) => new CapturingLogger(categoryName, _entries);

    public void Dispose()
    {
    }

    private sealed class CapturingLogger : ILogger
    {
        private readonly string _category;
        private readonly System.Collections.Concurrent.ConcurrentQueue<string> _entries;

        public CapturingLogger(string category, System.Collections.Concurrent.ConcurrentQueue<string> entries)
        {
            _category = category;
            _entries = entries;
        }

        public IDisposable? BeginScope<TState>(TState state)
            where TState : notnull => new NoopScope();

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(
            LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            var structured = state is IEnumerable<KeyValuePair<string, object?>> pairs
                ? string.Join(";", pairs.Select(p => $"{p.Key}={p.Value}"))
                : string.Empty;
            _entries.Enqueue($"{_category} [{logLevel}] {formatter(state, exception)} | {structured} | {exception}");
        }

        private sealed class NoopScope : IDisposable
        {
            public void Dispose()
            {
            }
        }
    }
}

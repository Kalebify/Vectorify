using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;
using Vectorify.Api.Options;

namespace Vectorify.Api.Tests.Users;

/// <summary>Validación al arrancar de las opciones de recuperación y correo de M3.1-S08 (<c>Auth:Email:*</c>, <c>Auth:Tokens:*</c>, <c>Auth:RateLimit:*</c>).</summary>
public sealed class AuthRecoveryOptionsValidatorTests
{
    private const string Spa = "https://app.vectorify.test";

    private static readonly string KeysPath = Path.Combine(Path.GetTempPath(), "vectorify-validator-keys");

    private static IReadOnlyList<string> Failures(AuthOptions options, string environment = "Production", string origins = Spa, bool withCors = true)
    {
        options.DataProtection.KeysPath ??= KeysPath;
        IOptions<FrontendCorsOptions>? cors = withCors
            ? Microsoft.Extensions.Options.Options.Create(new FrontendCorsOptions { AllowedOrigins = origins })
            : null;
        var result = new AuthOptionsValidator(new Env(environment), cors).Validate(null, options);
        return result.Failures?.ToList() ?? [];
    }

    private static AuthOptions ValidSmtp() => new()
    {
        Email =
        {
            Mode = AuthEmailMode.Smtp,
            PublicBaseUrl = Spa,
            FromAddress = "no-reply@vectorify.test",
            Smtp = { Host = "smtp.proveedor.test", Port = 587, UserName = "mailer", Password = "secreto-de-entorno" },
        },
    };

    [Fact]
    public void Defaults_AreTheSpecValues_AndValidEvenInProduction()
    {
        var options = new AuthOptions();

        Assert.Equal(AuthEmailMode.Disabled, options.Email.Mode);
        Assert.Equal(TimeSpan.FromHours(1), options.Tokens.PasswordResetLifetime);
        Assert.Equal(TimeSpan.FromHours(24), options.Tokens.EmailConfirmationLifetime);
        Assert.False(options.RequireConfirmedEmail);
        Assert.Empty(Failures(options));
    }

    [Theory]
    [InlineData("Production")]
    [InlineData("Staging")]
    public void LogMode_IsRejectedOutsideDevelopmentTestingAndTest(string environment)
    {
        var options = new AuthOptions { Email = { Mode = AuthEmailMode.Log, PublicBaseUrl = Spa } };

        var failures = Failures(options, environment);

        Assert.Contains(failures, f => f.Contains("Auth:Email:Mode=Log", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("Development")]
    [InlineData("Testing")]
    [InlineData("Test")]
    public void LogMode_IsAllowedInDevelopmentTestingAndTest_WithAPublicBaseUrl(string environment)
    {
        var options = new AuthOptions { Email = { Mode = AuthEmailMode.Log, PublicBaseUrl = "http://localhost:5173" } };

        Assert.Empty(Failures(options, environment, origins: "http://localhost:5173"));
    }

    [Fact]
    public void LogAndSmtp_RequireAPublicBaseUrl()
    {
        var log = new AuthOptions { Email = { Mode = AuthEmailMode.Log } };
        var smtp = ValidSmtp();
        smtp.Email.PublicBaseUrl = "  ";

        Assert.Contains(Failures(log, "Development"), f => f.Contains("PublicBaseUrl", StringComparison.Ordinal));
        Assert.Contains(Failures(smtp), f => f.Contains("PublicBaseUrl", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("app.vectorify.test")]
    [InlineData("/ruta")]
    [InlineData("https://app.vectorify.test/ruta")]
    [InlineData("https://app.vectorify.test/?x=1")]
    [InlineData("ftp://app.vectorify.test")]
    [InlineData("https://*.vectorify.test")]
    public void PublicBaseUrl_MustBeAnExplicitOrigin(string value)
    {
        var options = ValidSmtp();
        options.Email.PublicBaseUrl = value;

        Assert.Contains(Failures(options, origins: value), f => f.Contains("PublicBaseUrl", StringComparison.Ordinal));
    }

    [Fact]
    public void PublicBaseUrl_MustBeHttpsOutsideDevelopment_ButHttpIsFineInDevelopment()
    {
        var options = ValidSmtp();
        options.Email.PublicBaseUrl = "http://app.vectorify.test";

        Assert.Contains(Failures(options, "Production", origins: "http://app.vectorify.test"), f => f.Contains("https", StringComparison.Ordinal));
        Assert.Empty(Failures(options, "Development", origins: "http://app.vectorify.test"));
    }

    [Fact]
    public void PublicBaseUrl_MustBeListedInCorsAllowedOrigins()
    {
        var options = ValidSmtp();

        Assert.Contains(Failures(options, origins: "https://otra-spa.vectorify.test"), f => f.Contains("Cors:AllowedOrigins", StringComparison.Ordinal));
        Assert.Empty(Failures(options, origins: "https://otra-spa.vectorify.test, https://APP.vectorify.test/"));
    }

    [Fact]
    public void ASmtpConfiguration_WithEverythingSet_IsValid_InProduction()
    {
        Assert.Empty(Failures(ValidSmtp()));
    }

    [Fact]
    public void Smtp_RequiresHostFromAddressAndAPasswordWhenThereIsAUserName()
    {
        var options = ValidSmtp();
        options.Email.Smtp.Host = null;
        options.Email.FromAddress = "no-es-un-correo";
        options.Email.Smtp.Password = null;

        var failures = Failures(options);

        Assert.Contains(failures, f => f.Contains("Smtp:Host", StringComparison.Ordinal));
        Assert.Contains(failures, f => f.Contains("FromAddress", StringComparison.Ordinal));
        Assert.Contains(failures, f => f.Contains("Smtp:Password", StringComparison.Ordinal));
    }

    [Fact]
    public void Smtp_WithoutEncryption_IsOnlyForDevelopment()
    {
        var options = ValidSmtp();
        options.Email.Smtp.Security = AuthSmtpSecurity.None;
        options.Email.PublicBaseUrl = "http://localhost:5173";

        Assert.Contains(Failures(options, "Production", origins: "http://localhost:5173"), f => f.Contains("Security=None", StringComparison.Ordinal));
        Assert.Empty(Failures(options, "Development", origins: "http://localhost:5173"));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(65536)]
    public void Smtp_PortMustBeValid(int port)
    {
        var options = ValidSmtp();
        options.Email.Smtp.Port = port;

        Assert.Contains(Failures(options), f => f.Contains("Smtp:Port", StringComparison.Ordinal));
    }

    [Fact]
    public void TokenLifetimes_MustBePositive_AndNotLongerThanAWeek()
    {
        var options = new AuthOptions();
        options.Tokens.PasswordResetLifetime = TimeSpan.Zero;
        options.Tokens.EmailConfirmationLifetime = TimeSpan.FromDays(8);

        var failures = Failures(options);

        Assert.Contains(failures, f => f.Contains("PasswordResetLifetime", StringComparison.Ordinal));
        Assert.Contains(failures, f => f.Contains("EmailConfirmationLifetime", StringComparison.Ordinal));
    }

    [Fact]
    public void RateLimits_MustBePositive()
    {
        var options = new AuthOptions();
        options.RateLimit.IpPermitLimit = 0;
        options.RateLimit.AddressWindow = TimeSpan.Zero;

        var failures = Failures(options);

        Assert.Contains(failures, f => f.Contains("PermitLimit", StringComparison.Ordinal));
        Assert.Contains(failures, f => f.Contains("Window", StringComparison.Ordinal));
    }

    [Fact]
    public void TheCommittedAppsettings_NeverCarryAnSmtpPassword()
    {
        // La contraseña SMTP solo se aporta por entorno (Auth__Email__Smtp__Password): ningún appsettings versionado puede traerla.
        var directory = FindApiProjectDirectory();
        foreach (var file in Directory.GetFiles(directory, "appsettings*.json"))
        {
            using var json = System.Text.Json.JsonDocument.Parse(File.ReadAllText(file));
            var hasPassword = json.RootElement.TryGetProperty("Auth", out var auth)
                && auth.TryGetProperty("Email", out var email)
                && email.TryGetProperty("Smtp", out var smtp)
                && smtp.TryGetProperty("Password", out var password)
                && !string.IsNullOrEmpty(password.GetString());
            Assert.False(hasPassword, $"{Path.GetFileName(file)} contiene Auth:Email:Smtp:Password.");
        }
    }

    private static string FindApiProjectDirectory()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            var candidate = Path.Combine(directory.FullName, "Vectorify.Api");
            if (File.Exists(Path.Combine(candidate, "Vectorify.Api.csproj")))
            {
                return candidate;
            }
        }

        throw new DirectoryNotFoundException("No se encontró Vectorify.Api/Vectorify.Api.csproj.");
    }

    private sealed class Env : IHostEnvironment
    {
        public Env(string name)
        {
            EnvironmentName = name;
        }

        public string EnvironmentName { get; set; }

        public string ApplicationName { get; set; } = "Vectorify.Api.Tests";

        public string ContentRootPath { get; set; } = AppContext.BaseDirectory;

        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}

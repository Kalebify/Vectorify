using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Vectorify.Api.Options;

namespace Vectorify.Api.Tests.Users;

/// <summary>Validación de <see cref="AuthOptions"/> al arrancar (M3.1-S02): defaults del ADR, límites y reglas por entorno.</summary>
public sealed class AuthOptionsValidatorTests
{
    /// <summary>Directorio de claves válido y escribible: las reglas de entorno de la sesión no son lo que cada test de abajo mide.</summary>
    private static readonly string ValidKeysPath = Path.Combine(Path.GetTempPath(), "vectorify-validator-keys");

    /// <summary>Valida con un key ring válido por defecto (Production lo exige), salvo que el test lo fije.</summary>
    private static ValidateOptionsResultView Validate(AuthOptions options, string environment = "Production")
    {
        options.DataProtection.KeysPath ??= ValidKeysPath;
        return ValidateRaw(options, environment);
    }

    private static ValidateOptionsResultView ValidateRaw(AuthOptions options, string environment) =>
        new(new AuthOptionsValidator(new Env(environment)).Validate(null, options));

    [Fact]
    public void Defaults_MatchTheAdr_AndAreValidInProduction()
    {
        var options = new AuthOptions();

        Assert.Equal(AuthMode.Authenticated, options.Mode);
        Assert.Equal("__Host-vectorify.session", options.Cookie.Name);
        Assert.Equal(CookieSecurePolicy.Always, options.Cookie.SecurePolicy);
        Assert.Equal(TimeSpan.FromHours(8), options.Cookie.Lifetime);
        Assert.Equal(TimeSpan.FromDays(30), options.Cookie.RememberMeLifetime);
        Assert.Equal(TimeSpan.FromMinutes(5), options.Session.RevalidationInterval);
        Assert.Equal(TimeSpan.FromSeconds(30), options.Session.ClockSkew);
        Assert.Null(options.DataProtection.KeysPath);
        Assert.Equal(12, options.Password.MinLength);
        Assert.Equal(5, options.Lockout.MaxAttempts);
        Assert.Equal(TimeSpan.FromMinutes(15), options.Lockout.Duration);
        Assert.False(ValidateRaw(options, "Production").Succeeded); // sin key ring persistente, Production no arranca
        Assert.True(ValidateRaw(options, "Development").Succeeded);
        Assert.True(Validate(options).Succeeded);               // con KeysPath, los defaults son válidos en Production
    }

    [Fact]
    public void ConfigurationBinding_UsesTheAuthDoubleUnderscoreVariablesOfTheAdr()
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Auth:Mode"] = "Development",
            ["Auth:Cookie:Name"] = "vectorify.session",
            ["Auth:Cookie:SecurePolicy"] = "SameAsRequest",
            ["Auth:Cookie:Lifetime"] = "08:00:00",
            ["Auth:Cookie:RememberMeLifetime"] = "14.00:00:00",
            ["Auth:Session:RevalidationInterval"] = "00:00:00",
            ["Auth:Session:ClockSkew"] = "00:01:00",
            ["Auth:DataProtection:KeysPath"] = "/var/lib/vectorify/keys",
            ["Auth:Password:MinLength"] = "14",
            ["Auth:Lockout:MaxAttempts"] = "3",
            ["Auth:Lockout:Duration"] = "00:30:00",
        }).Build();

        var options = configuration.GetSection(AuthOptions.SectionName).Get<AuthOptions>()!;

        Assert.Equal(AuthMode.Development, options.Mode);
        Assert.Equal(CookieSecurePolicy.SameAsRequest, options.Cookie.SecurePolicy);
        Assert.Equal(TimeSpan.Zero, options.Session.RevalidationInterval);
        Assert.Equal(TimeSpan.FromDays(14), options.Cookie.RememberMeLifetime);
        Assert.Equal(TimeSpan.FromMinutes(1), options.Session.ClockSkew);
        Assert.Equal("/var/lib/vectorify/keys", options.DataProtection.KeysPath);
        Assert.Equal(14, options.Password.MinLength);
        Assert.Equal(3, options.Lockout.MaxAttempts);
        options.DataProtection.KeysPath = null; // la ruta del binding es de otro SO/contenedor: aquí solo se prueba el resto
        Assert.True(Validate(options, "Development").Succeeded);
    }

    [Theory]
    [InlineData("Production")]
    [InlineData("Staging")]
    public void DevelopmentMode_IsRejected_OutsideDevelopmentEnvironments(string environment)
    {
        var result = Validate(new AuthOptions { Mode = AuthMode.Development }, environment);

        Assert.False(result.Succeeded);
        Assert.Contains("Auth:Mode=Development", result.Message);
    }

    [Theory]
    [InlineData("Development")]
    [InlineData("Testing")]
    [InlineData("Test")]
    public void DevelopmentMode_IsAccepted_InDevelopmentEnvironments(string environment)
    {
        Assert.True(Validate(new AuthOptions { Mode = AuthMode.Development }, environment).Succeeded);
    }

    [Fact]
    public void AnUndefinedMode_IsRejected()
    {
        Assert.False(Validate(new AuthOptions { Mode = (AuthMode)42 }, "Development").Succeeded);
    }

    [Fact]
    public void SameAsRequestCookies_AreOnlyAllowedInDevelopmentEnvironments()
    {
        var options = new AuthOptions { Cookie = { Name = "vectorify.session", SecurePolicy = CookieSecurePolicy.SameAsRequest } };

        Assert.True(Validate(options, "Development").Succeeded);
        Assert.False(Validate(options, "Production").Succeeded);
    }

    [Fact]
    public void AHostPrefixedCookie_RequiresSecureAlways()
    {
        var options = new AuthOptions { Cookie = { Name = "__Host-x", SecurePolicy = CookieSecurePolicy.SameAsRequest } };

        var result = Validate(options, "Development");

        Assert.False(result.Succeeded);
        Assert.Contains("__Host-", result.Message);
    }

    [Theory]
    [InlineData(11)]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(129)]
    public void PasswordMinLength_BelowTwelveOrAbove128_IsRejected(int minLength)
    {
        Assert.False(Validate(new AuthOptions { Password = { MinLength = minLength } }).Succeeded);
    }

    [Theory]
    [InlineData(12)]
    [InlineData(20)]
    [InlineData(128)]
    public void PasswordMinLength_BetweenTwelveAnd128_IsAccepted(int minLength)
    {
        Assert.True(Validate(new AuthOptions { Password = { MinLength = minLength } }).Succeeded);
    }

    [Fact]
    public void NonPositiveLifetimesAndAttemptCounts_AreRejected()
    {
        Assert.False(Validate(new AuthOptions { Cookie = { Lifetime = TimeSpan.Zero } }).Succeeded);
        Assert.False(Validate(new AuthOptions { Lockout = { MaxAttempts = 0 } }).Succeeded);
        Assert.False(Validate(new AuthOptions { Lockout = { Duration = TimeSpan.Zero } }).Succeeded);
        Assert.False(Validate(new AuthOptions { Session = { RevalidationInterval = TimeSpan.FromSeconds(-1) } }).Succeeded);
        Assert.False(Validate(new AuthOptions { Cookie = { Name = " " } }).Succeeded);
    }

    [Fact]
    public void RememberMeLifetime_MustBePositive_NotBeyondWhatBrowsersHonour_AndNotShorterThanASession()
    {
        Assert.False(Validate(new AuthOptions { Cookie = { RememberMeLifetime = TimeSpan.Zero } }).Succeeded);
        Assert.False(Validate(new AuthOptions { Cookie = { RememberMeLifetime = TimeSpan.FromDays(-1) } }).Succeeded);
        Assert.False(Validate(new AuthOptions { Cookie = { RememberMeLifetime = TimeSpan.FromDays(401) } }).Succeeded);
        Assert.False(Validate(new AuthOptions { Cookie = { RememberMeLifetime = TimeSpan.FromHours(7) } }).Succeeded); // < Lifetime (8 h)
        Assert.True(Validate(new AuthOptions { Cookie = { RememberMeLifetime = TimeSpan.FromHours(8) } }).Succeeded);
        Assert.True(Validate(new AuthOptions { Cookie = { RememberMeLifetime = TimeSpan.FromDays(400) } }).Succeeded);
    }

    [Fact]
    public void RevalidationInterval_CannotExceedTheSessionLifetime()
    {
        Assert.True(Validate(new AuthOptions { Session = { RevalidationInterval = TimeSpan.Zero } }).Succeeded);
        Assert.True(Validate(new AuthOptions { Session = { RevalidationInterval = TimeSpan.FromHours(8) } }).Succeeded);
        var result = Validate(new AuthOptions { Session = { RevalidationInterval = TimeSpan.FromHours(8) + TimeSpan.FromSeconds(1) } });
        Assert.False(result.Succeeded);
        Assert.Contains("RevalidationInterval", result.Message);
    }

    [Theory]
    [InlineData(-1, false)]
    [InlineData(0, true)]
    [InlineData(30, true)]
    [InlineData(300, true)]
    [InlineData(301, false)]
    public void ClockSkew_MustBeBetweenZeroAndFiveMinutes(int seconds, bool valid)
    {
        var result = Validate(new AuthOptions { Session = { ClockSkew = TimeSpan.FromSeconds(seconds) } });

        Assert.Equal(valid, result.Succeeded);
    }

    [Theory]
    [InlineData("Production")]
    [InlineData("Staging")]
    public void KeysPath_IsRequired_OutsideDevelopmentEnvironments(string environment)
    {
        var result = ValidateRaw(new AuthOptions(), environment);

        Assert.False(result.Succeeded);
        Assert.Contains("Auth:DataProtection:KeysPath", result.Message);
    }

    [Theory]
    [InlineData("Development")]
    [InlineData("Testing")]
    [InlineData("Test")]
    public void KeysPath_IsOptional_InDevelopmentEnvironments(string environment)
    {
        Assert.True(ValidateRaw(new AuthOptions(), environment).Succeeded);
    }

    [Fact]
    public void KeysPath_MustBeAbsolute_AndAWritableDirectory()
    {
        var relative = ValidateRaw(new AuthOptions { DataProtection = { KeysPath = "keys/relativa" } }, "Development");
        Assert.False(relative.Succeeded);
        Assert.Contains("absoluta", relative.Message);

        var file = Path.Combine(Path.GetTempPath(), "vectorify-validator-file-" + Guid.NewGuid().ToString("N"));
        File.WriteAllText(file, "x");
        try
        {
            var notADirectory = ValidateRaw(new AuthOptions { DataProtection = { KeysPath = file } }, "Production");
            Assert.False(notADirectory.Succeeded);
            Assert.Contains("escribible", notADirectory.Message);
        }
        finally
        {
            File.Delete(file);
        }

        var good = Path.Combine(Path.GetTempPath(), "vectorify-validator-ok-" + Guid.NewGuid().ToString("N"));
        try
        {
            Assert.True(ValidateRaw(new AuthOptions { DataProtection = { KeysPath = good } }, "Production").Succeeded);
            Assert.True(Directory.Exists(good)); // se crea al validar
            Assert.Empty(Directory.GetFileSystemEntries(good)); // y no deja el archivo de prueba
        }
        finally
        {
            Directory.Delete(good, recursive: true);
        }
    }

    [Theory]
    [InlineData("*", false)]
    [InlineData("http://localhost:5173", true)]
    [InlineData("https://app.ejemplo.com", true)]
    [InlineData("https://*.ejemplo.com", false)]
    [InlineData("localhost:5173", false)]
    [InlineData("http://localhost:5173/ruta", false)]
    [InlineData("ftp://localhost", false)]
    [InlineData("http://usuario@localhost", false)]
    public void CorsOrigins_MustBeExplicit(string origin, bool expected)
    {
        Assert.Equal(expected, FrontendCorsOptions.IsExplicitOrigin(origin));
    }

    private readonly record struct ValidateOptionsResultView(Microsoft.Extensions.Options.ValidateOptionsResult Result)
    {
        public bool Succeeded => Result.Succeeded;

        public string Message => Result.FailureMessage ?? string.Empty;
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

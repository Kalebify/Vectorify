using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;
using Vectorify.Api.Options;
using Vectorify.Api.Security;

namespace Vectorify.Api.Tests.Users;

/// <summary>Opciones de endurecimiento de M3.1-S09: límites de login/registro, proxies de confianza, HSTS y secretos de ejemplo.</summary>
public sealed class AuthHardeningOptionsTests
{
    private static readonly string KeysPath = Path.Combine(Path.GetTempPath(), "vectorify-validator-keys");

    private static IReadOnlyList<string> Failures(AuthOptions options, string environment = "Production")
    {
        options.DataProtection.KeysPath ??= KeysPath;
        return new AuthOptionsValidator(new Env(environment)).Validate(null, options).Failures?.ToList() ?? [];
    }

    [Fact]
    public void Defaults_AreTheDocumentedOnes_AndValidEvenInProduction()
    {
        var options = new AuthOptions();
        var limits = options.RateLimit;

        Assert.Equal((20, TimeSpan.FromMinutes(15)), (limits.LoginIpPermitLimit, limits.LoginIpWindow));
        Assert.Equal((10, TimeSpan.FromMinutes(15)), (limits.LoginAddressPermitLimit, limits.LoginAddressWindow));
        Assert.Equal((10, TimeSpan.FromHours(1)), (limits.RegisterIpPermitLimit, limits.RegisterIpWindow));
        Assert.Equal((5, TimeSpan.FromHours(1)), (limits.RegisterAddressPermitLimit, limits.RegisterAddressWindow));
        Assert.False(options.ForwardedHeaders.Enabled); // sin confianza en X-Forwarded-* salvo que se pida
        Assert.Equal(TimeSpan.FromDays(180), options.Hsts.MaxAge);
        Assert.False(options.Hsts.IncludeSubDomains);
        Assert.Empty(Failures(options));
    }

    [Theory]
    [InlineData("LoginIpPermitLimit")]
    [InlineData("LoginAddressPermitLimit")]
    [InlineData("RegisterIpPermitLimit")]
    [InlineData("RegisterAddressPermitLimit")]
    public void RateLimits_BelowOne_AreRejected(string property)
    {
        var options = new AuthOptions();
        typeof(AuthRateLimitOptions).GetProperty(property)!.SetValue(options.RateLimit, 0);

        Assert.Contains(Failures(options), f => f.Contains("RateLimit", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("LoginIpWindow")]
    [InlineData("LoginAddressWindow")]
    [InlineData("RegisterIpWindow")]
    [InlineData("RegisterAddressWindow")]
    public void RateLimitWindows_ThatAreNotPositive_AreRejected(string property)
    {
        var options = new AuthOptions();
        typeof(AuthRateLimitOptions).GetProperty(property)!.SetValue(options.RateLimit, TimeSpan.Zero);

        Assert.Contains(Failures(options), f => f.Contains("Window", StringComparison.Ordinal));
    }

    [Fact]
    public void Hsts_MaxAge_MustBePositive()
    {
        var options = new AuthOptions { Hsts = { MaxAge = TimeSpan.Zero } };

        Assert.Contains(Failures(options), f => f.Contains("Auth:Hsts:MaxAge", StringComparison.Ordinal));
    }

    // ------------------------------------------------------------------------------------------------- ForwardedHeaders

    [Fact]
    public void ForwardedHeaders_Disabled_NeedsNothing()
    {
        Assert.Empty(ForwardedHeadersSetup.Validate(new AuthForwardedHeadersOptions { Enabled = false, KnownNetworks = "0.0.0.0/0" }));
    }

    [Theory]
    [InlineData("10.0.0.5")]
    [InlineData("10.0.0.5, 10.0.0.6")]
    [InlineData("::1")]
    public void ForwardedHeaders_WithValidProxies_IsAccepted(string proxies)
    {
        Assert.Empty(ForwardedHeadersSetup.Validate(new AuthForwardedHeadersOptions { Enabled = true, KnownProxies = proxies }));
    }

    [Theory]
    [InlineData("172.16.0.0/12")]
    [InlineData("10.0.0.0/8")]
    [InlineData("192.168.0.0/16, fd00::/16")]
    public void ForwardedHeaders_WithReasonableNetworks_IsAccepted(string networks)
    {
        Assert.Empty(ForwardedHeadersSetup.Validate(new AuthForwardedHeadersOptions { Enabled = true, KnownNetworks = networks }));
    }

    [Theory]
    [InlineData("0.0.0.0/0")]
    [InlineData("::/0")]
    [InlineData("128.0.0.0/1")]
    [InlineData("10.0.0.0/7")]
    [InlineData("fe80::/15")]
    [InlineData("10.0.0.0")]
    [InlineData("10.0.0.0/33")]
    [InlineData("10.0.0.0/abc")]
    [InlineData("nope/8")]
    public void ForwardedHeaders_BlindOrMalformedNetworks_AreRejected(string network)
    {
        Assert.NotEmpty(ForwardedHeadersSetup.Validate(new AuthForwardedHeadersOptions { Enabled = true, KnownNetworks = network }));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(11)]
    public void ForwardedHeaders_ForwardLimit_IsBounded(int limit)
    {
        Assert.NotEmpty(ForwardedHeadersSetup.Validate(new AuthForwardedHeadersOptions { Enabled = true, KnownProxies = "10.0.0.5", ForwardLimit = limit }));
    }

    [Fact]
    public void ForwardedHeaders_Apply_ReplacesTheFrameworkLoopbackDefaults_WithOnlyWhatIsConfigured()
    {
        var target = new ForwardedHeadersOptions(); // trae loopback de confianza por defecto
        Assert.NotEmpty(target.KnownProxies);

        ForwardedHeadersSetup.Apply(target, new AuthForwardedHeadersOptions { Enabled = true, KnownProxies = "10.0.0.5", KnownNetworks = "172.16.0.0/12", ForwardLimit = 2 });

        Assert.Equal([System.Net.IPAddress.Parse("10.0.0.5")], target.KnownProxies);
        var network = Assert.Single(target.KnownIPNetworks);
        Assert.Equal(System.Net.IPAddress.Parse("172.16.0.0"), network.BaseAddress);
        Assert.Equal(12, network.PrefixLength);
        Assert.Equal(2, target.ForwardLimit);
        Assert.Equal(ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto, target.ForwardedHeaders); // NO X-Forwarded-Host
    }

    [Theory]
    [InlineData("true", true)]
    [InlineData("True", true)]
    [InlineData("false", false)]
    [InlineData("", false)]
    [InlineData(null, false)]
    public void TheFrameworkSwitch_IsDetected(string? value, bool expected)
    {
        var configuration = new Microsoft.Extensions.Configuration.ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { [ForwardedHeadersSetup.FrameworkSwitchKey] = value })
            .Build();

        Assert.Equal(expected, ForwardedHeadersSetup.IsFrameworkSwitchOn(configuration));
    }

    // ----------------------------------------------------------------------------------------------- secretos de ejemplo

    [Theory]
    [InlineData("Host=postgres;Port=5432;Database=vectorify;Username=vectorify;Password=vectorify_dev_password", true)]
    [InlineData("Host=postgres;Username=vectorify;password=vectorify_dev_password;Database=x", true)]
    [InlineData("Host=postgres;Username=vectorify;Password=\"vectorify_dev_password\"", true)]
    [InlineData("Host=postgres;Username=vectorify;Password=otra-clave-real", false)]
    [InlineData("Host=postgres;Username=vectorify", false)]
    [InlineData("", false)]
    [InlineData("esto no es una cadena de conexión", false)]
    public void TheComposeDevelopmentPassword_IsRecognisedInAConnectionString(string connectionString, bool expected)
    {
        Assert.Equal(expected, KnownDevelopmentSecrets.UsesKnownDevelopmentPassword(connectionString));
    }

    [Theory]
    [InlineData("Development", true)]
    [InlineData("Testing", true)]
    [InlineData("Production", false)]
    [InlineData("Staging", false)]
    public void TheComposeDevelopmentPassword_IsOnlyAcceptedInDevelopmentEnvironments(string environment, bool accepted)
    {
        var options = new PostgresOptions { ConnectionString = "Host=postgres;Username=vectorify;Password=vectorify_dev_password" };

        Assert.Equal(accepted, PostgresOptionsValidation.IsAcceptable(options, new Env(environment)));
        Assert.True(PostgresOptionsValidation.IsAcceptable(new PostgresOptions { ConnectionString = "Host=h;Username=u;Password=secreto-real" }, new Env(environment)));
    }

    [Fact]
    public void AProductionHost_WithTheComposeDevelopmentPassword_FailsToStart()
    {
        using var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
        {
            builder.UseEnvironment("Production");
            builder.UseSetting("Auth:DataProtection:KeysPath", Path.Combine(Path.GetTempPath(), "vectorify-prod-keys-" + Guid.NewGuid().ToString("N")));
            builder.UseSetting("Postgres:ConnectionString", "Host=postgres;Port=5432;Database=vectorify;Username=vectorify;Password=vectorify_dev_password");
        });

        var exception = Record.Exception(() => factory.CreateClient());

        Assert.NotNull(exception);
        var failure = FindInChain<OptionsValidationException>(exception!);
        Assert.NotNull(failure);
        Assert.Contains("vectorify_dev_password", failure!.Message);
        Assert.DoesNotContain("Host=postgres", failure.Message); // el mensaje no vuelca la cadena de conexión
    }

    private static T? FindInChain<T>(Exception exception)
        where T : Exception
    {
        for (var current = exception; current is not null; current = current.InnerException)
        {
            if (current is T match)
            {
                return match;
            }
        }

        return null;
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

using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;
using Vectorify.Api.Options;
using Vectorify.Api.Users;

namespace Vectorify.Api.Tests.Users;

/// <summary>
/// Registro de <see cref="IUserContext"/> según <c>Auth:Mode</c> (M2.2-S09 + M3.1-S02, <see cref="UserContextRegistration"/>):
/// <c>Authenticated</c> (default) registra <see cref="AuthenticatedUserContext"/>; <c>Development</c> registra
/// <see cref="DevelopmentUserContext"/> SOLO en Development/Testing/Test y en cualquier otro entorno el arranque falla con
/// <see cref="InvalidOperationException"/>. No existe otro flag para saltearlo.
/// </summary>
public sealed class UserContextRegistrationTests
{
    private static readonly Dictionary<string, string?> DevelopmentMode = new() { ["Auth:Mode"] = "Development" };

    [Theory]
    [InlineData("Development")]
    [InlineData("Testing")]
    [InlineData("Test")]
    public void Register_DevelopmentMode_InAllowedEnvironments_RegistersDevelopmentUserContextAsTheOnlyIUserContext(string environmentName)
    {
        var services = new ServiceCollection();

        UserContextRegistration.Register(services, new FakeHostEnvironment(environmentName), Configuration(DevelopmentMode));

        var descriptor = Assert.Single(services, d => d.ServiceType == typeof(IUserContext));
        Assert.Equal(typeof(DevelopmentUserContext), descriptor.ImplementationType);
        Assert.Equal(ServiceLifetime.Scoped, descriptor.Lifetime);
    }

    [Theory]
    [InlineData("Development")]
    [InlineData("Testing")]
    [InlineData("Test")]
    [InlineData("Production")]
    [InlineData("Staging")]
    [InlineData("")]
    public void Register_WithoutAuthMode_DefaultsToAuthenticatedUserContext_InEveryEnvironment(string environmentName)
    {
        var services = new ServiceCollection();

        UserContextRegistration.Register(services, new FakeHostEnvironment(environmentName), Configuration(new()));

        var descriptor = Assert.Single(services, d => d.ServiceType == typeof(IUserContext));
        Assert.Equal(typeof(AuthenticatedUserContext), descriptor.ImplementationType);
        Assert.Equal(ServiceLifetime.Scoped, descriptor.Lifetime);
        Assert.Contains(services, d => d.ServiceType == typeof(IHttpContextAccessor)); // AuthenticatedUserContext lo necesita
        Assert.DoesNotContain(services, d => d.ServiceType == typeof(IConfigureOptions<DevelopmentUserOptions>));
    }

    [Theory]
    [InlineData("Authenticated")]
    [InlineData("authenticated")]
    public void Register_AuthenticatedMode_IsCaseInsensitive(string mode)
    {
        var services = new ServiceCollection();

        UserContextRegistration.Register(
            services, new FakeHostEnvironment("Production"), Configuration(new() { ["Auth:Mode"] = mode }));

        Assert.Equal(typeof(AuthenticatedUserContext), Assert.Single(services, d => d.ServiceType == typeof(IUserContext)).ImplementationType);
    }

    [Theory]
    [InlineData("Production")]
    [InlineData("Staging")]
    [InlineData("QA")]
    [InlineData("")]
    public void Register_DevelopmentMode_InAnyOtherEnvironment_ThrowsInvalidOperationExceptionAndRegistersNothing(string environmentName)
    {
        var services = new ServiceCollection();

        var exception = Assert.Throws<InvalidOperationException>(() =>
            UserContextRegistration.Register(services, new FakeHostEnvironment(environmentName), Configuration(DevelopmentMode)));

        Assert.Contains("Auth:Mode=Development", exception.Message);
        Assert.DoesNotContain(services, d => d.ServiceType == typeof(IUserContext));
    }

    [Fact]
    public void Register_InProduction_CannotBeBypassedByAnyConfiguration()
    {
        // No existe otro flag: ninguna clave de configuración (inventada o no) habilita el contexto de desarrollo
        // fuera de Development/Testing/Test.
        var configuration = Configuration(new()
        {
            ["Auth:Mode"] = "Development",
            ["DevelopmentUser:UserId"] = Guid.NewGuid().ToString(),
            ["DevelopmentUser:Enabled"] = "true",
            ["DevelopmentUser:AllowInProduction"] = "true",
            ["AllowDevelopmentUserContext"] = "true",
            ["Auth:AllowDevelopmentInProduction"] = "true",
        });

        Assert.Throws<InvalidOperationException>(() =>
            UserContextRegistration.Register(new ServiceCollection(), new FakeHostEnvironment("Production"), configuration));
    }

    [Theory]
    [InlineData("Dev")]
    [InlineData("None")]
    [InlineData("1")]
    public void Register_WithAnInvalidAuthMode_ThrowsInvalidOperationException(string mode)
    {
        var exception = Assert.Throws<InvalidOperationException>(() =>
            UserContextRegistration.Register(
                new ServiceCollection(), new FakeHostEnvironment("Development"), Configuration(new() { ["Auth:Mode"] = mode })));

        Assert.Contains("Auth:Mode", exception.Message);
    }

    [Fact]
    public void Register_DevelopmentMode_WithoutOtherConfiguration_UsesTheOriginalFixedDevelopmentUser()
    {
        using var provider = BuildProvider(DevelopmentMode);

        var context = provider.GetRequiredService<IUserContext>();

        Assert.Equal(Guid.Parse("00000000-0000-0000-0000-000000000001"), context.GetEffectiveUserId());
        Assert.Equal("dev@vectorify.local", context.Email);
        Assert.True(context.IsAuthenticated);
        Assert.Equal("Dev User", provider.GetRequiredService<IOptions<DevelopmentUserOptions>>().Value.DisplayName);
    }

    [Fact]
    public void Register_DevelopmentMode_WithDevelopmentUserConfiguration_ExposesTheConfiguredIdentity()
    {
        var userId = Guid.NewGuid();
        using var provider = BuildProvider(new Dictionary<string, string?>(DevelopmentMode)
        {
            ["DevelopmentUser:UserId"] = userId.ToString(),
            ["DevelopmentUser:Email"] = "otra@vectorify.local",
            ["DevelopmentUser:DisplayName"] = "Otra Persona",
        });

        var context = provider.GetRequiredService<IUserContext>();

        Assert.Equal(userId, context.GetEffectiveUserId());
        Assert.Equal("otra@vectorify.local", context.Email);
        Assert.Equal("Otra Persona", provider.GetRequiredService<IOptions<DevelopmentUserOptions>>().Value.DisplayName);
    }

    [Fact]
    public void Register_DevelopmentMode_WithAnEmptyUserId_FailsOptionsValidation()
    {
        using var provider = BuildProvider(new Dictionary<string, string?>(DevelopmentMode)
        {
            ["DevelopmentUser:UserId"] = Guid.Empty.ToString(),
        });

        var exception = Assert.Throws<OptionsValidationException>(() => provider.GetRequiredService<IUserContext>());

        Assert.Contains("DevelopmentUser:UserId", exception.Message);
    }

    [Fact]
    public void Host_InProductionWithDevelopmentMode_FailsToStartWithInvalidOperationException()
    {
        // Mismo guardrail, pero a través del arranque real de la Web API (Program.cs). UseSetting (y no
        // ConfigureAppConfiguration) porque Register lee Auth:Mode al registrar servicios, antes del Build del host.
        using var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
        {
            builder.UseEnvironment("Production");
            builder.UseSetting("Auth:Mode", "Development");
        });

        var exception = Record.Exception(() => factory.CreateClient());

        Assert.NotNull(exception);
        var innermost = exception!;
        while (innermost.InnerException is not null)
        {
            innermost = innermost.InnerException;
        }

        Assert.IsType<InvalidOperationException>(innermost);
        Assert.Contains("Production", innermost.Message);
        Assert.Contains("Auth:Mode=Development", innermost.Message);
    }

    [Fact]
    public void Host_InProductionWithDevelopmentModeFromALateConfigurationSource_FailsToStartViaOptionsValidation()
    {
        // Defensa en profundidad: aunque el valor llegue por una fuente que Register no ve (ConfigureAppConfiguration se
        // aplica en el Build del host), la validación de AuthOptions al arrancar (con la configuración FINAL) lo rechaza.
        using var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
        {
            builder.UseEnvironment("Production");
            builder.ConfigureAppConfiguration((_, config) => config.AddInMemoryCollection(DevelopmentMode));
        });

        var exception = Record.Exception(() => factory.CreateClient());

        Assert.NotNull(exception);
        var failure = FindInChain<OptionsValidationException>(exception!);
        Assert.NotNull(failure);
        Assert.Contains("Auth:Mode=Development", failure!.Message);
    }

    [Fact]
    public async Task Host_InProductionWithDefaultAuthentication_StartsAndServesHealth()
    {
        // El camino real de producción: sin Auth:Mode ⇒ Authenticated; cookie __Host- + Secure Always (defaults).
        // Desde M3.1-S04 Production exige un key ring persistente (Auth:DataProtection:KeysPath); aquí un directorio temporal.
        var keys = Path.Combine(Path.GetTempPath(), "vectorify-prod-keys-" + Guid.NewGuid().ToString("N"));
        using var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
        {
            builder.UseEnvironment("Production");
            builder.UseSetting("Auth:DataProtection:KeysPath", keys);
        });
        using var client = factory.CreateClient();

        var response = await client.GetAsync("/health");

        Assert.True(response.IsSuccessStatusCode);
        using var scope = factory.Services.CreateScope();
        Assert.IsType<AuthenticatedUserContext>(scope.ServiceProvider.GetRequiredService<IUserContext>());
    }

    [Theory]
    [InlineData("Auth:Cookie:SecurePolicy", "SameAsRequest")]
    [InlineData("Auth:Password:MinLength", "11")]
    [InlineData("Auth:Lockout:MaxAttempts", "0")]
    public void Host_InProduction_WithWeakerAuthSettings_FailsToStart(string key, string value)
    {
        using var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
        {
            builder.UseEnvironment("Production");
            builder.ConfigureAppConfiguration((_, config) => config.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Auth:Cookie:Name"] = "vectorify.session", // sin __Host-: así SecurePolicy se evalúa por sí sola
                [key] = value,
            }));
        });

        var exception = Record.Exception(() => factory.CreateClient());

        Assert.NotNull(exception);
        Assert.NotNull(FindInChain<OptionsValidationException>(exception!));
    }

    [Theory]
    [InlineData("*")]
    [InlineData("http://localhost:5173,*")]
    [InlineData("localhost:5173")]
    [InlineData("http://localhost:5173/app")]
    public void Host_WithNonExplicitCorsOrigins_FailsToStart(string origins)
    {
        // CORS con credenciales exige orígenes explícitos (T8): un comodín o un valor ambiguo tumba el arranque.
        using var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
            builder.ConfigureAppConfiguration((_, config) =>
                config.AddInMemoryCollection(new Dictionary<string, string?> { ["Cors:AllowedOrigins"] = origins })));

        var exception = Record.Exception(() => factory.CreateClient());

        Assert.NotNull(exception);
        var failure = FindInChain<OptionsValidationException>(exception!);
        Assert.NotNull(failure);
        Assert.Contains("Cors:AllowedOrigins", failure!.Message);
    }

    private static T? FindInChain<T>(Exception exception)
        where T : Exception
    {
        for (var current = exception; current is not null; current = current.InnerException!)
        {
            if (current is T match)
            {
                return match;
            }

            if (current.InnerException is null)
            {
                break;
            }
        }

        return null;
    }

    private static IConfiguration Configuration(Dictionary<string, string?> values) =>
        new ConfigurationBuilder().AddInMemoryCollection(values).Build();

    private static ServiceProvider BuildProvider(Dictionary<string, string?> values)
    {
        var services = new ServiceCollection();
        UserContextRegistration.Register(services, new FakeHostEnvironment("Development"), Configuration(values));
        return services.BuildServiceProvider();
    }

    private sealed class FakeHostEnvironment : IHostEnvironment
    {
        public FakeHostEnvironment(string environmentName)
        {
            EnvironmentName = environmentName;
        }

        public string EnvironmentName { get; set; }

        public string ApplicationName { get; set; } = "Vectorify.Api.Tests";

        public string ContentRootPath { get; set; } = AppContext.BaseDirectory;

        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}

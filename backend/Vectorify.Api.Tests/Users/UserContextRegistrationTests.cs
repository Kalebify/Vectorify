using Microsoft.AspNetCore.Hosting;
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
/// Guardrail anti-Production de M2.2-S09 (<see cref="UserContextRegistration"/>): DevelopmentUserContext
/// solo se registra en Development/Testing/Test; en cualquier otro entorno el arranque falla con
/// <see cref="InvalidOperationException"/>. No existe flag para saltearlo.
/// </summary>
public sealed class UserContextRegistrationTests
{
    [Theory]
    [InlineData("Development")]
    [InlineData("Testing")]
    [InlineData("Test")]
    public void Register_InAllowedEnvironments_RegistersDevelopmentUserContextAsTheOnlyIUserContext(string environmentName)
    {
        var services = new ServiceCollection();

        UserContextRegistration.Register(services, new FakeHostEnvironment(environmentName), new ConfigurationBuilder().Build());

        var descriptor = Assert.Single(services, d => d.ServiceType == typeof(IUserContext));
        Assert.Equal(typeof(DevelopmentUserContext), descriptor.ImplementationType);
        Assert.Equal(ServiceLifetime.Scoped, descriptor.Lifetime);
    }

    [Theory]
    [InlineData("Production")]
    [InlineData("Staging")]
    [InlineData("QA")]
    [InlineData("")]
    public void Register_InAnyOtherEnvironment_ThrowsInvalidOperationExceptionAndRegistersNothing(string environmentName)
    {
        var services = new ServiceCollection();

        var exception = Assert.Throws<InvalidOperationException>(() =>
            UserContextRegistration.Register(services, new FakeHostEnvironment(environmentName), new ConfigurationBuilder().Build()));

        Assert.Contains("IUserContext", exception.Message);
        Assert.Contains("MVP 3.1", exception.Message);
        Assert.DoesNotContain(services, d => d.ServiceType == typeof(IUserContext));
    }

    [Fact]
    public void Register_InProduction_CannotBeBypassedByAnyConfiguration()
    {
        // No existe un flag: ninguna clave de configuración (inventada o no) habilita el contexto
        // de desarrollo fuera de Development/Testing.
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["DevelopmentUser:UserId"] = Guid.NewGuid().ToString(),
                ["DevelopmentUser:Enabled"] = "true",
                ["DevelopmentUser:AllowInProduction"] = "true",
                ["AllowDevelopmentUserContext"] = "true",
            })
            .Build();

        Assert.Throws<InvalidOperationException>(() =>
            UserContextRegistration.Register(new ServiceCollection(), new FakeHostEnvironment("Production"), configuration));
    }

    [Fact]
    public void Register_WithoutConfiguration_UsesTheOriginalFixedDevelopmentUser()
    {
        using var provider = BuildProvider(new Dictionary<string, string?>());

        var context = provider.GetRequiredService<IUserContext>();

        Assert.Equal(Guid.Parse("00000000-0000-0000-0000-000000000001"), context.GetEffectiveUserId());
        Assert.Equal("dev@vectorify.local", context.Email);
        Assert.True(context.IsAuthenticated);
        Assert.Equal("Dev User", provider.GetRequiredService<IOptions<DevelopmentUserOptions>>().Value.DisplayName);
    }

    [Fact]
    public void Register_WithDevelopmentUserConfiguration_ExposesTheConfiguredIdentity()
    {
        var userId = Guid.NewGuid();
        using var provider = BuildProvider(new Dictionary<string, string?>
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
    public void Register_WithAnEmptyUserId_FailsOptionsValidation()
    {
        using var provider = BuildProvider(new Dictionary<string, string?> { ["DevelopmentUser:UserId"] = Guid.Empty.ToString() });

        var exception = Assert.Throws<OptionsValidationException>(() => provider.GetRequiredService<IUserContext>());

        Assert.Contains("DevelopmentUser:UserId", exception.Message);
    }

    [Fact]
    public void Host_InProduction_FailsToStartWithInvalidOperationException()
    {
        // Mismo guardrail, pero a través del arranque real de la Web API (Program.cs).
        using var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(builder => builder.UseEnvironment("Production"));

        var exception = Record.Exception(() => factory.CreateClient());

        Assert.NotNull(exception);
        var innermost = exception!;
        while (innermost.InnerException is not null)
        {
            innermost = innermost.InnerException;
        }

        Assert.IsType<InvalidOperationException>(innermost);
        Assert.Contains("Production", innermost.Message);
    }

    private static ServiceProvider BuildProvider(Dictionary<string, string?> values)
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(values).Build();
        var services = new ServiceCollection();
        UserContextRegistration.Register(services, new FakeHostEnvironment("Development"), configuration);
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

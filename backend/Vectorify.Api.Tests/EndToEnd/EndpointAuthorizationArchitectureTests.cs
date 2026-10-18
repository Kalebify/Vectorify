using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.Routing.Patterns;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Vectorify.Api.Authorization;
using Vectorify.Api.Tests.TestSupport;

namespace Vectorify.Api.Tests.EndToEnd;

/// <summary>
/// Test de ARQUITECTURA de M3.1-S06 sobre el <see cref="EndpointDataSource"/> REAL (reflexión, sin lista de rutas escrita a mano): todo endpoint
/// <c>/api/*</c> hereda la denegación por defecto y tiene comprobación de dueño, o figura en una lista blanca explícita y justificada
/// (<see cref="EndpointAuthorizationAudit"/>). Añadir una ruta sin protección rompe este test. Los tests «de control» prueban que el auditor
/// DETECTA el incumplimiento (si el auditor no detectara nada, el primer test pasaría en vacío).
/// </summary>
public sealed class EndpointAuthorizationArchitectureTests : IClassFixture<EndpointAuthorizationArchitectureTests.ApiHost>
{
    private readonly ApiHost _host;

    public EndpointAuthorizationArchitectureTests(ApiHost host)
    {
        _host = host;
    }

    [Fact]
    public void EveryApiEndpoint_HasDefaultAuthorizationAndAnOwnerCheck_OrIsInAnExplicitJustifiedAllowlist()
    {
        var violations = EndpointAuthorizationAudit.Evaluate(_host.Routes);

        Assert.True(violations.Count == 0, "Rutas /api sin la protección exigida:\n - " + string.Join("\n - ", violations));
    }

    [Fact]
    public void TheInventory_IsComplete_AndEveryRouteIsInExactlyOneCategory()
    {
        var api = _host.Routes.Where(EndpointAuthorizationAudit.IsApiRoute).ToList();
        var anonymous = api.Count(r => r.AllowsAnonymous);
        var classic = api.Count(r => r.IsInClassicProjectGroup);
        var serviceEnforced = api.Count(r => EndpointAuthorizationAudit.ServiceEnforcedOwnerAllowlist.ContainsKey(r.Key));
        var noResource = api.Count(r => EndpointAuthorizationAudit.NoProjectResourceAllowlist.ContainsKey(r.Key));

        Assert.Equal(api.Count, anonymous + classic + serviceEnforced + noResource);
        Assert.Equal(EndpointAuthorizationAudit.AnonymousAllowlist.Count, anonymous);
        Assert.True(classic >= 40, $"Se esperaban al menos 40 rutas en el grupo clásico y hay {classic}.");
        Assert.Equal(EndpointAuthorizationAudit.ServiceEnforcedOwnerAllowlist.Count, serviceEnforced);
        Assert.Equal(EndpointAuthorizationAudit.NoProjectResourceAllowlist.Count, noResource);
    }

    [Fact]
    public void EveryRouteUnderTheClassicProjectPrefix_LivesInsideTheCentralGroup()
    {
        var prefix = ClassicProjectScopeExtensions.RoutePrefix;
        var outside = _host.Routes
            .Where(r => r.Pattern.StartsWith(prefix, StringComparison.Ordinal) && !r.IsInClassicProjectGroup)
            .Select(r => r.Key)
            .ToList();

        Assert.Empty(outside);
        Assert.All(
            _host.Routes.Where(r => r.IsInClassicProjectGroup),
            r => Assert.StartsWith(prefix, r.Pattern, StringComparison.Ordinal));
    }

    [Fact]
    public async Task TheFallbackPolicy_DeniesByDefault_RequiringAResolvedUser()
    {
        var provider = _host.Services.GetRequiredService<IAuthorizationPolicyProvider>();

        var fallback = await provider.GetFallbackPolicyAsync();

        Assert.NotNull(fallback);
        Assert.Contains(fallback!.Requirements, r => r is ResolvedUserRequirement);
    }

    // ------------------------------------------------------------------------------------------ controles (el auditor detecta)

    [Fact]
    public void Control_ANewClassicRouteMappedOutsideTheGroup_IsReported()
    {
        var leak = Synthetic("GET", "/api/v1/projects/{projectId:guid}/images/{imageId:guid}/leak");

        var violations = EndpointAuthorizationAudit.Evaluate(_host.Routes.Append(leak));

        var only = Assert.Single(violations);
        Assert.Contains(leak.Key, only, StringComparison.Ordinal);
        Assert.Contains("sin comprobación de dueño", only, StringComparison.Ordinal);
    }

    [Fact]
    public void Control_ARealClassicRouteLosingItsGroupMetadata_IsReported()
    {
        var real = _host.Routes.First(r => r.IsInClassicProjectGroup);
        var stripped = RouteInventory.From(
        [
            new RouteEndpoint(
                real.Endpoint.RequestDelegate!,
                real.Endpoint.RoutePattern,
                real.Endpoint.Order,
                new EndpointMetadataCollection(real.Endpoint.Metadata.Where(m => m is not ClassicProjectScopeMetadata)),
                real.Endpoint.DisplayName),
        ]).Single(r => r.Method == real.Method);

        var violations = EndpointAuthorizationAudit.Evaluate(_host.Routes.Where(r => r.Key != real.Key).Append(stripped));

        Assert.Contains(violations, v => v.StartsWith(real.Key, StringComparison.Ordinal));
    }

    [Fact]
    public void Control_ANewAnonymousRoute_IsReported()
    {
        var open = Synthetic("GET", "/api/v1/open", new AllowAnonymousAttribute());

        var violations = EndpointAuthorizationAudit.Evaluate(_host.Routes.Append(open));

        Assert.Contains(violations, v => v.StartsWith(open.Key, StringComparison.Ordinal) && v.Contains("AnonymousAllowlist", StringComparison.Ordinal));
    }

    [Fact]
    public void Control_ARealRouteTurnedAnonymous_IsReported()
    {
        var real = _host.Routes.First(r => r.Key == "GET /api/v2/projects");
        var opened = RouteInventory.From(
        [
            new RouteEndpoint(
                real.Endpoint.RequestDelegate!,
                real.Endpoint.RoutePattern,
                real.Endpoint.Order,
                new EndpointMetadataCollection(real.Endpoint.Metadata.Append(new AllowAnonymousAttribute())),
                real.Endpoint.DisplayName),
        ]).Single();

        var violations = EndpointAuthorizationAudit.Evaluate(_host.Routes.Where(r => r.Key != real.Key).Append(opened));

        Assert.Contains(violations, v => v.StartsWith(real.Key, StringComparison.Ordinal));
    }

    [Fact]
    public void Control_ANewV2ProjectRouteWithoutAnOwnerCheck_IsReported()
    {
        var route = Synthetic("POST", "/api/v2/projects/{projectId:guid}/export-all");

        var violations = EndpointAuthorizationAudit.Evaluate(_host.Routes.Append(route));

        Assert.Contains(violations, v => v.StartsWith(route.Key, StringComparison.Ordinal));
    }

    [Fact]
    public void Control_AnAllowlistEntryForARouteThatNoLongerExists_IsReported()
    {
        var withoutOne = _host.Routes.Where(r => r.Key != "GET /api/v2/projects").ToList();

        var violations = EndpointAuthorizationAudit.Evaluate(withoutOne);

        Assert.Contains(violations, v => v.Contains("GET /api/v2/projects", StringComparison.Ordinal) && v.Contains("no existe", StringComparison.Ordinal));
    }

    private static ApiRoute Synthetic(string method, string pattern, params object[] metadata)
    {
        var builder = new RouteEndpointBuilder(_ => Task.CompletedTask, RoutePatternFactory.Parse(pattern), 0) { DisplayName = pattern };
        builder.Metadata.Add(new HttpMethodMetadata([method]));
        foreach (var item in metadata)
        {
            builder.Metadata.Add(item);
        }

        return RouteInventory.From([builder.Build()]).Single();
    }

    /// <summary>La Web API real, sin base de datos (basta con que arranque para descubrir sus rutas).</summary>
    public sealed class ApiHost : IDisposable
    {
        private readonly WebApplicationFactory<Program> _factory = new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
            builder.ConfigureAppConfiguration((_, config) => config.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Postgres:ConnectionString"] = string.Empty, // sin base: el arranque omite las migraciones; aquí solo se leen las rutas
                ["Cors:AllowedOrigins"] = "http://localhost:5173",
            })));

        public ApiHost()
        {
            Services = _factory.Services;
            Routes = RouteInventory.From(Services);
        }

        public IServiceProvider Services { get; }

        public IReadOnlyList<ApiRoute> Routes { get; }

        public void Dispose() => _factory.Dispose();
    }
}

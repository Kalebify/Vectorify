using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.Routing.Patterns;
using Microsoft.Extensions.DependencyInjection;
using Vectorify.Api.Authorization;

namespace Vectorify.Api.Tests.TestSupport;

/// <summary>Una ruta HTTP de la Web API real, descubierta por reflexión sobre el <see cref="EndpointDataSource"/> (M3.1-S06).</summary>
public sealed record ApiRoute(string Method, string Pattern, RouteEndpoint Endpoint)
{
    public string Key => $"{Method} {Pattern}";

    public bool AllowsAnonymous => Endpoint.Metadata.GetMetadata<IAllowAnonymous>() is not null;

    public bool HasOwnAuthorization => Endpoint.Metadata.GetOrderedMetadata<IAuthorizeData>().Count > 0;

    public bool IsInClassicProjectGroup => Endpoint.Metadata.GetMetadata<ClassicProjectScopeMetadata>() is not null;

    /// <summary>
    /// Sustituye los parámetros de ruta: <paramref name="known"/> por nombre (p. ej. projectId, imageId, paletteId); el resto, un GUID
    /// nuevo (o <c>1</c> para los <c>:int</c>).
    /// </summary>
    public string Url(IReadOnlyDictionary<string, string> known)
    {
        var path = string.Concat(Endpoint.RoutePattern.PathSegments.Select(segment =>
            "/" + string.Concat(segment.Parts.Select(part => part switch
            {
                RoutePatternLiteralPart literal => literal.Content,
                RoutePatternParameterPart parameter => known.TryGetValue(parameter.Name, out var value)
                    ? value
                    : parameter.ParameterPolicies.Any(p => p.Content == "int") ? "1" : Guid.NewGuid().ToString(),
                _ => throw new InvalidOperationException($"Parte de ruta no soportada en {Pattern}."),
            }))));
        return path;
    }

    public HttpMethod HttpMethod => new(Method);
}

public static class RouteInventory
{
    /// <summary>
    /// Texto canónico del patrón (<c>/api/v2/projects/{id:guid}</c>) reconstruido desde sus segmentos: en las rutas de un
    /// <c>MapGroup</c> el <c>RawText</c> no es fiable (el patrón se combina grupo + ruta).
    /// </summary>
    public static string PatternText(RoutePattern pattern) =>
        string.Concat(pattern.PathSegments.Select(segment =>
            "/" + string.Concat(segment.Parts.Select(part => part switch
            {
                RoutePatternLiteralPart literal => literal.Content,
                RoutePatternSeparatorPart separator => separator.Content,
                RoutePatternParameterPart parameter =>
                    "{" + parameter.Name + string.Concat(parameter.ParameterPolicies.Select(policy => ":" + policy.Content)) + "}",
                _ => throw new InvalidOperationException("Parte de ruta no soportada."),
            }))));

    /// <summary>Todas las rutas (una entrada por método) del <see cref="EndpointDataSource"/> del host, ordenadas.</summary>
    public static IReadOnlyList<ApiRoute> From(IServiceProvider services) =>
        From(services.GetRequiredService<EndpointDataSource>().Endpoints);

    public static IReadOnlyList<ApiRoute> From(IEnumerable<Endpoint> endpoints) =>
        endpoints
            .OfType<RouteEndpoint>()
            .SelectMany(endpoint =>
            {
                var methods = endpoint.Metadata.GetMetadata<HttpMethodMetadata>()?.HttpMethods ?? [];
                var pattern = PatternText(endpoint.RoutePattern);
                return methods.Select(method => new ApiRoute(method.ToUpperInvariant(), pattern, endpoint));
            })
            .OrderBy(route => route.Pattern, StringComparer.Ordinal)
            .ThenBy(route => route.Method, StringComparer.Ordinal)
            .ToList();
}

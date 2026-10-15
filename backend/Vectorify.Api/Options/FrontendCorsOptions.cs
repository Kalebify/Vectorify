namespace Vectorify.Api.Options;

/// <summary>
/// Orígenes (scheme + host + puerto) desde los que el navegador puede llamar a la Web API.
/// Se enlaza desde la sección "Cors" de appsettings/variables de entorno.
/// AllowedOrigins acepta una lista separada por comas, por ejemplo
/// Cors__AllowedOrigins=http://localhost:5173,http://127.0.0.1:5173.
/// </summary>
public sealed class FrontendCorsOptions
{
    public const string SectionName = "Cors";

    /// <summary>Nombre de la política CORS que aplica la Web API a todos sus endpoints.</summary>
    public const string PolicyName = "Frontend";

    /// <summary>Orígenes permitidos, separados por comas.</summary>
    public string AllowedOrigins { get; set; } = string.Empty;

    /// <summary>Devuelve los orígenes normalizados (sin espacios ni barra final, sin duplicados).</summary>
    public string[] GetOrigins() => AllowedOrigins
        .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
        .Select(origin => origin.TrimEnd('/'))
        .Distinct(StringComparer.OrdinalIgnoreCase)
        .ToArray();

    /// <summary>
    /// true si <paramref name="origin"/> es un origen explícito: URL absoluta http(s) sin ruta, query ni fragmento. Rechaza
    /// <c>*</c> y cualquier comodín: con <c>AllowCredentials</c> un origen abierto dejaría a cualquier web actuar con la sesión (T8).
    /// </summary>
    public static bool IsExplicitOrigin(string origin) =>
        Uri.TryCreate(origin, UriKind.Absolute, out var uri)
        && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps)
        && !origin.Contains('*')
        && string.IsNullOrEmpty(uri.Query)
        && string.IsNullOrEmpty(uri.Fragment)
        && (uri.AbsolutePath == "/" || string.IsNullOrEmpty(uri.AbsolutePath))
        && string.IsNullOrEmpty(uri.UserInfo);
}

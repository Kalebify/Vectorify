namespace Vectorify.Api.Tests.TestSupport;

/// <summary>Cabeceras que el frontend real envía en cada fetch (M3.1-S03): lo que el CsrfGuard exige en modo Authenticated.</summary>
public static class CsrfTestExtensions
{
    /// <summary>Origen permitido por <see cref="AuthApiFixture"/> (<c>Cors:AllowedOrigins</c>).</summary>
    public const string AllowedOrigin = "http://localhost:5173";

    public const string HeaderName = "X-Vectorify-Request";

    /// <summary>Añade como cabeceras por defecto del cliente la cabecera anti-CSRF y un Origin permitido, como haría el navegador con la SPA.</summary>
    public static HttpClient WithCsrf(this HttpClient client, string origin = AllowedOrigin)
    {
        client.DefaultRequestHeaders.Remove(HeaderName);
        client.DefaultRequestHeaders.Remove("Origin");
        client.DefaultRequestHeaders.Add(HeaderName, "1");
        client.DefaultRequestHeaders.Add("Origin", origin);
        return client;
    }
}

using System.Net;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.Extensions.Options;
using Vectorify.Api.Options;

namespace Vectorify.Api.Security;

/// <summary>
/// Cableado SEGURO de <c>ForwardedHeaders</c> (M3.1-S09, T10). Sin <c>Auth:ForwardedHeaders:Enabled</c> el middleware NO se registra: <c>X-Forwarded-For/Proto/Host</c> los puede escribir
/// cualquier cliente y se ignoran, así que el límite por IP no se puede esquivar (ni falsificar la IP de otro) con cabeceras. Con <c>Enabled</c> solo se atienden las de una conexión cuyo
/// origen TCP esté en <c>KnownProxies</c>/<c>KnownNetworks</c> (las listas por defecto del framework —loopback— se VACÍAN: lo único de confianza es lo configurado) y solo
/// <c>X-Forwarded-For</c> y <c>X-Forwarded-Proto</c>: el <c>Host</c> no se reescribe (los enlaces de los correos salen de <c>Auth:Email:PublicBaseUrl</c>, nunca de la request).
/// </summary>
public static class ForwardedHeadersSetup
{
    /// <summary>Variable de entorno <c>ASPNETCORE_FORWARDEDHEADERS_ENABLED</c> tal como llega a la configuración del host (sin el prefijo <c>ASPNETCORE_</c>).</summary>
    public const string FrameworkSwitchKey = "FORWARDEDHEADERS_ENABLED";

    /// <summary>true si la configuración activa el interruptor del framework, que confía en CUALQUIER origen (se rechaza al arrancar).</summary>
    public static bool IsFrameworkSwitchOn(IConfiguration configuration) =>
        bool.TryParse(configuration[FrameworkSwitchKey], out var enabled) && enabled;

    /// <summary>Interpreta <c>10.0.0.0/8</c> / <c>fd00::/8</c>. false si no es una red válida.</summary>
    public static bool TryParseNetwork(string text, out IPAddress prefix, out int prefixLength)
    {
        prefix = IPAddress.None;
        prefixLength = 0;
        var slash = text.IndexOf('/');
        if (slash <= 0 || slash == text.Length - 1)
        {
            return false;
        }

        if (!IPAddress.TryParse(text.AsSpan(0, slash), out var address) || !int.TryParse(text.AsSpan(slash + 1), out var length))
        {
            return false;
        }

        var max = address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork ? 32 : 128;
        if (length < 0 || length > max)
        {
            return false;
        }

        prefix = address;
        prefixLength = length;
        return true;
    }

    /// <summary>Problemas de la configuración de proxies de confianza (vacío = correcta o apagada).</summary>
    public static IEnumerable<string> Validate(AuthForwardedHeadersOptions options)
    {
        if (!options.Enabled)
        {
            yield break;
        }

        if (options.ForwardLimit < 1 || options.ForwardLimit > 10)
        {
            yield return "Auth:ForwardedHeaders:ForwardLimit debe estar entre 1 y 10.";
        }

        var proxies = options.GetKnownProxies();
        var networks = options.GetKnownNetworks();
        if (proxies.Length == 0 && networks.Length == 0)
        {
            yield return "Auth:ForwardedHeaders:Enabled=true exige Auth:ForwardedHeaders:KnownProxies y/o KnownNetworks: sin confianza ciega en X-Forwarded-For.";
        }

        foreach (var proxy in proxies)
        {
            if (!IPAddress.TryParse(proxy, out var address))
            {
                yield return "Auth:ForwardedHeaders:KnownProxies contiene un valor que no es una dirección IP.";
            }
            else if (address.Equals(IPAddress.Any) || address.Equals(IPAddress.IPv6Any))
            {
                yield return "Auth:ForwardedHeaders:KnownProxies no puede ser 0.0.0.0 ni :: (confianza ciega).";
            }
        }

        foreach (var network in networks)
        {
            if (!TryParseNetwork(network, out var prefix, out var length))
            {
                yield return "Auth:ForwardedHeaders:KnownNetworks contiene un valor que no es una red CIDR válida (p. ej. 172.16.0.0/12).";
                continue;
            }

            var minimum = prefix.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork
                ? AuthForwardedHeadersOptions.MinIpv4PrefixLength
                : AuthForwardedHeadersOptions.MinIpv6PrefixLength;
            if (length < minimum)
            {
                yield return $"Auth:ForwardedHeaders:KnownNetworks: la red /{length} es demasiado amplia (mínimo /{minimum}): sería confiar en casi cualquier origen.";
            }
        }
    }

    /// <summary>Traslada la configuración de <c>Auth:ForwardedHeaders</c> a las opciones del middleware (solo se invoca con <c>Enabled=true</c>).</summary>
    public static void Apply(ForwardedHeadersOptions target, AuthForwardedHeadersOptions source)
    {
        target.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
        target.ForwardLimit = source.ForwardLimit;

        // Lo único de confianza es lo configurado: se descartan los loopback por defecto del framework.
        target.KnownProxies.Clear();
        target.KnownIPNetworks.Clear();

        foreach (var proxy in source.GetKnownProxies())
        {
            target.KnownProxies.Add(IPAddress.Parse(proxy));
        }

        foreach (var network in source.GetKnownNetworks())
        {
            if (TryParseNetwork(network, out var prefix, out var length))
            {
                target.KnownIPNetworks.Add(new System.Net.IPNetwork(prefix, length));
            }
        }
    }

    public static IServiceCollection AddVectorifyForwardedHeaders(this IServiceCollection services)
    {
        services.AddOptions<ForwardedHeadersOptions>().Configure<IOptions<AuthOptions>>((forwarded, auth) =>
        {
            if (auth.Value.ForwardedHeaders.Enabled)
            {
                Apply(forwarded, auth.Value.ForwardedHeaders);
            }
        });
        return services;
    }
}

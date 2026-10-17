using System.Globalization;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Identity;
using Vectorify.Api.Options;

namespace Vectorify.Api.Users;

/// <summary>
/// Ciclo de vida de la cookie de sesión (M3.1-S04, ADR D3.7). Dos tipos de sesión, ambas con el MISMO ticket cifrado de Identity:
/// <list type="bullet">
/// <item><b>Normal</b>: cookie de sesión del navegador (sin <c>Expires</c>); el ticket caduca por INACTIVIDAD a las
/// <see cref="AuthCookieOptions.Lifetime"/> (8 h) y se renueva (deslizante) al usarse.</item>
/// <item><b>«Recordarme»</b>: cookie persistente (<c>Expires</c> y <c>Max-Age</c>) con un TOPE ABSOLUTO de
/// <see cref="AuthCookieOptions.RememberMeLifetime"/> (30 días) contado desde el login. El tope viaja DENTRO del ticket cifrado
/// (<see cref="AbsoluteExpiryItem"/>), no se puede alargar desde el cliente, y la renovación que dispara la revalidación del
/// SecurityStamp se acota a él: sin esto, cada revalidación (5 min) reemitiría el ticket con otros 30 días y el tope no existiría.</item>
/// </list>
/// </summary>
public static class SessionCookie
{
    /// <summary>Clave en <see cref="AuthenticationProperties.Items"/> con el instante UTC (ISO 8601, «O») del tope absoluto.</summary>
    public const string AbsoluteExpiryItem = "vectorify.session.absolute-expiry";

    /// <summary>Propiedades de autenticación del login según «recordarme». <paramref name="now"/> sale del <see cref="TimeProvider"/> del host.</summary>
    public static AuthenticationProperties CreateProperties(bool rememberMe, DateTimeOffset now, AuthCookieOptions options)
    {
        if (!rememberMe)
        {
            // Cookie de sesión del navegador. Handler: IssuedUtc = ahora y ExpiresUtc = ahora + ExpireTimeSpan (Auth:Cookie:Lifetime).
            return new AuthenticationProperties { IsPersistent = false };
        }

        var absolute = now + options.RememberMeLifetime;
        var properties = new AuthenticationProperties
        {
            IsPersistent = true,       // Expires/Max-Age en el Set-Cookie: sobrevive al cierre del navegador
            IssuedUtc = now,
            ExpiresUtc = absolute,
            AllowRefresh = false,      // la renovación deslizante por mitad de ventana no aplica: el tope es absoluto
        };
        properties.Items[AbsoluteExpiryItem] = absolute.ToString("O", CultureInfo.InvariantCulture);
        return properties;
    }

    /// <summary>Lee el tope absoluto del ticket; false si es una sesión normal (o el valor no es legible).</summary>
    public static bool TryGetAbsoluteExpiry(AuthenticationProperties properties, out DateTimeOffset absolute)
    {
        absolute = default;
        return properties.Items.TryGetValue(AbsoluteExpiryItem, out var raw)
               && DateTimeOffset.TryParse(raw, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out absolute);
    }

    /// <summary>Añade <c>Max-Age</c> (inmune al reloj del cliente) a la cookie persistente en el momento del login.</summary>
    public static Task OnSigningIn(CookieSigningInContext context, TimeProvider time)
    {
        if (context.Properties.IsPersistent && context.Properties.ExpiresUtc is { } expires)
        {
            var remaining = expires - time.GetUtcNow();
            if (remaining > TimeSpan.Zero)
            {
                context.CookieOptions.MaxAge = remaining;
            }
        }

        return Task.CompletedTask;
    }

    /// <summary>
    /// Se ejecuta en cada request autenticada por cookie, ENVOLVIENDO al validador de SecurityStamp de Identity:
    /// (1) un ticket de «recordarme» pasado su tope absoluto se rechaza; (2) un ticket «emitido en el futuro» más allá del
    /// <see cref="AuthSessionOptions.ClockSkew"/> se revalida YA (si no, el validador esperaría a que el reloj local alcance su
    /// <c>IssuedUtc</c> y el desfase alargaría la ventana de revocación); (3) la renovación que pida el validador se acota al tope.
    /// </summary>
    public static async Task ValidatePrincipalAsync(
        CookieValidatePrincipalContext context,
        Func<CookieValidatePrincipalContext, Task> securityStampValidator,
        AuthSessionOptions session,
        TimeProvider time)
    {
        var now = time.GetUtcNow();
        var hasAbsolute = TryGetAbsoluteExpiry(context.Properties, out var absolute);

        if (hasAbsolute && now >= absolute)
        {
            context.RejectPrincipal();
            await context.HttpContext.SignOutAsync(context.Scheme.Name);
            return;
        }

        TimeSpan? skewedSpan = null;
        if (context.Properties is { IssuedUtc: { } issued, ExpiresUtc: { } expires } && issued - now > session.ClockSkew)
        {
            // Se fuerza la revalidación contra la base en esta request: el validador compara (ahora - IssuedUtc) con el intervalo.
            skewedSpan = expires - issued;
            context.Properties.IssuedUtc = now - session.RevalidationInterval - TimeSpan.FromMilliseconds(1);
        }

        await securityStampValidator(context);

        if (skewedSpan is { } span && context.Principal is not null && context.ShouldRenew)
        {
            // La renovación conserva la duración ORIGINAL del ticket (no la inflada por el IssuedUtc forzado arriba).
            context.Properties.IssuedUtc = now;
            context.Properties.ExpiresUtc = now + span;
        }

        if (hasAbsolute && context.Principal is not null && context.ShouldRenew)
        {
            // RequestRefresh (cookie handler) reemite con ExpiresUtc = ahora + (ExpiresUtc - IssuedUtc): se deja esa resta igual
            // a (tope - ahora) para que la cookie renovada caduque EXACTAMENTE en el tope y nunca después.
            context.Properties.IssuedUtc = now;
            context.Properties.ExpiresUtc = absolute;
        }
    }
}

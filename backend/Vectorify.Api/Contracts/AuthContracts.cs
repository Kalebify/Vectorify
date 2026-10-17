namespace Vectorify.Api.Contracts;

/// <summary>Cuerpo de <c>POST /api/v1/auth/register</c> (M3.1-S02). La contraseña nunca se devuelve ni se loguea.</summary>
public sealed record RegisterRequest(string? Email, string? Password);

/// <summary>
/// Respuesta UNIFORME de <c>POST /api/v1/auth/register</c>: idéntica (código, cuerpo y forma) exista o no el correo
/// (T5 del ADR, sin enumeración de cuentas). No confirma que la cuenta sea nueva.
/// </summary>
public sealed record RegisterResponse(string Status);

/// <summary>
/// Cuerpo de <c>POST /api/v1/auth/login</c> (M3.1-S03). La contraseña nunca se devuelve ni se loguea. <paramref name="RememberMe"/>
/// (M3.1-S04, opcional; ausente o <c>null</c> = <c>false</c>): <c>true</c> emite una cookie PERSISTENTE con tope absoluto
/// (<c>Auth:Cookie:RememberMeLifetime</c>, 30 días); sin él, cookie de sesión del navegador con caducidad deslizante por inactividad.
/// </summary>
public sealed record LoginRequest(string? Email, string? Password, bool? RememberMe = null);

/// <summary>
/// Usuario actual (M3.1-S03): respuesta de <c>GET /api/v1/auth/me</c> y de un login correcto. <see cref="Id"/> es el
/// <c>Users.Id</c> INTERNO que el servidor resolvió desde la identidad verificada de la cookie, nunca algo enviado por el cliente.
/// </summary>
public sealed record CurrentUserResponse(Guid Id, string? Email, string DisplayName);

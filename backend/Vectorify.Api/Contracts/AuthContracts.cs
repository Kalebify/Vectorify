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
/// <see cref="AuthMode"/> (M3.1-S05) es el nombre de <c>Auth:Mode</c> (<c>Authenticated</c> o <c>Development</c>): en <c>Development</c> no hay
/// login y la SPA oculta el formulario y «Salir» (ver <c>GET /api/v1/auth/me</c>).
/// </summary>
public sealed record CurrentUserResponse(Guid Id, string? Email, string DisplayName, string AuthMode);

/// <summary>Cuerpo de <c>POST /api/v1/auth/forgot-password</c> (M3.1-S08). La respuesta es el 202 uniforme (<see cref="RegisterResponse"/>) exista o no la cuenta.</summary>
public sealed record ForgotPasswordRequest(string? Email);

/// <summary>
/// Cuerpo de <c>POST /api/v1/auth/reset-password</c> (M3.1-S08): el token NATIVO de Identity que llegó por correo (en el fragmento del enlace), el correo de la cuenta y la
/// contraseña nueva. Nunca se devuelven ni se loguean.
/// </summary>
public sealed record ResetPasswordRequest(string? Email, string? Token, string? NewPassword);

/// <summary>
/// Cuerpo de <c>POST /api/v1/auth/confirm-email</c> (M3.1-S08): identifica la cuenta por <see cref="AccountId"/> (el enlace del correo) o, si falta, por <see cref="Email"/>.
/// En el JSON el campo se llama <c>userId</c> (el fragmento del enlace y la SPA lo usan así). La propiedad C# NO se llama <c>UserId</c> a propósito: el test de arquitectura
/// «los contratos de entrada nunca llevan un dueño/usuario» (S02) prohíbe esos nombres, y aquí no es el usuario quien se nombra a sí mismo: este endpoint es ANÓNIMO y lo
/// que autoriza es el token firmado de Identity (ligado a esa cuenta y a su SecurityStamp); el id solo dice contra qué cuenta verificarlo.
/// </summary>
public sealed record ConfirmEmailRequest([property: System.Text.Json.Serialization.JsonPropertyName("userId")] string? AccountId, string? Email, string? Token);

/// <summary>Cuerpo de <c>POST /api/v1/auth/resend-confirmation</c> (M3.1-S08). Respuesta: el 202 uniforme.</summary>
public sealed record ResendConfirmationRequest(string? Email);

/// <summary>Cuerpo de <c>POST /api/v1/auth/change-password</c> (M3.1-S08, sesión obligatoria). Nunca se devuelven ni se loguean.</summary>
public sealed record ChangePasswordRequest(string? CurrentPassword, string? NewPassword);

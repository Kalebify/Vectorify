namespace Vectorify.Api.Contracts;

/// <summary>Cuerpo de <c>POST /api/v1/auth/register</c> (M3.1-S02). La contraseña nunca se devuelve ni se loguea.</summary>
public sealed record RegisterRequest(string? Email, string? Password);

/// <summary>
/// Respuesta UNIFORME de <c>POST /api/v1/auth/register</c>: idéntica (código, cuerpo y forma) exista o no el correo
/// (T5 del ADR, sin enumeración de cuentas). No confirma que la cuenta sea nueva.
/// </summary>
public sealed record RegisterResponse(string Status);

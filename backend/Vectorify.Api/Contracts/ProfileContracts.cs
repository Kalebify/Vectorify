namespace Vectorify.Api.Contracts;

/// <summary>
/// Cuerpo de <c>PATCH /api/v1/me</c> (M3.1-S07). Lleva SOLO <see cref="DisplayName"/>: el contrato de entrada ni siquiera declara
/// <c>id</c>, <c>email</c>, <c>provider</c>, <c>subject</c>, <c>createdAt</c> ni <c>authMode</c>. Cualquier otro campo que el cliente envíe
/// se IGNORA (no se enlaza, no tiene efecto y no provoca error).
/// </summary>
public sealed record UpdateProfileRequest(string? DisplayName);

/// <summary>
/// Perfil del usuario actual (M3.1-S07): respuesta de <c>GET</c> y <c>PATCH /api/v1/me</c>. <see cref="Id"/> es el <c>Users.Id</c> INTERNO
/// (resuelto por <c>IUserContext</c>, nunca enviado por el cliente). <see cref="Email"/> es de SOLO LECTURA. <see cref="ManagedFields"/> lista los
/// campos que gestiona la cuenta/identidad y no se editan en el perfil (hoy <c>["email"]</c>). NUNCA incluye proveedor, subject, hash ni stamp.
/// </summary>
public sealed record ProfileResponse(
    Guid Id,
    string? Email,
    string DisplayName,
    DateTimeOffset CreatedAt,
    IReadOnlyList<string> ManagedFields);

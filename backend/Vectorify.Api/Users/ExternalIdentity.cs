namespace Vectorify.Api.Users;

/// <summary>
/// Identidad EXTERNA ya autenticada, normalizada e independiente de quien la haya autenticado (ASP.NET Core Identity con
/// cookie hoy; un emisor OIDC gestionado mañana). Es lo único que el resto de VECTORiZE sabe del proveedor: el par
/// (<see cref="Provider"/>, <see cref="Subject"/>) identifica a la persona en el proveedor y se mapea a un
/// <c>User.Id</c> interno (ver <see cref="IUserProvisioner"/>). El email es un dato de contacto, NO identidad.
/// </summary>
public sealed record ExternalIdentity(string Provider, string Subject, string? Email, string? DisplayName);

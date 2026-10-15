namespace Vectorify.Api.Data;

/// <summary>
/// Identidad de dueño de un <see cref="Project"/> (M2.2-S02, modelo real de dominio).
/// <see cref="ExternalIdentityId"/> y <see cref="Email"/> quedan nullable a propósito:
/// esta tarjeta NO implementa auth real (ver "Fuera de alcance" de spec.md) -- son
/// columnas preparadas para cuando M2.2-S09 (User Ownership + DevelopmentUserContext)
/// las use de verdad. No tiene relación con ningún registry de archivos JSON existente.
/// </summary>
public sealed class User
{
    public Guid Id { get; set; }

    public string? ExternalIdentityId { get; set; }

    public string? Email { get; set; }

    public string DisplayName { get; set; } = string.Empty;

    public DateTimeOffset CreatedAt { get; set; }

    public ICollection<Project> Projects { get; set; } = new List<Project>();

    /// <summary>Identidades (proveedor + sujeto) vinculadas a este usuario (M3.1-S02). <see cref="ExternalIdentityId"/> queda obsoleta y sin uso.</summary>
    public ICollection<UserIdentity> Identities { get; set; } = new List<UserIdentity>();
}

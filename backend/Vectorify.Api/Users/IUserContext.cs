namespace Vectorify.Api.Users;

/// <summary>
/// Abstracción mínima del "usuario efectivo de esta request" (M2.2-S03, ampliada en M2.2-S09):
/// lo único que <see cref="Vectorify.Api.ProjectManagement.ProjectService"/>/
/// <see cref="Vectorify.Api.Projects.Persistence.IProjectRepository"/> y el resto de la capa v2
/// necesitan para que el filtrado por <c>Project.OwnerId</c> sea REAL (nunca un no-op). Todo
/// el código de aplicación depende de ESTA interfaz, nunca de la implementación concreta:
/// MVP 3.1 reemplaza <see cref="DevelopmentUserContext"/> por un contexto autenticado (p. ej.
/// <c>AuthenticatedUserContext</c>, leyendo un <c>ClaimsPrincipal</c>) cambiando únicamente el
/// registro en <see cref="UserContextRegistration"/>, sin tocar Project/Asset/VectorDocument.
/// </summary>
public interface IUserContext
{
    /// <summary>Id del usuario dueño de la request actual.</summary>
    Guid GetEffectiveUserId();

    /// <summary>Email del usuario efectivo, si se conoce (opcional: puede ser null).</summary>
    string? Email { get; }

    /// <summary>
    /// true si la identidad del usuario efectivo ya está resuelta. NO significa "demostrada":
    /// <see cref="DevelopmentUserContext"/> devuelve true sin verificar nada (demostrar quién
    /// es el usuario es alcance de MVP 3.1).
    /// </summary>
    bool IsAuthenticated { get; }
}

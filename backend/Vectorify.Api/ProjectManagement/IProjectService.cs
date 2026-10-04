using Vectorify.Api.Projects.Persistence;

namespace Vectorify.Api.ProjectManagement;

/// <summary>
/// Capa de aplicación entre ProjectV2Endpoints e IProjectRepository (M2.2-S03): valida
/// reglas de negocio (nombre requerido/longitud razonable) y resuelve el usuario efectivo
/// (vía IUserContext) ANTES de llegar al repositorio -- ningún endpoint llama a
/// IProjectRepository directamente. Ver spec.md, "Arquitectura".
/// </summary>
public interface IProjectService
{
    /// <summary>
    /// <paramref name="classicLink"/> (M2.2-S08): triple clásico a persistir con el Project cuando lo
    /// crea el primer Save de un Workspace; null para la creación "vacía" de <c>POST /api/v2/projects</c>.
    /// </summary>
    Task<ProjectResult> CreateAsync(
        string? name, string? description, CancellationToken cancellationToken, ClassicProjectLink? classicLink = null);

    Task<ProjectResult> GetAsync(Guid id, CancellationToken cancellationToken);

    Task<ProjectResult> ListAsync(
        int? page, int? pageSize, string? search, string? sortBy, CancellationToken cancellationToken);

    Task<ProjectResult> UpdateAsync(Guid id, string? name, string? description, CancellationToken cancellationToken);

    Task<ProjectResult> DeleteAsync(Guid id, CancellationToken cancellationToken);

    Task<ProjectResult> DuplicateAsync(Guid id, CancellationToken cancellationToken);
}

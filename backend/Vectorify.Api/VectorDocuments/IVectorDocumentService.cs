using Vectorify.Api.Contracts;

namespace Vectorify.Api.VectorDocuments;

/// <summary>
/// Capa de aplicación entre <c>VectorDocumentEndpoints</c> y
/// <see cref="Persistence.IVectorDocumentRepository"/> (M2.2-S05/S06): resuelve ownership (vía
/// <see cref="Vectorify.Api.Users.IUserContext"/>), orquesta la lectura del estado clásico
/// VIGENTE (nunca confía en geometría/metadata del cliente), sube cada SVG de capa como
/// <see cref="Vectorify.Api.Data.Asset"/> y delega la escritura transaccional del grafo
/// completo al repositorio. Ningún endpoint llama a
/// <see cref="Persistence.IVectorDocumentRepository"/> directamente.
/// </summary>
public interface IVectorDocumentService
{
    Task<VectorDocumentResult> SaveAsync(VectorDocumentSaveRequest request, CancellationToken cancellationToken);

    /// <summary>
    /// Una DocumentVersion completa: la ACTUAL si <paramref name="versionNumber"/> es null
    /// (<c>GET .../document</c>), o la versión explícita indicada (<c>GET .../versions/{n}</c>,
    /// M2.2-S06) -- MISMO método de servicio para ambos endpoints, parametrizado por
    /// "actual" vs "número explícito" (spec.md M2.2-S06: "no se duplica lógica entre ambos").
    /// </summary>
    Task<VectorDocumentResult> GetDocumentAsync(Guid projectId, int? versionNumber, CancellationToken cancellationToken);

    /// <summary>Todas las versiones del documento de un proyecto, solo metadata (<c>GET .../versions</c>, M2.2-S06).</summary>
    Task<VectorDocumentResult> ListVersionsAsync(Guid projectId, CancellationToken cancellationToken);

    /// <summary>Restaura <paramref name="versionNumber"/> como una versión nueva (<c>POST .../versions/{n}/restore</c>, M2.2-S06).</summary>
    Task<VectorDocumentResult> RestoreAsync(Guid projectId, int versionNumber, CancellationToken cancellationToken);

    Task<VectorDocumentResult> UpdateLayerAsync(
        Guid projectId, Guid layerId, UpdateLayerRequest request, CancellationToken cancellationToken);

    /// <summary>
    /// Persiste el estado completo de geometría del editor como una nueva DocumentVersion
    /// (M3-S13: <c>POST /api/v2/projects/{projectId}/document/editor-save</c>). El cliente
    /// manda el SVG serializado de TODAS las capas; el servidor lo sube como Assets y crea
    /// la versión. Soporta idempotencia (misma key = mismo resultado), ownership (solo el
    /// dueño del proyecto), y concurrencia optimista (xmin → 409).
    /// </summary>
    Task<VectorDocumentResult> EditorSaveAsync(
        Guid projectId, EditorSaveRequest request, CancellationToken cancellationToken);
}

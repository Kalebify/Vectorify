using Vectorify.Api.Data;

namespace Vectorify.Api.VectorDocuments;

/// <summary>
/// Resultado compartido por las operaciones de <see cref="IVectorDocumentService"/> (M2.2-S05)
/// -- mismo patrón de result type discriminado que
/// <see cref="Vectorify.Api.ProjectManagement.ProjectResult"/>/<see cref="Vectorify.Api.Assets.AssetResult"/>,
/// para que <c>VectorDocumentEndpoints</c> traduzca cada caso a un código HTTP sin excepciones
/// de control de flujo.
/// </summary>
public abstract record VectorDocumentResult
{
    private VectorDocumentResult()
    {
    }

    /// <summary>Un Save exitoso (crea o agrega una versión), el endpoint responde 201/200 según corresponda.</summary>
    public sealed record Saved(Guid ProjectId, int VersionNumber, DateTimeOffset SavedAt) : VectorDocumentResult;

    /// <summary>
    /// Replay de un Save ya realizado antes con la MISMA idempotencyKey (M2.2-S07) -- no se creó
    /// nada nuevo (ni Project, ni DocumentVersion, ni se re-resolvió el estado clásico/re-subió
    /// ningún SVG), se devuelve tal cual el resultado de la vez anterior. SIEMPRE 200, incluso si
    /// el intento ORIGINAL (la primera vez que se vio esa key) hubiera sido un 201 -- mismo
    /// criterio que <see cref="Vectorify.Api.Projects.ProjectUploadResult.Replayed"/>.
    /// </summary>
    public sealed record Replayed(Guid ProjectId, int VersionNumber, DateTimeOffset SavedAt) : VectorDocumentResult;

    /// <summary>
    /// Una DocumentVersion completa -- la ACTUAL (GET .../document) o una histórica cualquiera
    /// (GET .../versions/{versionNumber}, M2.2-S06) -- el endpoint responde 200.
    /// </summary>
    public sealed record DocumentReady(VectorDocument Document, DocumentVersion Version) : VectorDocumentResult;

    /// <summary>TODAS las DocumentVersion de un documento, solo metadata (GET .../versions, M2.2-S06), el endpoint responde 200.</summary>
    public sealed record VersionListReady(IReadOnlyList<DocumentVersion> Versions) : VectorDocumentResult;

    /// <summary>Un Layer individual recién actualizado (PATCH .../layers/{layerId}), el endpoint responde 200.</summary>
    public sealed record LayerReady(Layer Layer) : VectorDocumentResult;

    /// <summary>
    /// No existe un proyecto con ese Id, O existe pero pertenece a otro usuario, O (para
    /// PATCH de un layer) no existe esa capa en la versión ACTUAL de ese proyecto -- mismo
    /// caso para todos (el endpoint responde 404, nunca 403: no revela que el recurso existe
    /// a un usuario no autorizado, mismo criterio que M2.2-S03/S04).
    /// </summary>
    public sealed record NotFound(string Code, string Message) : VectorDocumentResult;

    /// <summary>Nombre de proyecto inválido, parámetros del request inválidos/vacíos, operación de fabricación desconocida (el endpoint responde 400).</summary>
    public sealed record ValidationFailed(string Code, string Message) : VectorDocumentResult;

    /// <summary>Concurrencia optimista: el Project fue modificado por otro Save concurrente entre la lectura y la escritura (el endpoint responde 409).</summary>
    public sealed record Conflict(string Code, string Message) : VectorDocumentResult;

    /// <summary>
    /// Fallo resolviendo/leyendo el estado clásico vigente (layer set inexistente, paleta no
    /// confirmada, SVG de una capa ya no disponible en storage, etc.) o SchemaVersion no
    /// soportado al reabrir -- mapeado siempre a 422, mismo criterio documentado en spec.md
    /// M2.2-S05.
    /// </summary>
    public sealed record UpstreamError(string Code, string Message) : VectorDocumentResult;
}

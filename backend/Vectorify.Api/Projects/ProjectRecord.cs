namespace Vectorify.Api.Projects;

/// <summary>
/// Metadatos de un proyecto creado a partir de una imagen. Vive en memoria para
/// lecturas O(1) y se persiste como sidecar JSON en disco (ver
/// <see cref="PersistentProjectRegistry"/>), así que sobrevive a un reinicio de la
/// Web API aunque todavía no haya una base de datos de negocio (ver Fuera de alcance
/// de M1-S01/M1-S02).
/// </summary>
/// <param name="OwnerId">
/// M2.2-S09: usuario efectivo que subió la imagen. <c>null</c> = registro previo a esta tarjeta
/// (JSON viejo en disco) o sin dueño conocido: sigue siendo accesible por cualquiera, no se
/// puede inferir un dueño retroactivamente. Solo lo hacen valer el puente hacia v2
/// (<c>VectorDocumentService.SaveAsync</c>) y <c>GET /api/v1/projects/.../images/...</c>; el resto
/// del pipeline clásico se direcciona por Guid sin dueño (limitación conocida, hardening de MVP 3.1).
/// </param>
public sealed record ProjectRecord(
    Guid ProjectId,
    Guid ImageId,
    string FileName,
    string MimeType,
    long Bytes,
    int? Width,
    int? Height,
    string Status,
    string StorageKey,
    string? IdempotencyKey,
    DateTimeOffset CreatedAt,
    Guid? OwnerId = null)
{
    /// <summary>
    /// true si <paramref name="userId"/> puede ver este registro: es su dueño, o el registro no
    /// tiene dueño (previo a M2.2-S09). Un registro ajeno debe tratarse como INEXISTENTE (404
    /// uniforme), nunca como 403.
    /// </summary>
    public bool IsAccessibleBy(Guid userId) => OwnerId is null || OwnerId == userId;
}

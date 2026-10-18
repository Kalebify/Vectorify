namespace Vectorify.Api.Projects;

/// <summary>
/// Metadatos de un proyecto creado a partir de una imagen. Vive en memoria para
/// lecturas O(1) y se persiste como sidecar JSON en disco (ver
/// <see cref="PersistentProjectRegistry"/>), así que sobrevive a un reinicio de la
/// Web API aunque todavía no haya una base de datos de negocio (ver Fuera de alcance
/// de M1-S01/M1-S02).
/// </summary>
/// <param name="OwnerId">
/// Usuario efectivo que subió la imagen. <c>null</c> = registro LEGADO (JSON de antes de M2.2-S09) sin dueño conocido: no se puede
/// inferir un dueño retroactivamente. Desde M3.1-S06 un registro sin dueño NO es accesible por ningún usuario autenticado (falla
/// cerrado); solo el usuario de desarrollo (<c>Auth:Mode=Development</c>) conserva el acceso. La decisión se toma en UN solo lugar
/// (<see cref="IClassicProjectAccess"/>) y la aplica a todo el flujo clásico <see cref="Vectorify.Api.Authorization.ClassicProjectOwnerMiddleware"/>.
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
    /// true si <paramref name="userId"/> es el dueño del registro. Un registro SIN dueño (legado) solo es accesible si
    /// <paramref name="allowOwnerless"/> (modo <c>Auth:Mode=Development</c>); en modo Authenticated nadie lo alcanza. Un registro
    /// ajeno debe tratarse como INEXISTENTE (404 uniforme), nunca como 403.
    /// </summary>
    public bool IsAccessibleBy(Guid userId, bool allowOwnerless) => OwnerId is null ? allowOwnerless : OwnerId == userId;
}

using Microsoft.Extensions.Options;
using Vectorify.Api.Options;
using Vectorify.Api.Users;

namespace Vectorify.Api.Projects;

/// <summary>
/// Servicio ÚNICO de acceso por dueño al flujo clásico (M3.1-S06): decide si el usuario efectivo de la request (<c>IUserContext</c>,
/// nunca un dato del cliente) puede ver un <see cref="ProjectRecord"/>. Lo usan el middleware central de la jerarquía
/// <c>/api/v1/projects/{projectId}/images/{imageId}/…</c>, el replay de idempotencia de la carga y el puente clásico -&gt; v2: ninguno
/// repite la regla.
/// </summary>
public interface IClassicProjectAccess
{
    /// <summary>true si el usuario efectivo puede acceder a <paramref name="record"/>.</summary>
    bool IsAccessible(ProjectRecord record);

    /// <summary>
    /// El registro del par (<paramref name="projectId"/>, <paramref name="imageId"/>) SOLO si existe Y es accesible; <c>null</c> para el
    /// inexistente y para el ajeno por igual (quien llama no puede distinguirlos).
    /// </summary>
    ProjectRecord? FindAccessible(Guid projectId, Guid imageId);
}

/// <summary>
/// Regla de dueño del flujo clásico: el registro es accesible si su <c>OwnerId</c> es el usuario efectivo. Un registro LEGADO sin dueño
/// (<c>OwnerId == null</c>) falla CERRADO en <see cref="AuthMode.Authenticated"/> (nadie lo alcanza: no hay forma de saber de quién es)
/// y sigue accesible solo en <see cref="AuthMode.Development"/> para el usuario de desarrollo. El destino definitivo de esos datos es
/// una decisión humana abierta (ADR P10, docs/AUTH_AUTHORIZATION.md).
/// </summary>
public sealed class ClassicProjectAccess : IClassicProjectAccess
{
    private readonly IProjectRegistry _registry;
    private readonly IUserContext _userContext;
    private readonly bool _allowOwnerless;

    public ClassicProjectAccess(IProjectRegistry registry, IUserContext userContext, IOptions<AuthOptions> authOptions)
    {
        _registry = registry;
        _userContext = userContext;
        _allowOwnerless = authOptions.Value.Mode == AuthMode.Development;
    }

    public bool IsAccessible(ProjectRecord record) =>
        _userContext.IsAuthenticated && record.IsAccessibleBy(_userContext.GetEffectiveUserId(), _allowOwnerless);

    public ProjectRecord? FindAccessible(Guid projectId, Guid imageId)
    {
        var record = _registry.Find(projectId, imageId);
        return record is not null && IsAccessible(record) ? record : null;
    }
}

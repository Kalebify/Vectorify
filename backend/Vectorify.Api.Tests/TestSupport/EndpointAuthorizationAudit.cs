using System.Text.RegularExpressions;

namespace Vectorify.Api.Tests.TestSupport;

/// <summary>
/// Auditor de ARQUITECTURA de la autorización (M3.1-S06): dado el inventario real de rutas, devuelve las que incumplen las reglas.
/// Toda ruta <c>/api/*</c> debe (1) heredar la denegación por defecto (sin <c>AllowAnonymous</c>) salvo que figure en
/// <see cref="AnonymousAllowlist"/> y (2) tener comprobación de dueño: estar en el grupo central del flujo clásico, o figurar en
/// <see cref="ServiceEnforcedOwnerAllowlist"/> (el servicio/repositorio filtra por <c>IUserContext</c>) o en
/// <see cref="NoProjectResourceAllowlist"/> (no direcciona un recurso de otro usuario). Las tres listas son EXPLÍCITAS y justificadas: añadir
/// una ruta sin protección, o añadirla a una lista sin pensarlo, obliga a tocar este archivo y a justificarlo en la revisión.
/// </summary>
public static partial class EndpointAuthorizationAudit
{
    /// <summary>Rutas anónimas (lista blanca mínima, ADR «Impacto concreto en S06»). Swagger no es un endpoint: es middleware previo a la autorización y solo se monta en Development.</summary>
    public static readonly IReadOnlyDictionary<string, string> AnonymousAllowlist = new Dictionary<string, string>
    {
        ["GET /health"] = "Liveness para el orquestador/Docker: no toca datos de usuarios.",
        ["GET /api/v1/system/health"] = "Estado de la API/Postgres/Python que consume la SPA antes de iniciar sesión; sin datos de usuarios.",
        ["POST /api/v1/auth/register"] = "Nadie tiene sesión antes de registrarse; respuesta uniforme (T5).",
        ["POST /api/v1/auth/login"] = "Nadie tiene sesión antes de entrar; 401 uniforme y bloqueo (T5/T6).",
        ["POST /api/v1/auth/logout"] = "Idempotente: sin sesión (o caducada) responde 204; no expone datos.",
        ["GET /api/v1/auth/me"] = "En Auth:Mode=Development no hay login y la SPA necesita 200 sin cookie; en Authenticated responde 401 por sí mismo sin identidad verificada.",
    };

    /// <summary>Rutas con dueño verificado por el servicio/repositorio con <c>IUserContext</c> (404 uniforme), no por el grupo clásico.</summary>
    public static readonly IReadOnlyDictionary<string, string> ServiceEnforcedOwnerAllowlist = new Dictionary<string, string>
    {
        ["GET /api/v2/projects/{id:guid}"] = "ProjectService/ProjectRepository: WHERE Id AND OwnerId = IUserContext (una consulta).",
        ["PATCH /api/v2/projects/{id:guid}"] = "ProjectService/ProjectRepository: WHERE Id AND OwnerId = IUserContext.",
        ["DELETE /api/v2/projects/{id:guid}"] = "ProjectService/ProjectRepository: WHERE Id AND OwnerId = IUserContext.",
        ["POST /api/v2/projects/{id:guid}/duplicate"] = "ProjectService/ProjectRepository: el origen se busca con OwnerId = IUserContext y la copia lo hereda del servidor.",
        ["POST /api/v2/projects/{projectId:guid}/assets"] = "AssetService: el Project se resuelve con OwnerId = IUserContext antes de tocar el storage.",
        ["GET /api/v2/projects/{projectId:guid}/assets/{assetId:guid}"] = "AssetService: Project propio + Asset de ESE proyecto; es la descarga por URL directa (cookie).",
        ["DELETE /api/v2/projects/{projectId:guid}/assets/{assetId:guid}"] = "AssetService: Project propio + Asset de ESE proyecto.",
        ["GET /api/v2/projects/{projectId:guid}/document"] = "VectorDocumentRepository: WHERE Id AND OwnerId = IUserContext.",
        ["GET /api/v2/projects/{projectId:guid}/versions"] = "VectorDocumentRepository: WHERE Id AND OwnerId = IUserContext.",
        ["GET /api/v2/projects/{projectId:guid}/versions/{versionNumber:int}"] = "VectorDocumentRepository: WHERE Id AND OwnerId = IUserContext.",
        ["POST /api/v2/projects/{projectId:guid}/versions/{versionNumber:int}/restore"] = "VectorDocumentRepository: WHERE Id AND OwnerId = IUserContext.",
        ["POST /api/v2/projects/{projectId:guid}/document/editor-save"] = "VectorDocumentService/Repository: WHERE Id AND OwnerId = IUserContext; la clave de idempotencia se prefija con el dueño.",
        ["PATCH /api/v2/projects/{projectId:guid}/layers/{layerId:guid}"] = "VectorDocumentRepository: WHERE Id AND OwnerId = IUserContext.",
    };

    /// <summary>Rutas que no direccionan un recurso existente de otro usuario.</summary>
    public static readonly IReadOnlyDictionary<string, string> NoProjectResourceAllowlist = new Dictionary<string, string>
    {
        ["POST /api/v1/projects"] = "Alta: el OwnerId lo pone el servidor (IUserContext); nada ajeno que direccionar. Replay de idempotencia solo del mismo dueño.",
        ["POST /api/v2/projects"] = "Alta: OwnerId = IUserContext; el body no tiene campo de dueño.",
        ["GET /api/v2/projects"] = "Listado: WHERE OwnerId = IUserContext.",
        ["POST /api/v2/workspaces/save"] = "Los ids del body se resuelven con el dueño del servidor: ProjectId (v2) por repositorio y el triple clásico por IClassicProjectAccess; ajeno e inexistente = 404.",
        ["POST /api/v1/auth/logout-all"] = "Opera sobre la cuenta de la propia sesión (RequireAuthorization); no recibe ids.",
        ["POST /api/v2/geometry/boolean"] = "Cálculo SIN estado: recibe y devuelve coordenadas; no lee ni escribe recursos.",
        ["POST /api/v2/geometry/offset"] = "Cálculo SIN estado: recibe y devuelve coordenadas; no lee ni escribe recursos.",
        ["POST /api/v2/geometry/split"] = "Cálculo SIN estado: recibe y devuelve coordenadas; no lee ni escribe recursos.",
        ["POST /api/v2/geometry/floating"] = "Cálculo SIN estado: recibe y devuelve coordenadas; no lee ni escribe recursos.",
        ["POST /api/v2/geometry/bridge"] = "Cálculo SIN estado: recibe y devuelve coordenadas; no lee ni escribe recursos.",
    };

    [GeneratedRegex(@"\{(projectId|id)[:}]", RegexOptions.IgnoreCase)]
    private static partial Regex ProjectIdentifierParameter();

    /// <summary>Rutas que la auditoría considera «de la API» (todo bajo /api/ más la liveness raíz).</summary>
    public static bool IsApiRoute(ApiRoute route) => route.Pattern.StartsWith("/api/", StringComparison.Ordinal) || route.Pattern == "/health";

    /// <summary>Violaciones (vacío = cumple). Cada una es un mensaje accionable.</summary>
    public static IReadOnlyList<string> Evaluate(IEnumerable<ApiRoute> routes)
    {
        var violations = new List<string>();
        var apiRoutes = routes.Where(IsApiRoute).ToList();

        foreach (var route in apiRoutes)
        {
            // 1) Denegación por defecto: solo la lista blanca anónima puede llevar AllowAnonymous.
            if (route.AllowsAnonymous && !AnonymousAllowlist.ContainsKey(route.Key))
            {
                violations.Add($"{route.Key}: es anónima (AllowAnonymous) y no figura en AnonymousAllowlist.");
            }

            if (!route.AllowsAnonymous && AnonymousAllowlist.ContainsKey(route.Key))
            {
                violations.Add($"{route.Key}: figura en AnonymousAllowlist pero NO es anónima (lista desactualizada).");
            }

            if (route.AllowsAnonymous)
            {
                continue; // las anónimas no tienen dueño que comprobar
            }

            // 2) Comprobación de dueño: exactamente UNA categoría.
            var inGroup = route.IsInClassicProjectGroup;
            var serviceEnforced = ServiceEnforcedOwnerAllowlist.ContainsKey(route.Key);
            var noResource = NoProjectResourceAllowlist.ContainsKey(route.Key);
            var categories = new[] { inGroup, serviceEnforced, noResource }.Count(c => c);

            if (categories == 0)
            {
                violations.Add(
                    $"{route.Key}: sin comprobación de dueño. Mapéala dentro de MapClassicProjectGroup() (flujo clásico) o, si el servicio filtra " +
                    "por IUserContext / no direcciona recursos ajenos, justifícala en las listas blancas de EndpointAuthorizationAudit.");
            }
            else if (categories > 1)
            {
                violations.Add($"{route.Key}: figura en más de una categoría de protección de dueño.");
            }

            // Una ruta que direcciona un proyecto por su id no puede estar exenta como «sin recurso».
            if (noResource && ProjectIdentifierParameter().IsMatch(route.Pattern))
            {
                violations.Add($"{route.Key}: direcciona un proyecto por id pero está exenta como «sin recurso».");
            }
        }

        // 3) Las listas no pueden apuntar a rutas que ya no existen (se pudrirían y esconderían huecos).
        var existing = apiRoutes.Select(r => r.Key).ToHashSet();
        foreach (var (name, list) in new[]
                 {
                     ("AnonymousAllowlist", AnonymousAllowlist),
                     ("ServiceEnforcedOwnerAllowlist", ServiceEnforcedOwnerAllowlist),
                     ("NoProjectResourceAllowlist", NoProjectResourceAllowlist),
                 })
        {
            foreach (var key in list.Keys.Where(k => !existing.Contains(k)))
            {
                violations.Add($"{name}: «{key}» no existe en el EndpointDataSource (lista desactualizada).");
            }
        }

        return violations;
    }
}

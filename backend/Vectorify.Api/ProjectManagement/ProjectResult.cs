using Vectorify.Api.Data;
using Vectorify.Api.Projects.Persistence;

namespace Vectorify.Api.ProjectManagement;

/// <summary>
/// Resultado compartido por las operaciones de <see cref="IProjectService"/> -- mismo
/// patrón de result type discriminado que
/// <see cref="Vectorify.Api.LayerLayout.LayerLayoutResult"/>/
/// <see cref="Vectorify.Api.ColorPalette.ColorPaletteResult"/> usan en el resto del
/// proyecto, para que ProjectV2Endpoints traduzca cada caso a un código HTTP sin excepciones
/// de control de flujo.
/// </summary>
public abstract record ProjectResult
{
    private ProjectResult()
    {
    }

    /// <summary>Un único Project listo (create/get/update/duplicate), el endpoint responde 200/201.</summary>
    public sealed record Ready(Project Record) : ProjectResult;

    /// <summary>Página de proyectos (list), con el total real (antes de paginar) para que el cliente calcule cuántas páginas hay.</summary>
    public sealed record ListReady(IReadOnlyList<ProjectListItem> Items, int TotalCount, int Page, int PageSize) : ProjectResult;

    /// <summary>Soft-delete aplicado (el endpoint responde 204, sin cuerpo).</summary>
    public sealed record Deleted : ProjectResult;

    /// <summary>
    /// No existe un proyecto con ese Id, O existe pero pertenece a otro OwnerId -- mismo
    /// caso para ambos (el endpoint responde 404, nunca 403: no revela que el recurso
    /// existe a un usuario no autorizado, ver spec.md).
    /// </summary>
    public sealed record NotFound(string Code, string Message) : ProjectResult;

    /// <summary>Nombre vacío/demasiado largo, descripción demasiado larga, parámetros de listado inválidos (el endpoint responde 400).</summary>
    public sealed record ValidationFailed(string Code, string Message) : ProjectResult;

    /// <summary>Concurrencia optimista: el proyecto fue modificado por otra request entre la lectura y la escritura (el endpoint responde 409).</summary>
    public sealed record Conflict(string Code, string Message) : ProjectResult;
}

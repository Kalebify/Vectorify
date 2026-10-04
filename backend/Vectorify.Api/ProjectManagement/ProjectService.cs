using Microsoft.EntityFrameworkCore;
using Vectorify.Api.Projects.Persistence;
using Vectorify.Api.Users;

namespace Vectorify.Api.ProjectManagement;

/// <summary>Implementación de <see cref="IProjectService"/> (M2.2-S03). Ver la interfaz para el rol en la arquitectura.</summary>
public sealed class ProjectService : IProjectService
{
    /// <summary>Longitud máxima razonable de Name -- el spec no fija un número, este es el límite elegido (ver IMPL.md).</summary>
    public const int MaxNameLength = 200;

    /// <summary>Longitud máxima razonable de Description -- mismo criterio que MaxNameLength.</summary>
    public const int MaxDescriptionLength = 2000;

    /// <summary>pageSize por defecto cuando el query param no se envía.</summary>
    public const int DefaultPageSize = 20;

    /// <summary>pageSize máximo permitido -- evita abuso (ver spec.md, "Ambigüedades detectadas").</summary>
    public const int MaxPageSize = 100;

    private readonly IProjectRepository _repository;
    private readonly IUserContext _userContext;
    private readonly ILogger<ProjectService> _logger;

    public ProjectService(IProjectRepository repository, IUserContext userContext, ILogger<ProjectService> logger)
    {
        _repository = repository;
        _userContext = userContext;
        _logger = logger;
    }

    public async Task<ProjectResult> CreateAsync(
        string? name, string? description, CancellationToken cancellationToken, ClassicProjectLink? classicLink = null)
    {
        var nameValidation = ValidateName(name, out var trimmedName);
        if (nameValidation is not null)
        {
            return nameValidation;
        }

        var descriptionValidation = ValidateDescription(description);
        if (descriptionValidation is not null)
        {
            return descriptionValidation;
        }

        var ownerId = _userContext.GetEffectiveUserId();
        var project = await _repository.CreateAsync(ownerId, trimmedName, description, cancellationToken, classicLink);

        _logger.LogInformation("Proyecto {ProjectId} creado para el usuario {OwnerId}", project.Id, ownerId);

        return new ProjectResult.Ready(project);
    }

    public async Task<ProjectResult> GetAsync(Guid id, CancellationToken cancellationToken)
    {
        var ownerId = _userContext.GetEffectiveUserId();
        var project = await _repository.FindByIdAsync(id, ownerId, cancellationToken);

        return project is null
            ? NotFoundResult()
            : new ProjectResult.Ready(project);
    }

    public async Task<ProjectResult> ListAsync(
        int? page, int? pageSize, string? search, string? sortBy, CancellationToken cancellationToken)
    {
        var resolvedPage = page is > 0 ? page.Value : 1;
        var resolvedPageSize = pageSize is > 0 ? Math.Min(pageSize.Value, MaxPageSize) : DefaultPageSize;

        if (!TryParseSortBy(sortBy, out var parsedSortBy))
        {
            return new ProjectResult.ValidationFailed(
                "invalid_sort", "sortBy debe ser 'LastModified', 'Name' o 'Created'.");
        }

        var ownerId = _userContext.GetEffectiveUserId();
        var query = new ProjectListQuery(resolvedPage, resolvedPageSize, search, parsedSortBy);
        var (items, totalCount) = await _repository.ListAsync(ownerId, query, cancellationToken);

        return new ProjectResult.ListReady(items, totalCount, resolvedPage, resolvedPageSize);
    }

    public async Task<ProjectResult> UpdateAsync(Guid id, string? name, string? description, CancellationToken cancellationToken)
    {
        // Semántica de PATCH elegida (ver IMPL.md): un campo null = "sin cambios". Para
        // Name, además se valida/trimea si viene no-null. Description null = sin cambios;
        // para vaciarla explícitamente, el cliente debe enviar "" (string vacío no-null).
        string? trimmedName = null;
        if (name is not null)
        {
            var nameValidation = ValidateName(name, out trimmedName);
            if (nameValidation is not null)
            {
                return nameValidation;
            }
        }

        var descriptionValidation = ValidateDescription(description);
        if (descriptionValidation is not null)
        {
            return descriptionValidation;
        }

        var ownerId = _userContext.GetEffectiveUserId();

        try
        {
            var project = await _repository.UpdateAsync(id, ownerId, trimmedName, description, cancellationToken);
            return project is null
                ? NotFoundResult()
                : new ProjectResult.Ready(project);
        }
        catch (DbUpdateConcurrencyException ex)
        {
            _logger.LogWarning(
                ex, "Conflicto de concurrencia actualizando el proyecto {ProjectId} (OwnerId {OwnerId})", id, ownerId);
            return new ProjectResult.Conflict(
                "concurrency_conflict",
                "El proyecto fue modificado por otra solicitud mientras tanto. Volvé a cargarlo e intentá de nuevo.");
        }
    }

    public async Task<ProjectResult> DeleteAsync(Guid id, CancellationToken cancellationToken)
    {
        var ownerId = _userContext.GetEffectiveUserId();
        var deleted = await _repository.SoftDeleteAsync(id, ownerId, cancellationToken);

        return deleted
            ? new ProjectResult.Deleted()
            : NotFoundResult();
    }

    public async Task<ProjectResult> DuplicateAsync(Guid id, CancellationToken cancellationToken)
    {
        var ownerId = _userContext.GetEffectiveUserId();

        var source = await _repository.FindByIdAsync(id, ownerId, cancellationToken);
        if (source is null)
        {
            return NotFoundResult();
        }

        var duplicate = await _repository.DuplicateAsync(id, ownerId, $"Copia de {source.Name}", cancellationToken);
        if (duplicate is null)
        {
            // El original existía en el Find de arriba pero ya no en el Duplicate (p. ej.
            // se borró entre medio) -- mismo 404 que cualquier otro "no existe".
            return NotFoundResult();
        }

        _logger.LogInformation(
            "Proyecto {SourceId} duplicado como {DuplicateId} para el usuario {OwnerId}", id, duplicate.Id, ownerId);

        return new ProjectResult.Ready(duplicate);
    }

    private static ProjectResult.NotFound NotFoundResult() =>
        new("not_found", "No existe un proyecto con ese Id.");

    private static ProjectResult.ValidationFailed? ValidateName(string? name, out string trimmedName)
    {
        trimmedName = string.Empty;

        if (string.IsNullOrWhiteSpace(name))
        {
            return new ProjectResult.ValidationFailed("invalid_name", "El nombre del proyecto es requerido.");
        }

        var trimmed = name.Trim();
        if (trimmed.Length > MaxNameLength)
        {
            return new ProjectResult.ValidationFailed(
                "invalid_name", $"El nombre no puede superar los {MaxNameLength} caracteres.");
        }

        trimmedName = trimmed;
        return null;
    }

    private static ProjectResult.ValidationFailed? ValidateDescription(string? description)
    {
        if (description is not null && description.Length > MaxDescriptionLength)
        {
            return new ProjectResult.ValidationFailed(
                "invalid_description", $"La descripción no puede superar los {MaxDescriptionLength} caracteres.");
        }

        return null;
    }

    private static bool TryParseSortBy(string? sortBy, out ProjectSortBy parsed)
    {
        if (string.IsNullOrWhiteSpace(sortBy))
        {
            parsed = ProjectSortBy.LastModified;
            return true;
        }

        return Enum.TryParse(sortBy, ignoreCase: true, out parsed);
    }
}

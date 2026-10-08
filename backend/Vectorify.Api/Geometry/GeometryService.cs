using Vectorify.Api.Clients;
using Vectorify.Api.Contracts;

namespace Vectorify.Api.Geometry;

/// <summary>
/// Implementación de <see cref="IGeometryService"/>: validar -> llamar a Python -> mapear el estado del cliente a un
/// código de error estable. Mismo patrón que Checking.CheckService, sin la parte de localizar un SVG de origen.
/// </summary>
public sealed class GeometryService : IGeometryService
{
    private readonly IGeometryRequestValidator _validator;
    private readonly IPythonGeometryClient _pythonClient;
    private readonly ILogger<GeometryService> _logger;

    public GeometryService(IGeometryRequestValidator validator, IPythonGeometryClient pythonClient, ILogger<GeometryService> logger)
    {
        _validator = validator;
        _pythonClient = pythonClient;
        _logger = logger;
    }

    public async Task<GeometryBooleanResult> BooleanAsync(GeometryBooleanRequest? request, CancellationToken cancellationToken)
    {
        var validation = _validator.Validate(request);
        if (!validation.IsValid)
        {
            return new GeometryBooleanResult.ValidationFailed(validation.ErrorCode!, validation.ErrorMessage!);
        }

        var parameters = validation.Parameters!;
        var pythonResult = await _pythonClient.BooleanAsync(parameters, cancellationToken);

        if (pythonResult.State != PythonGeometryState.Success)
        {
            return new GeometryBooleanResult.UpstreamError(
                MapErrorCode(pythonResult.State),
                pythonResult.Message ?? "No se pudo completar la operación de geometría.");
        }

        _logger.LogInformation(
            "Operación de geometría {Operation} completada ({SubjectCount} subjects, {OperandCount} operands, {PieceCount} piezas)",
            parameters.Operation, parameters.Subjects.Count, parameters.Operands.Count, pythonResult.Response!.PieceCount);

        return new GeometryBooleanResult.Ready(pythonResult.Response);
    }

    private static string MapErrorCode(PythonGeometryState state) => state switch
    {
        PythonGeometryState.InvalidParameters => "invalid_parameters",
        PythonGeometryState.TooLarge => "payload_too_large",
        PythonGeometryState.Timeout => "timeout",
        PythonGeometryState.EngineError => "processing_error",
        PythonGeometryState.Unavailable => "engine_unavailable",
        PythonGeometryState.InvalidResponse => "invalid_response",
        _ => "processing_error",
    };
}

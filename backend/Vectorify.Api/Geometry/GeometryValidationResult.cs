namespace Vectorify.Api.Geometry;

/// <summary>Resultado de validar la petición de una operación de geometría (booleana o offset) recibida del cliente.</summary>
public sealed class GeometryValidationResult
{
    public bool IsValid { get; }
    public string? ErrorCode { get; }
    public string? ErrorMessage { get; }
    public GeometryBooleanParameters? Parameters { get; }

    /// <summary>Parámetros del offset (M3-S09); null en una validación de booleana.</summary>
    public GeometryOffsetParameters? OffsetParameters { get; }

    private GeometryValidationResult(
        bool isValid, string? errorCode, string? errorMessage, GeometryBooleanParameters? parameters, GeometryOffsetParameters? offsetParameters)
    {
        IsValid = isValid;
        ErrorCode = errorCode;
        ErrorMessage = errorMessage;
        Parameters = parameters;
        OffsetParameters = offsetParameters;
    }

    public static GeometryValidationResult Success(GeometryBooleanParameters parameters) =>
        new(true, null, null, parameters, null);

    public static GeometryValidationResult Success(GeometryOffsetParameters parameters) =>
        new(true, null, null, null, parameters);

    public static GeometryValidationResult Failure(string errorCode, string errorMessage) =>
        new(false, errorCode, errorMessage, null, null);
}

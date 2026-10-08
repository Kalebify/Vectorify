namespace Vectorify.Api.Geometry;

/// <summary>Resultado de validar la petición de una operación booleana recibida del cliente.</summary>
public sealed class GeometryValidationResult
{
    public bool IsValid { get; }
    public string? ErrorCode { get; }
    public string? ErrorMessage { get; }
    public GeometryBooleanParameters? Parameters { get; }

    private GeometryValidationResult(bool isValid, string? errorCode, string? errorMessage, GeometryBooleanParameters? parameters)
    {
        IsValid = isValid;
        ErrorCode = errorCode;
        ErrorMessage = errorMessage;
        Parameters = parameters;
    }

    public static GeometryValidationResult Success(GeometryBooleanParameters parameters) =>
        new(true, null, null, parameters);

    public static GeometryValidationResult Failure(string errorCode, string errorMessage) =>
        new(false, errorCode, errorMessage, null);
}

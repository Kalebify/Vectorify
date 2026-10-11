namespace Vectorify.Api.Geometry;

/// <summary>Resultado de validar la petición de una operación de geometría (booleana, offset, corte, piezas flotantes o bridges) recibida del cliente.</summary>
public sealed class GeometryValidationResult
{
    public bool IsValid { get; }
    public string? ErrorCode { get; }
    public string? ErrorMessage { get; }
    public GeometryBooleanParameters? Parameters { get; }

    /// <summary>Parámetros del offset (M3-S09); null en una validación de booleana.</summary>
    public GeometryOffsetParameters? OffsetParameters { get; }

    /// <summary>Parámetros del corte (M3-S10); null en una validación de booleana u offset.</summary>
    public GeometrySplitParameters? SplitParameters { get; }

    /// <summary>Parámetros del análisis de piezas flotantes (M3-S11); null en cualquier otra validación.</summary>
    public GeometryFloatingParameters? FloatingParameters { get; }

    /// <summary>Parámetros de los bridges (M3-S11); null en cualquier otra validación.</summary>
    public GeometryBridgeParameters? BridgeParameters { get; }

    private GeometryValidationResult(
        bool isValid,
        string? errorCode,
        string? errorMessage,
        GeometryBooleanParameters? parameters,
        GeometryOffsetParameters? offsetParameters,
        GeometrySplitParameters? splitParameters = null,
        GeometryFloatingParameters? floatingParameters = null,
        GeometryBridgeParameters? bridgeParameters = null)
    {
        IsValid = isValid;
        ErrorCode = errorCode;
        ErrorMessage = errorMessage;
        Parameters = parameters;
        OffsetParameters = offsetParameters;
        SplitParameters = splitParameters;
        FloatingParameters = floatingParameters;
        BridgeParameters = bridgeParameters;
    }

    public static GeometryValidationResult Success(GeometryBooleanParameters parameters) =>
        new(true, null, null, parameters, null);

    public static GeometryValidationResult Success(GeometryOffsetParameters parameters) =>
        new(true, null, null, null, parameters);

    public static GeometryValidationResult Success(GeometrySplitParameters parameters) =>
        new(true, null, null, null, null, parameters);

    public static GeometryValidationResult Success(GeometryFloatingParameters parameters) =>
        new(true, null, null, null, null, null, parameters);

    public static GeometryValidationResult Success(GeometryBridgeParameters parameters) =>
        new(true, null, null, null, null, null, null, parameters);

    public static GeometryValidationResult Failure(string errorCode, string errorMessage) =>
        new(false, errorCode, errorMessage, null, null);
}

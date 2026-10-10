using Vectorify.Api.Contracts;

namespace Vectorify.Api.Clients;

/// <summary>Resultado tipado, sin excepciones, de pedirle una operación booleana de geometría al motor Python.</summary>
public enum PythonGeometryState
{
    /// <summary>Python devolvió 200 con piezas válidas y coherentes con la petición.</summary>
    Success,

    /// <summary>Python devolvió 422: petición inválida o límites de subjects/vértices excedidos.</summary>
    InvalidParameters,

    /// <summary>Python devolvió 413: cuerpo demasiado grande.</summary>
    TooLarge,

    /// <summary>Python devolvió 504 (geometry_timeout), o la solicitud excedió el tiempo configurado (Geometry:TimeoutSeconds).</summary>
    Timeout,

    /// <summary>Python devolvió 500: fallo inesperado del motor o resultado inválido (geometry_result_invalid).</summary>
    EngineError,

    /// <summary>No se pudo establecer conexión con el motor Python.</summary>
    Unavailable,

    /// <summary>Python respondió pero el cuerpo no es JSON válido, le faltan campos o no pasa la validación defensiva del cliente.</summary>
    InvalidResponse,
}

public sealed record PythonGeometryResult(PythonGeometryState State, GeometryBooleanResponse? Response, string? Message);

/// <summary>Resultado tipado, sin excepciones, del offset (M3-S09) contra el motor Python: mismos estados que las booleanas.</summary>
public sealed record PythonGeometryOffsetResult(PythonGeometryState State, GeometryOffsetResponse? Response, string? Message);

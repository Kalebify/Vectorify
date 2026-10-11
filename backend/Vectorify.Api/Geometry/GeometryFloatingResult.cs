using Vectorify.Api.Contracts;

namespace Vectorify.Api.Geometry;

/// <summary>Resultado del análisis de piezas flotantes del servicio de geometría (M3-S11). Sin caché ni persistencia: sin estado y sin datos del usuario.</summary>
public abstract record GeometryFloatingResult
{
    private GeometryFloatingResult()
    {
    }

    public sealed record Ready(GeometryFloatingResponse Response) : GeometryFloatingResult;

    /// <summary>La petición no pasó la validación (el endpoint responde 400).</summary>
    public sealed record ValidationFailed(string Code, string Message) : GeometryFloatingResult;

    /// <summary>El motor Python falló de una forma controlada (el endpoint mapea el código HTTP correspondiente).</summary>
    public sealed record UpstreamError(string Code, string Message) : GeometryFloatingResult;
}

/// <summary>Resultado de los bridges del servicio de geometría (M3-S11). Sin caché ni persistencia.</summary>
public abstract record GeometryBridgeResult
{
    private GeometryBridgeResult()
    {
    }

    public sealed record Ready(GeometryBridgeResponse Response) : GeometryBridgeResult;

    public sealed record ValidationFailed(string Code, string Message) : GeometryBridgeResult;

    public sealed record UpstreamError(string Code, string Message) : GeometryBridgeResult;
}

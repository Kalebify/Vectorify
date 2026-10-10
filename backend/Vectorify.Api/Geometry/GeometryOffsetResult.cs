using Vectorify.Api.Contracts;

namespace Vectorify.Api.Geometry;

/// <summary>
/// Resultado del offset del servicio de geometría (M3-S09). Sin caché ni persistencia: operación sin estado y sin datos del
/// usuario, cada llamada vuelve a calcular (determinista por construcción).
/// </summary>
public abstract record GeometryOffsetResult
{
    private GeometryOffsetResult()
    {
    }

    public sealed record Ready(GeometryOffsetResponse Response) : GeometryOffsetResult;

    /// <summary>La petición no pasó la validación (el endpoint responde 400).</summary>
    public sealed record ValidationFailed(string Code, string Message) : GeometryOffsetResult;

    /// <summary>El motor Python falló de una forma controlada (el endpoint mapea el código HTTP correspondiente).</summary>
    public sealed record UpstreamError(string Code, string Message) : GeometryOffsetResult;
}

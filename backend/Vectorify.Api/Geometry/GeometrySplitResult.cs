using Vectorify.Api.Contracts;

namespace Vectorify.Api.Geometry;

/// <summary>
/// Resultado del corte del servicio de geometría (M3-S10). Sin caché ni persistencia: operación sin estado y sin datos del usuario,
/// cada llamada vuelve a calcular (determinista por construcción).
/// </summary>
public abstract record GeometrySplitResult
{
    private GeometrySplitResult()
    {
    }

    public sealed record Ready(GeometrySplitResponse Response) : GeometrySplitResult;

    /// <summary>La petición no pasó la validación (el endpoint responde 400).</summary>
    public sealed record ValidationFailed(string Code, string Message) : GeometrySplitResult;

    /// <summary>El motor Python falló de una forma controlada (el endpoint mapea el código HTTP correspondiente).</summary>
    public sealed record UpstreamError(string Code, string Message) : GeometrySplitResult;
}

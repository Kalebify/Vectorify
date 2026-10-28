using Vectorify.Api.Clients;
using Vectorify.Api.VectorLayers;
using Vectorify.Api.Vectorization;

namespace Vectorify.Api.Tests.VectorLayers;

/// <summary>IPythonVectorLayerClient en memoria para tests unitarios de VectorLayerService.</summary>
internal sealed class FakePythonVectorLayerClient : IPythonVectorLayerClient
{
    private int _callCount;

    public int CallCount => _callCount;

    /// <summary>Valor de <c>sharedBoundaries</c> de la última llamada.</summary>
    public bool? LastSharedBoundaries { get; private set; }

    /// <summary>Si se define, sustituye la respuesta default; recibe las máscaras enviadas para poder inspeccionarlas/responder en función de ellas.</summary>
    public Func<IReadOnlyList<(Guid GroupId, Stream Content, string ContentType)>, PythonVectorLayerBatchResult>? Respond { get; set; }

    /// <summary>Retraso artificial antes de responder, para forzar solapamiento en tests de concurrencia.</summary>
    public TimeSpan Delay { get; set; } = TimeSpan.Zero;

    public async Task<PythonVectorLayerBatchResult> VectorizeLayersAsync(
        IReadOnlyList<(Guid GroupId, Stream Content, string ContentType)> masks,
        bool sharedBoundaries = false,
        CancellationToken cancellationToken = default)
    {
        Interlocked.Increment(ref _callCount);
        LastSharedBoundaries = sharedBoundaries;
        if (Delay > TimeSpan.Zero)
        {
            await Task.Delay(Delay, cancellationToken);
        }

        return Respond?.Invoke(masks) ?? DefaultSuccess(masks);
    }

    /// <summary>
    /// Una capa por cada máscara recibida, con el mismo GroupId -- mismo
    /// criterio "eco" que el motor Python real. El SVG trae
    /// `fill="#000000"` hardcodeado deliberadamente -- replica el
    /// comportamiento REAL de VtracerEngine.trace en `colormode="binary"`
    /// (causa raíz de M2.1-S01: siempre negro, sin importar el color de
    /// entrada), así que cualquier test que verifique el fill final
    /// necesita que VectorLayerService lo sobreescriba con el color real del
    /// grupo -- no que "ya viniera bien" por casualidad del fixture.
    /// </summary>
    public static PythonVectorLayerBatchResult DefaultSuccess(
        IReadOnlyList<(Guid GroupId, Stream Content, string ContentType)> masks) => new(
        PythonVectorLayerState.Success,
        masks.Select(mask => new PythonVectorLayerItemResult(
            mask.GroupId,
            "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"10\" height=\"10\"><path d=\"M2,2 L8,2 L8,8 L2,8 Z\" fill=\"#000000\"/></svg>",
            "image/svg+xml",
            10,
            10,
            new VectorMetrics(1, 4, new VectorBounds(2, 2, 8, 8, 6, 6)),
            DefaultRasterValidation())).ToList(),
        Message: null);

    /// <summary>Validación raster-vs-vector "feliz" por defecto (dentro de tolerancia, sin advertencias) -- mismo criterio que el resto del fake, no representa ningún caso de contaminación.</summary>
    public static LayerRasterValidation DefaultRasterValidation() => new(
        OwnMismatchRatio: 0.0,
        OwnMismatchTolerance: 0.15,
        OwnMismatchWithinTolerance: true,
        ContaminationRatio: 0.0,
        ContaminationTolerance: 0.01,
        ContaminationWithinTolerance: true,
        Warnings: Array.Empty<string>());
}

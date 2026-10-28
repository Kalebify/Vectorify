namespace Vectorify.Api.Clients;

/// <summary>
/// Cliente tipado hacia el endpoint de vectorización de capas por color
/// (POST /api/v1/vectorize-layers, M2-S02) del motor Python/FastAPI. Cada
/// etapa del pipeline tiene su propio cliente con su propio timeout (mismo
/// patrón que IPythonVectorizeClient/IPythonColorPaletteClient) -- acá,
/// además, una única llamada envía las N máscaras de una paleta confirmada y
/// recibe las N capas de vuelta en una sola request (ver spec.md,
/// "Ambigüedades detectadas": preferir un round-trip HTTP en vez de N).
/// </summary>
public interface IPythonVectorLayerClient
{
    /// <summary>
    /// Envía las N máscaras binarias (una por <see cref="Vectorify.Api.ColorPalette.ColorGroup"/>
    /// de una paleta confirmada), cada una identificada por su GroupId, y
    /// pide que se vectoricen de forma independiente en una sola llamada.
    /// Nunca lanza excepciones: cualquier falla (offline, timeout, máscara
    /// corrupta/vacía, SVG demasiado grande, respuesta inválida, error HTTP)
    /// se traduce a un <see cref="PythonVectorLayerBatchResult"/> con el
    /// estado correspondiente.
    /// <para>
    /// <paramref name="sharedBoundaries"/>: las máscaras son una PARTICIÓN (ningún píxel en dos
    /// máscaras, p. ej. las familias de color base) y el motor las traza juntas con fronteras
    /// compartidas: dos capas vecinas no se solapan ni dejan rendijas (que, cerradas, eran piezas
    /// flotantes). Si las máscaras comparten píxeles el motor las traza por separado.
    /// </para>
    /// </summary>
    Task<PythonVectorLayerBatchResult> VectorizeLayersAsync(
        IReadOnlyList<(Guid GroupId, Stream Content, string ContentType)> masks,
        bool sharedBoundaries = false,
        CancellationToken cancellationToken = default);
}

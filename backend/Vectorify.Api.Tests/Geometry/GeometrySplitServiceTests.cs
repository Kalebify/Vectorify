using Microsoft.Extensions.Logging.Abstractions;
using Vectorify.Api.Clients;
using Vectorify.Api.Contracts;
using Vectorify.Api.Geometry;
using Vectorify.Api.Options;
using Vectorify.Api.Tests.TestSupport;

namespace Vectorify.Api.Tests.Geometry;

/// <summary>
/// Pruebas unitarias de GeometryService.SplitAsync (M3-S10) con un IPythonGeometryClient en memoria: una petición inválida NO llega a
/// Python, cada estado del cliente se mapea a su código estable y el resultado de Python pasa tal cual.
/// </summary>
public sealed class GeometrySplitServiceTests
{
    private sealed class FakePythonGeometryClient : IPythonGeometryClient
    {
        public Task<PythonGeometryFloatingResult> FloatingAsync(GeometryFloatingParameters parameters, CancellationToken cancellationToken = default) =>
            throw new NotSupportedException("Estas pruebas no piden piezas flotantes.");

        public Task<PythonGeometryBridgeResult> BridgeAsync(GeometryBridgeParameters parameters, CancellationToken cancellationToken = default) =>
            throw new NotSupportedException("Estas pruebas no piden bridges.");

        public int CallCount { get; private set; }
        public GeometrySplitParameters? LastParameters { get; private set; }
        public Func<PythonGeometrySplitResult> Respond { get; set; } = () => new PythonGeometrySplitResult(
            PythonGeometryState.Success,
            new GeometrySplitResponse(
                "split", 0, false, 0.01,
                [new GeometrySplitResultPayload(0, true, true, [new GeometryPiecePayload("polygon", GeometryPayloads.Element("[[[0,0],[1,0],[1,1],[0,0]]]")), new GeometryPiecePayload("polygon", GeometryPayloads.Element("[[[1,1],[2,1],[2,2],[1,1]]]"))], 2, 0)],
                2),
            null);

        public Task<PythonGeometryResult> BooleanAsync(GeometryBooleanParameters parameters, CancellationToken cancellationToken = default) =>
            throw new NotSupportedException("Las pruebas de corte no piden booleanas.");

        public Task<PythonGeometryOffsetResult> OffsetAsync(GeometryOffsetParameters parameters, CancellationToken cancellationToken = default) =>
            throw new NotSupportedException("Las pruebas de corte no piden offset.");

        public Task<PythonGeometrySplitResult> SplitAsync(GeometrySplitParameters parameters, CancellationToken cancellationToken = default)
        {
            CallCount++;
            LastParameters = parameters;
            return Task.FromResult(Respond());
        }
    }

    private static (GeometryService Service, FakePythonGeometryClient Client) Create()
    {
        var client = new FakePythonGeometryClient();
        var validator = new GeometryRequestValidator(Microsoft.Extensions.Options.Options.Create(new GeometryOptions()));
        return (new GeometryService(validator, client, NullLogger<GeometryService>.Instance), client);
    }

    [Fact]
    public async Task SplitAsync_WhenPythonSucceeds_ReturnsReadyWithTheSameResponse_AndSendsTheValidatedParameters()
    {
        var (service, client) = Create();

        var result = await service.SplitAsync(
            GeometryPayloads.ParseSplit(GeometryPayloads.SplitRequest(mode: "slot", slotWidth: "0.4", extend: "true")), CancellationToken.None);

        var ready = Assert.IsType<GeometrySplitResult.Ready>(result);
        Assert.Equal(2, ready.Response.PieceCount);
        Assert.Equal(1, client.CallCount);
        Assert.Equal(SplitMode.Slot, client.LastParameters!.Mode);
        Assert.Equal(0.4, client.LastParameters.SlotWidth);
        Assert.True(client.LastParameters.Extend);
        Assert.Equal([[20.0, -5.0], [20.0, 45.0]], client.LastParameters.CutterPoints);
        Assert.Single(client.LastParameters.Subjects);
    }

    [Theory]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"cutter":{"points":[[0,0],[1,1]]},"mode":"chop","tolerance":0.01}""", "unknown_split_mode")]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"cutter":{"points":[[0,0],[1,1]]},"mode":"slot","slotWidth":0,"tolerance":0.01}""", "invalid_slot_width")]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"cutter":{"points":[[0,0]]},"mode":"split","tolerance":0.01}""", "invalid_cutter")]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"cutter":{"points":[[2,2],[2,2]]},"mode":"split","tolerance":0.01}""", "invalid_cutter")]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"cutter":{"points":[[0,0],[null,1]]},"mode":"split","tolerance":0.01}""", "invalid_coordinates")]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"cutter":{"points":[[0,0],[1,1]]},"mode":"split","tolerance":0}""", "invalid_tolerance")]
    [InlineData("""{"subjects":[],"cutter":{"points":[[0,0],[1,1]]},"mode":"split","tolerance":0.01}""", "invalid_parameters")]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0],[null,1]]}],"cutter":{"points":[[0,0],[1,1]]},"mode":"split","tolerance":0.01}""", "invalid_coordinates")]
    public async Task SplitAsync_WhenTheRequestIsInvalid_ReturnsValidationFailedAndNeverCallsPython(string json, string code)
    {
        var (service, client) = Create();

        var result = await service.SplitAsync(GeometryPayloads.ParseSplit(json), CancellationToken.None);

        var failed = Assert.IsType<GeometrySplitResult.ValidationFailed>(result);
        Assert.Equal(code, failed.Code);
        Assert.Equal(0, client.CallCount);
    }

    [Fact]
    public async Task SplitAsync_WhenTheRequestIsNull_ReturnsValidationFailedAndNeverCallsPython()
    {
        var (service, client) = Create();

        var result = await service.SplitAsync(null, CancellationToken.None);

        Assert.IsType<GeometrySplitResult.ValidationFailed>(result);
        Assert.Equal(0, client.CallCount);
    }

    [Theory]
    [InlineData(PythonGeometryState.InvalidParameters, "invalid_parameters")]
    [InlineData(PythonGeometryState.TooLarge, "payload_too_large")]
    [InlineData(PythonGeometryState.Timeout, "timeout")]
    [InlineData(PythonGeometryState.EngineError, "processing_error")]
    [InlineData(PythonGeometryState.Unavailable, "engine_unavailable")]
    [InlineData(PythonGeometryState.InvalidResponse, "invalid_response")]
    public async Task SplitAsync_MapsEveryUpstreamFailureToAStableCodeAndNeverReturnsGeometry(PythonGeometryState state, string code)
    {
        var (service, client) = Create();
        client.Respond = () => new PythonGeometrySplitResult(state, null, "detalle del motor");

        var result = await service.SplitAsync(GeometryPayloads.ParseSplit(GeometryPayloads.SplitRequest()), CancellationToken.None);

        var error = Assert.IsType<GeometrySplitResult.UpstreamError>(result);
        Assert.Equal(code, error.Code);
        Assert.Equal("detalle del motor", error.Message);
    }

    [Fact]
    public async Task SplitAsync_WhenAnUpstreamFailureHasNoMessage_UsesAGenericOne()
    {
        var (service, client) = Create();
        client.Respond = () => new PythonGeometrySplitResult(PythonGeometryState.Unavailable, null, null);

        var result = await service.SplitAsync(GeometryPayloads.ParseSplit(GeometryPayloads.SplitRequest()), CancellationToken.None);

        Assert.False(string.IsNullOrWhiteSpace(Assert.IsType<GeometrySplitResult.UpstreamError>(result).Message));
    }

    [Fact]
    public async Task SplitAsync_CalledTwice_NeverCachesAndAlwaysCallsPythonAgain()
    {
        var (service, client) = Create();
        var request = GeometryPayloads.ParseSplit(GeometryPayloads.SplitRequest());

        await service.SplitAsync(request, CancellationToken.None);
        await service.SplitAsync(request, CancellationToken.None);

        Assert.Equal(2, client.CallCount);
    }
}

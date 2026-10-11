using Microsoft.Extensions.Logging.Abstractions;
using Vectorify.Api.Clients;
using Vectorify.Api.Contracts;
using Vectorify.Api.Geometry;
using Vectorify.Api.Options;
using Vectorify.Api.Tests.TestSupport;

namespace Vectorify.Api.Tests.Geometry;

/// <summary>
/// Pruebas unitarias de GeometryService.FloatingAsync y BridgeAsync (M3-S11) con un IPythonGeometryClient en memoria: una petición inválida NO llega a
/// Python, cada estado del cliente se mapea a su código estable y el resultado de Python pasa tal cual.
/// </summary>
public sealed class GeometryFloatingServiceTests
{
    private static readonly GeometryFloatingResponse FloatingOk = new(
        "stencil", 0.01,
        [
            new FloatingComponentPayload(0, "principal", 0, null, null, null, [0, 0, 20, 20], []),
            new FloatingComponentPayload(1, "floating", 1, 0, new GeometryPiecePayload("polygon", GeometryPayloads.Element("[[[5,5],[15,5],[15,15],[5,5]]]")), 50, [5, 5, 15, 15], [0]),
        ],
        1, 1, 0);

    private static readonly GeometryBridgeResponse BridgeOk = new(
        "stencil", 0.01,
        [new BridgeResultPayload(0, false, true, null, 1, new BridgePointPayload(15, 10), new BridgePointPayload(1, 0), 0.8, 5, 4, true, [0], null)],
        [new BridgeSubjectResultPayload(0, true, [new GeometryPiecePayload("polygon", GeometryPayloads.Element("[[[0,0],[1,0],[1,1],[0,0]]]"))])],
        new BridgeReanalysisPayload(1, 0, 1),
        1);

    private sealed class FakePythonGeometryClient : IPythonGeometryClient
    {
        public int FloatingCalls { get; private set; }
        public int BridgeCalls { get; private set; }
        public GeometryFloatingParameters? LastFloating { get; private set; }
        public GeometryBridgeParameters? LastBridge { get; private set; }
        public Func<PythonGeometryFloatingResult> RespondFloating { get; set; } = () => new PythonGeometryFloatingResult(PythonGeometryState.Success, FloatingOk, null);
        public Func<PythonGeometryBridgeResult> RespondBridge { get; set; } = () => new PythonGeometryBridgeResult(PythonGeometryState.Success, BridgeOk, null);

        public Task<PythonGeometryResult> BooleanAsync(GeometryBooleanParameters parameters, CancellationToken cancellationToken = default) =>
            throw new NotSupportedException("Estas pruebas no piden booleanas.");

        public Task<PythonGeometryOffsetResult> OffsetAsync(GeometryOffsetParameters parameters, CancellationToken cancellationToken = default) =>
            throw new NotSupportedException("Estas pruebas no piden offset.");

        public Task<PythonGeometrySplitResult> SplitAsync(GeometrySplitParameters parameters, CancellationToken cancellationToken = default) =>
            throw new NotSupportedException("Estas pruebas no piden corte.");

        public Task<PythonGeometryFloatingResult> FloatingAsync(GeometryFloatingParameters parameters, CancellationToken cancellationToken = default)
        {
            FloatingCalls++;
            LastFloating = parameters;
            return Task.FromResult(RespondFloating());
        }

        public Task<PythonGeometryBridgeResult> BridgeAsync(GeometryBridgeParameters parameters, CancellationToken cancellationToken = default)
        {
            BridgeCalls++;
            LastBridge = parameters;
            return Task.FromResult(RespondBridge());
        }
    }

    private static (GeometryService Service, FakePythonGeometryClient Client) Create()
    {
        var client = new FakePythonGeometryClient();
        var validator = new GeometryRequestValidator(Microsoft.Extensions.Options.Options.Create(new GeometryOptions()));
        return (new GeometryService(validator, client, NullLogger<GeometryService>.Instance), client);
    }

    // ---- Análisis ----

    [Fact]
    public async Task FloatingAsync_WhenPythonSucceeds_ReturnsReadyWithTheSameResponse_AndSendsTheValidatedParameters()
    {
        var (service, client) = Create();

        var result = await service.FloatingAsync(GeometryPayloads.ParseFloating(GeometryPayloads.FloatingRequest(mode: "parts", tolerance: "0.02")), CancellationToken.None);

        var ready = Assert.IsType<GeometryFloatingResult.Ready>(result);
        Assert.Same(FloatingOk, ready.Response);
        Assert.Equal(1, client.FloatingCalls);
        Assert.Equal((FloatingMode.Parts, 0.02), (client.LastFloating!.Mode, client.LastFloating.Tolerance));
        Assert.Single(client.LastFloating.Subjects);
        Assert.Equal(0, client.BridgeCalls);
    }

    [Theory]
    [InlineData("""{"subjects":[{"type":"polygon","coordinates":[[[0,0],[1,0],[1,1]]]}],"mode":"hueco","tolerance":0.01}""", "unknown_floating_mode")]
    [InlineData("""{"subjects":[{"type":"polygon","coordinates":[[[0,0],[1,0],[1,1]]]}],"mode":"stencil","tolerance":0}""", "invalid_tolerance")]
    [InlineData("""{"subjects":[],"mode":"stencil","tolerance":0.01}""", "invalid_parameters")]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"mode":"stencil","tolerance":0.01}""", "invalid_parameters")]
    [InlineData("""{"subjects":[{"type":"polygon","coordinates":[[[0,0],[null,0],[1,1]]]}],"mode":"stencil","tolerance":0.01}""", "invalid_coordinates")]
    public async Task FloatingAsync_WhenTheRequestIsInvalid_ReturnsValidationFailedAndNeverCallsPython(string json, string code)
    {
        var (service, client) = Create();

        var result = await service.FloatingAsync(GeometryPayloads.ParseFloating(json), CancellationToken.None);

        var failed = Assert.IsType<GeometryFloatingResult.ValidationFailed>(result);
        Assert.Equal(code, failed.Code);
        Assert.Equal(0, client.FloatingCalls);
    }

    [Fact]
    public async Task FloatingAsync_WhenTheRequestIsNull_ReturnsValidationFailedAndNeverCallsPython()
    {
        var (service, client) = Create();

        Assert.IsType<GeometryFloatingResult.ValidationFailed>(await service.FloatingAsync(null, CancellationToken.None));
        Assert.Equal(0, client.FloatingCalls);
    }

    [Theory]
    [InlineData(PythonGeometryState.InvalidParameters, "invalid_parameters")]
    [InlineData(PythonGeometryState.TooLarge, "payload_too_large")]
    [InlineData(PythonGeometryState.Timeout, "timeout")]
    [InlineData(PythonGeometryState.EngineError, "processing_error")]
    [InlineData(PythonGeometryState.Unavailable, "engine_unavailable")]
    [InlineData(PythonGeometryState.InvalidResponse, "invalid_response")]
    public async Task FloatingAsync_MapsEveryUpstreamFailureToAStableCodeAndNeverReturnsGeometry(PythonGeometryState state, string code)
    {
        var (service, client) = Create();
        client.RespondFloating = () => new PythonGeometryFloatingResult(state, null, "detalle del motor");

        var result = await service.FloatingAsync(GeometryPayloads.ParseFloating(GeometryPayloads.FloatingRequest()), CancellationToken.None);

        var error = Assert.IsType<GeometryFloatingResult.UpstreamError>(result);
        Assert.Equal(code, error.Code);
        Assert.Equal("detalle del motor", error.Message);
    }

    [Fact]
    public async Task FloatingAsync_WhenAnUpstreamFailureHasNoMessage_UsesAGenericOne()
    {
        var (service, client) = Create();
        client.RespondFloating = () => new PythonGeometryFloatingResult(PythonGeometryState.Unavailable, null, null);

        var result = await service.FloatingAsync(GeometryPayloads.ParseFloating(GeometryPayloads.FloatingRequest()), CancellationToken.None);

        Assert.False(string.IsNullOrWhiteSpace(Assert.IsType<GeometryFloatingResult.UpstreamError>(result).Message));
    }

    [Fact]
    public async Task FloatingAsync_CalledTwice_NeverCachesAndAlwaysCallsPythonAgain()
    {
        var (service, client) = Create();
        var request = GeometryPayloads.ParseFloating(GeometryPayloads.FloatingRequest());

        await service.FloatingAsync(request, CancellationToken.None);
        await service.FloatingAsync(request, CancellationToken.None);

        Assert.Equal(2, client.FloatingCalls);
    }

    // ---- Bridges ----

    [Fact]
    public async Task BridgeAsync_WhenPythonSucceeds_ReturnsReadyWithTheSameResponse_AndSendsTheValidatedParameters()
    {
        var (service, client) = Create();
        var json = GeometryPayloads.BridgeRequest(
            bridges: """{"island":1,"width":0.8},{"anchor":{"x":15,"y":7},"width":1}""", suggest: "true", suggestWidth: "0.5");

        var result = await service.BridgeAsync(GeometryPayloads.ParseBridge(json), CancellationToken.None);

        var ready = Assert.IsType<GeometryBridgeResult.Ready>(result);
        Assert.Same(BridgeOk, ready.Response);
        Assert.Equal(1, client.BridgeCalls);
        var parameters = client.LastBridge!;
        Assert.Equal((FloatingMode.Stencil, true, 0.5, 2), (parameters.Mode, parameters.Suggest, parameters.SuggestWidth, parameters.Bridges.Count));
        Assert.Equal(0, client.FloatingCalls);
    }

    [Theory]
    [InlineData("""{"subjects":[{"type":"polygon","coordinates":[[[0,0],[1,0],[1,1]]]}],"mode":"hueco","bridges":[],"tolerance":0.01}""", "unknown_floating_mode")]
    [InlineData("""{"subjects":[{"type":"polygon","coordinates":[[[0,0],[1,0],[1,1]]]}],"mode":"stencil","bridges":[{"width":1}],"tolerance":0.01}""", "invalid_bridge")]
    [InlineData("""{"subjects":[{"type":"polygon","coordinates":[[[0,0],[1,0],[1,1]]]}],"mode":"stencil","bridges":[{"island":1,"width":0}],"tolerance":0.01}""", "invalid_bridge_width")]
    [InlineData("""{"subjects":[{"type":"polygon","coordinates":[[[0,0],[1,0],[1,1]]]}],"mode":"stencil","bridges":[{"anchor":{"x":null,"y":1},"width":1}],"tolerance":0.01}""", "invalid_coordinates")]
    [InlineData("""{"subjects":[{"type":"polygon","coordinates":[[[0,0],[1,0],[1,1]]]}],"mode":"stencil","bridges":[],"suggest":true,"tolerance":0.01}""", "invalid_bridge_width")]
    [InlineData("""{"subjects":[],"mode":"stencil","bridges":[],"tolerance":0.01}""", "invalid_parameters")]
    public async Task BridgeAsync_WhenTheRequestIsInvalid_ReturnsValidationFailedAndNeverCallsPython(string json, string code)
    {
        var (service, client) = Create();

        var result = await service.BridgeAsync(GeometryPayloads.ParseBridge(json), CancellationToken.None);

        var failed = Assert.IsType<GeometryBridgeResult.ValidationFailed>(result);
        Assert.Equal(code, failed.Code);
        Assert.Equal(0, client.BridgeCalls);
    }

    [Fact]
    public async Task BridgeAsync_WhenTheRequestIsNull_ReturnsValidationFailedAndNeverCallsPython()
    {
        var (service, client) = Create();

        Assert.IsType<GeometryBridgeResult.ValidationFailed>(await service.BridgeAsync(null, CancellationToken.None));
        Assert.Equal(0, client.BridgeCalls);
    }

    [Theory]
    [InlineData(PythonGeometryState.InvalidParameters, "invalid_parameters")]
    [InlineData(PythonGeometryState.TooLarge, "payload_too_large")]
    [InlineData(PythonGeometryState.Timeout, "timeout")]
    [InlineData(PythonGeometryState.EngineError, "processing_error")]
    [InlineData(PythonGeometryState.Unavailable, "engine_unavailable")]
    [InlineData(PythonGeometryState.InvalidResponse, "invalid_response")]
    public async Task BridgeAsync_MapsEveryUpstreamFailureToAStableCodeAndNeverReturnsGeometry(PythonGeometryState state, string code)
    {
        var (service, client) = Create();
        client.RespondBridge = () => new PythonGeometryBridgeResult(state, null, "detalle del motor");

        var result = await service.BridgeAsync(GeometryPayloads.ParseBridge(GeometryPayloads.BridgeRequest()), CancellationToken.None);

        var error = Assert.IsType<GeometryBridgeResult.UpstreamError>(result);
        Assert.Equal(code, error.Code);
        Assert.Equal("detalle del motor", error.Message);
    }

    [Fact]
    public async Task BridgeAsync_WhenAnUpstreamFailureHasNoMessage_UsesAGenericOne()
    {
        var (service, client) = Create();
        client.RespondBridge = () => new PythonGeometryBridgeResult(PythonGeometryState.Unavailable, null, null);

        var result = await service.BridgeAsync(GeometryPayloads.ParseBridge(GeometryPayloads.BridgeRequest()), CancellationToken.None);

        Assert.False(string.IsNullOrWhiteSpace(Assert.IsType<GeometryBridgeResult.UpstreamError>(result).Message));
    }

    [Fact]
    public async Task BridgeAsync_CalledTwice_NeverCachesAndAlwaysCallsPythonAgain()
    {
        var (service, client) = Create();
        var request = GeometryPayloads.ParseBridge(GeometryPayloads.BridgeRequest());

        await service.BridgeAsync(request, CancellationToken.None);
        await service.BridgeAsync(request, CancellationToken.None);

        Assert.Equal(2, client.BridgeCalls);
    }
}

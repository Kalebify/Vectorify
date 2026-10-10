using Microsoft.Extensions.Logging.Abstractions;
using Vectorify.Api.Clients;
using Vectorify.Api.Contracts;
using Vectorify.Api.Geometry;
using Vectorify.Api.Options;
using Vectorify.Api.Tests.TestSupport;

namespace Vectorify.Api.Tests.Geometry;

/// <summary>
/// Pruebas unitarias de GeometryService.OffsetAsync (M3-S09) con un IPythonGeometryClient en memoria: una petición inválida NO
/// llega a Python, cada estado del cliente se mapea a su código estable y el resultado de Python pasa tal cual.
/// </summary>
public sealed class GeometryOffsetServiceTests
{
    private sealed class FakePythonGeometryClient : IPythonGeometryClient
    {
        public int CallCount { get; private set; }
        public GeometryOffsetParameters? LastParameters { get; private set; }
        public Func<PythonGeometryOffsetResult> Respond { get; set; } = () => new PythonGeometryOffsetResult(
            PythonGeometryState.Success,
            new GeometryOffsetResponse(
                3, "mitre", 2, "round", 0.01,
                [new GeometryOffsetResultPayload(0, [new GeometryPiecePayload("polygon", GeometryPayloads.Element("[[[0,0],[1,0],[1,1],[0,0]]]"))], false, 1, 1, 0, 0, 0, 20)],
                1),
            null);

        public Task<PythonGeometryResult> BooleanAsync(GeometryBooleanParameters parameters, CancellationToken cancellationToken = default) =>
            throw new NotSupportedException("Las pruebas de offset no piden booleanas.");

        public Task<PythonGeometryOffsetResult> OffsetAsync(GeometryOffsetParameters parameters, CancellationToken cancellationToken = default)
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
    public async Task OffsetAsync_WhenPythonSucceeds_ReturnsReadyWithTheSameResponse_AndSendsTheValidatedParameters()
    {
        var (service, client) = Create();

        var result = await service.OffsetAsync(GeometryPayloads.ParseOffset(GeometryPayloads.OffsetRequest(distance: "-2.5", joinStyle: "bevel", capStyle: "flat")), CancellationToken.None);

        var ready = Assert.IsType<GeometryOffsetResult.Ready>(result);
        Assert.Equal(1, ready.Response.PieceCount);
        Assert.Equal(1, client.CallCount);
        Assert.Equal(-2.5, client.LastParameters!.Distance);
        Assert.Equal(OffsetJoinStyle.Bevel, client.LastParameters.JoinStyle);
        Assert.Equal(OffsetCapStyle.Flat, client.LastParameters.CapStyle);
        Assert.Single(client.LastParameters.Subjects);
    }

    [Theory]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"distance":0,"tolerance":0.01}""", "invalid_distance")]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"distance":-1,"tolerance":0.01}""", "invalid_distance")]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"distance":1,"joinStyle":"miter","tolerance":0.01}""", "unknown_join_style")]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"distance":1,"capStyle":"butt","tolerance":0.01}""", "unknown_cap_style")]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"distance":1,"mitreLimit":0,"tolerance":0.01}""", "invalid_mitre_limit")]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"distance":1,"tolerance":0}""", "invalid_tolerance")]
    [InlineData("""{"subjects":[],"distance":1,"tolerance":0.01}""", "invalid_parameters")]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0],[null,1]]}],"distance":1,"tolerance":0.01}""", "invalid_coordinates")]
    public async Task OffsetAsync_WhenTheRequestIsInvalid_ReturnsValidationFailedAndNeverCallsPython(string json, string code)
    {
        var (service, client) = Create();

        var result = await service.OffsetAsync(GeometryPayloads.ParseOffset(json), CancellationToken.None);

        var failed = Assert.IsType<GeometryOffsetResult.ValidationFailed>(result);
        Assert.Equal(code, failed.Code);
        Assert.Equal(0, client.CallCount);
    }

    [Fact]
    public async Task OffsetAsync_WhenTheRequestIsNull_ReturnsValidationFailedAndNeverCallsPython()
    {
        var (service, client) = Create();

        var result = await service.OffsetAsync(null, CancellationToken.None);

        Assert.IsType<GeometryOffsetResult.ValidationFailed>(result);
        Assert.Equal(0, client.CallCount);
    }

    [Theory]
    [InlineData(PythonGeometryState.InvalidParameters, "invalid_parameters")]
    [InlineData(PythonGeometryState.TooLarge, "payload_too_large")]
    [InlineData(PythonGeometryState.Timeout, "timeout")]
    [InlineData(PythonGeometryState.EngineError, "processing_error")]
    [InlineData(PythonGeometryState.Unavailable, "engine_unavailable")]
    [InlineData(PythonGeometryState.InvalidResponse, "invalid_response")]
    public async Task OffsetAsync_MapsEveryUpstreamFailureToAStableCodeAndNeverReturnsGeometry(PythonGeometryState state, string code)
    {
        var (service, client) = Create();
        client.Respond = () => new PythonGeometryOffsetResult(state, null, "detalle del motor");

        var result = await service.OffsetAsync(GeometryPayloads.ParseOffset(GeometryPayloads.OffsetRequest()), CancellationToken.None);

        var error = Assert.IsType<GeometryOffsetResult.UpstreamError>(result);
        Assert.Equal(code, error.Code);
        Assert.Equal("detalle del motor", error.Message);
    }

    [Fact]
    public async Task OffsetAsync_WhenAnUpstreamFailureHasNoMessage_UsesAGenericOne()
    {
        var (service, client) = Create();
        client.Respond = () => new PythonGeometryOffsetResult(PythonGeometryState.Unavailable, null, null);

        var result = await service.OffsetAsync(GeometryPayloads.ParseOffset(GeometryPayloads.OffsetRequest()), CancellationToken.None);

        Assert.False(string.IsNullOrWhiteSpace(Assert.IsType<GeometryOffsetResult.UpstreamError>(result).Message));
    }

    [Fact]
    public async Task OffsetAsync_CalledTwice_NeverCachesAndAlwaysCallsPythonAgain()
    {
        var (service, client) = Create();
        var request = GeometryPayloads.ParseOffset(GeometryPayloads.OffsetRequest());

        await service.OffsetAsync(request, CancellationToken.None);
        await service.OffsetAsync(request, CancellationToken.None);

        Assert.Equal(2, client.CallCount);
    }
}

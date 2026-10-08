using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Vectorify.Api.Clients;
using Vectorify.Api.Contracts;
using Vectorify.Api.Geometry;
using Vectorify.Api.Options;
using Vectorify.Api.Tests.TestSupport;

namespace Vectorify.Api.Tests.Geometry;

/// <summary>
/// Pruebas unitarias de GeometryService (M3-S04) con un IPythonGeometryClient en memoria: una petición inválida NO llega
/// a Python, cada estado del cliente se mapea a su código estable y el resultado de Python pasa tal cual.
/// </summary>
public sealed class GeometryServiceTests
{
    private sealed class FakePythonGeometryClient : IPythonGeometryClient
    {
        public int CallCount { get; private set; }
        public GeometryBooleanParameters? LastParameters { get; private set; }
        public Func<PythonGeometryResult> Respond { get; set; } = () => new PythonGeometryResult(
            PythonGeometryState.Success,
            new GeometryBooleanResponse(
                "difference",
                "per_subject",
                0.01,
                [new GeometryResultPayload(0, true, [new GeometryPiecePayload("polygon", GeometryPayloads.Element("[[[0,0],[1,0],[1,1],[0,0]]]"))])],
                1),
            null);

        public Task<PythonGeometryResult> BooleanAsync(GeometryBooleanParameters parameters, CancellationToken cancellationToken = default)
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
    public async Task BooleanAsync_WhenPythonSucceeds_ReturnsReadyWithTheSameResponse_AndSendsTheValidatedParameters()
    {
        var (service, client) = Create();

        var result = await service.BooleanAsync(GeometryPayloads.Parse(GeometryPayloads.Request()), CancellationToken.None);

        var ready = Assert.IsType<GeometryBooleanResult.Ready>(result);
        Assert.Equal(1, ready.Response.PieceCount);
        Assert.Equal(1, client.CallCount);
        Assert.Equal(GeometryOperation.Difference, client.LastParameters!.Operation);
        Assert.Single(client.LastParameters.Subjects);
        Assert.Single(client.LastParameters.Operands);
    }

    [Theory]
    [InlineData("""{"operation":"buffer","subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"tolerance":0.01}""", "unknown_operation")]
    [InlineData("""{"operation":"union","subjects":[],"tolerance":0.01}""", "invalid_parameters")]
    [InlineData("""{"operation":"union","subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"tolerance":0}""", "invalid_tolerance")]
    [InlineData("""{"operation":"union","subjects":[{"type":"line","coordinates":[[0,0],[null,1]]}],"tolerance":0.01}""", "invalid_coordinates")]
    public async Task BooleanAsync_WhenTheRequestIsInvalid_ReturnsValidationFailedAndNeverCallsPython(string json, string code)
    {
        var (service, client) = Create();

        var result = await service.BooleanAsync(GeometryPayloads.Parse(json), CancellationToken.None);

        var failed = Assert.IsType<GeometryBooleanResult.ValidationFailed>(result);
        Assert.Equal(code, failed.Code);
        Assert.Equal(0, client.CallCount);
    }

    [Fact]
    public async Task BooleanAsync_WhenTheRequestIsNull_ReturnsValidationFailedAndNeverCallsPython()
    {
        var (service, client) = Create();

        var result = await service.BooleanAsync(null, CancellationToken.None);

        Assert.IsType<GeometryBooleanResult.ValidationFailed>(result);
        Assert.Equal(0, client.CallCount);
    }

    [Theory]
    [InlineData(PythonGeometryState.InvalidParameters, "invalid_parameters")]
    [InlineData(PythonGeometryState.TooLarge, "payload_too_large")]
    [InlineData(PythonGeometryState.Timeout, "timeout")]
    [InlineData(PythonGeometryState.EngineError, "processing_error")]
    [InlineData(PythonGeometryState.Unavailable, "engine_unavailable")]
    [InlineData(PythonGeometryState.InvalidResponse, "invalid_response")]
    public async Task BooleanAsync_MapsEveryUpstreamFailureToAStableCodeAndNeverReturnsGeometry(PythonGeometryState state, string code)
    {
        var (service, client) = Create();
        client.Respond = () => new PythonGeometryResult(state, null, "detalle del motor");

        var result = await service.BooleanAsync(GeometryPayloads.Parse(GeometryPayloads.Request()), CancellationToken.None);

        var error = Assert.IsType<GeometryBooleanResult.UpstreamError>(result);
        Assert.Equal(code, error.Code);
        Assert.Equal("detalle del motor", error.Message);
    }

    [Fact]
    public async Task BooleanAsync_WhenAnUpstreamFailureHasNoMessage_UsesAGenericOne()
    {
        var (service, client) = Create();
        client.Respond = () => new PythonGeometryResult(PythonGeometryState.Unavailable, null, null);

        var result = await service.BooleanAsync(GeometryPayloads.Parse(GeometryPayloads.Request()), CancellationToken.None);

        Assert.False(string.IsNullOrWhiteSpace(Assert.IsType<GeometryBooleanResult.UpstreamError>(result).Message));
    }

    [Fact]
    public async Task BooleanAsync_CalledTwice_NeverCachesAndAlwaysCallsPythonAgain()
    {
        var (service, client) = Create();
        var request = GeometryPayloads.Parse(GeometryPayloads.Request());

        await service.BooleanAsync(request, CancellationToken.None);
        await service.BooleanAsync(request, CancellationToken.None);

        Assert.Equal(2, client.CallCount);
    }
}

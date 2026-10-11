using Vectorify.Api.Contracts;
using Vectorify.Api.Geometry;
using Vectorify.Api.Options;
using Vectorify.Api.Tests.TestSupport;

namespace Vectorify.Api.Tests.Geometry;

/// <summary>
/// Pruebas unitarias de GeometryRequestValidator.ValidateFloating y ValidateBridge (M3-S11): cada regla de 400 por separado (cuerpo nulo, modo
/// desconocido, tolerancia, formas que no son polígonos, coordenadas null/NaN/Infinity/fuera de límite, bridge sin isla ni ancla, isla negativa,
/// dirección nula o no finita, ancho y largo 0 / negativo / NaN / fuera del tope, ancho de `suggest`) y los límites en SU frontera exacta (el máximo
/// pasa, uno más no).
/// </summary>
public sealed class GeometryFloatingValidatorTests
{
    private static GeometryRequestValidator CreateValidator(GeometryOptions? options = null) =>
        new(Microsoft.Extensions.Options.Options.Create(options ?? new GeometryOptions()));

    private static GeometryValidationResult ValidateFloating(string json, GeometryOptions? options = null) =>
        CreateValidator(options).ValidateFloating(GeometryPayloads.ParseFloating(json));

    private static GeometryValidationResult ValidateBridge(string json, GeometryOptions? options = null) =>
        CreateValidator(options).ValidateBridge(GeometryPayloads.ParseBridge(json));

    private static void AssertFailure(GeometryValidationResult result, string code)
    {
        Assert.False(result.IsValid);
        Assert.Equal(code, result.ErrorCode);
        Assert.False(string.IsNullOrWhiteSpace(result.ErrorMessage));
        Assert.Null(result.FloatingParameters);
        Assert.Null(result.BridgeParameters);
        Assert.Null(result.Parameters);
        Assert.Null(result.OffsetParameters);
        Assert.Null(result.SplitParameters);
    }

    // ---- Análisis ----

    [Fact]
    public void ValidateFloating_WhenRequestIsValid_ReturnsTypedParameters()
    {
        var subjects = $$"""{"type":"polygon","coordinates":[[[0,0],[10,0],[10,10]]],"locked":true},{{GeometryPayloads.RingPolygon}}""";

        var result = ValidateFloating(GeometryPayloads.FloatingRequest(subjects: subjects, mode: "parts", tolerance: "0.02"));

        Assert.True(result.IsValid);
        var parameters = result.FloatingParameters!;
        Assert.Equal(FloatingMode.Parts, parameters.Mode);
        Assert.Equal(0.02, parameters.Tolerance);
        Assert.Equal(2, parameters.Subjects.Count);
        Assert.Equal([[0.0, 0.0], [10.0, 0.0], [10.0, 10.0]], parameters.Subjects[0].Rings[0]);
        Assert.True(parameters.Subjects[0].Locked);
        Assert.Equal(2, parameters.Subjects[1].Rings.Length);
        Assert.False(parameters.Subjects[1].Locked);
        Assert.Null(result.BridgeParameters);
    }

    [Theory]
    [InlineData("stencil", FloatingMode.Stencil)]
    [InlineData("PARTS", FloatingMode.Parts)]
    [InlineData("  Stencil ", FloatingMode.Stencil)]
    public void ValidateFloating_AcceptsEveryModeCaseInsensitively(string mode, FloatingMode expected)
    {
        Assert.Equal(expected, ValidateFloating(GeometryPayloads.FloatingRequest(mode: mode)).FloatingParameters!.Mode);
    }

    [Fact]
    public void ValidateFloating_WhenRequestIsNull_ReturnsInvalidParameters()
    {
        AssertFailure(CreateValidator().ValidateFloating(null), "invalid_parameters");
    }

    [Theory]
    [InlineData("hueco")]
    [InlineData("")]
    [InlineData("split")]
    public void ValidateFloating_WhenModeIsUnknown_ReturnsUnknownFloatingMode(string mode)
    {
        AssertFailure(ValidateFloating(GeometryPayloads.FloatingRequest(mode: mode)), "unknown_floating_mode");
    }

    [Fact]
    public void ValidateFloating_WhenModeIsMissing_ReturnsUnknownFloatingMode()
    {
        AssertFailure(ValidateFloating($$"""{"subjects":[{{GeometryPayloads.RingPolygon}}],"tolerance":0.01}"""), "unknown_floating_mode");
    }

    [Theory]
    [InlineData("0")]
    [InlineData("-1")]
    [InlineData("1000001")]
    public void ValidateFloating_WhenToleranceIsOutOfRange_ReturnsInvalidTolerance(string tolerance)
    {
        AssertFailure(ValidateFloating(GeometryPayloads.FloatingRequest(tolerance: tolerance)), "invalid_tolerance");
    }

    [Theory]
    [InlineData(double.NaN)]
    [InlineData(double.PositiveInfinity)]
    public void ValidateFloating_WhenToleranceIsNotFinite_ReturnsInvalidTolerance(double tolerance)
    {
        var request = GeometryPayloads.ParseFloating(GeometryPayloads.FloatingRequest()) with { Tolerance = tolerance };

        AssertFailure(CreateValidator().ValidateFloating(request), "invalid_tolerance");
    }

    [Fact]
    public void ValidateFloating_WhenToleranceIsMissing_ReturnsInvalidTolerance()
    {
        AssertFailure(ValidateFloating($$"""{"subjects":[{{GeometryPayloads.RingPolygon}}],"mode":"stencil"}"""), "invalid_tolerance");
    }

    [Theory]
    [InlineData("""{"mode":"stencil","tolerance":0.01}""")]
    [InlineData("""{"subjects":[],"mode":"stencil","tolerance":0.01}""")]
    [InlineData("""{"subjects":[null],"mode":"stencil","tolerance":0.01}""")]
    [InlineData("""{"subjects":[{"type":"polygon"}],"mode":"stencil","tolerance":0.01}""")]
    [InlineData("""{"subjects":[{"type":"polygon","coordinates":[]}],"mode":"stencil","tolerance":0.01}""")]
    [InlineData("""{"subjects":[{"type":"polygon","coordinates":[[[0,0],[1,1]]]}],"mode":"stencil","tolerance":0.01}""")]
    [InlineData("""{"subjects":[{"type":"polygon","coordinates":[[[0,0],[1,1,1],[2,2]]]}],"mode":"stencil","tolerance":0.01}""")]
    [InlineData("""{"subjects":[{"type":"circle","coordinates":[[[0,0],[1,0],[1,1]]]}],"mode":"stencil","tolerance":0.01}""")]
    [InlineData("""{"subjects":[{"coordinates":[[[0,0],[1,0],[1,1]]]}],"mode":"stencil","tolerance":0.01}""")]
    public void ValidateFloating_WhenSubjectsAreMissingOrMalformed_ReturnsInvalidParameters(string json)
    {
        AssertFailure(ValidateFloating(json), "invalid_parameters");
    }

    [Theory]
    [InlineData("""{"type":"line","coordinates":[[0,0],[10,0]]}""")]
    [InlineData("""{"type":"bufferedLine","points":[[0,0]],"radius":1}""")]
    public void ValidateFloating_WhenASubjectIsNotAPolygon_ReturnsInvalidParameters(string subject)
    {
        // Solo las formas con relleno se analizan: una línea abierta o un pincel no tienen huecos ni contención.
        AssertFailure(ValidateFloating(GeometryPayloads.FloatingRequest(subjects: subject)), "invalid_parameters");
    }

    [Theory]
    [InlineData("""{"type":"polygon","coordinates":[[[0,0],[null,0],[1,1]]]}""")]
    [InlineData("""{"type":"polygon","coordinates":[[[0,0],["NaN",0],[1,1]]]}""")]
    [InlineData("""{"type":"polygon","coordinates":[[[0,0],["Infinity",0],[1,1]]]}""")]
    [InlineData("""{"type":"polygon","coordinates":[[[0,0],[2000000000,0],[1,1]]]}""")]
    [InlineData("""{"type":"polygon","coordinates":[[[0,0],["a",0],[1,1]]]}""")]
    public void ValidateFloating_WhenACoordinateIsNullNotFiniteOrTooBig_ReturnsInvalidCoordinates(string subject)
    {
        AssertFailure(ValidateFloating(GeometryPayloads.FloatingRequest(subjects: subject)), "invalid_coordinates");
    }

    [Fact]
    public void ValidateFloating_AcceptsExactlyTheMaximumNumberOfSubjectsAndRejectsOneMore()
    {
        var options = new GeometryOptions { MaxSubjects = 2 };
        var two = string.Join(",", Enumerable.Repeat(GeometryPayloads.RingPolygon, 2));
        var three = string.Join(",", Enumerable.Repeat(GeometryPayloads.RingPolygon, 3));

        Assert.True(ValidateFloating(GeometryPayloads.FloatingRequest(subjects: two), options).IsValid);
        AssertFailure(ValidateFloating(GeometryPayloads.FloatingRequest(subjects: three), options), "too_many_subjects");
    }

    [Fact]
    public void ValidateFloating_AcceptsExactlyTheMaximumNumberOfVerticesAndRejectsOneMore()
    {
        // El anillo tiene 8 vértices (4 + 4).
        Assert.True(ValidateFloating(GeometryPayloads.FloatingRequest(), new GeometryOptions { MaxVertices = 8 }).IsValid);
        AssertFailure(ValidateFloating(GeometryPayloads.FloatingRequest(), new GeometryOptions { MaxVertices = 7 }), "too_many_vertices");
    }

    // ---- Bridges ----

    [Fact]
    public void ValidateBridge_WhenRequestIsValid_ReturnsTypedParameters()
    {
        var bridges = """
            {"island":2,"width":0.8},
            {"anchor":{"x":15,"y":7},"direction":{"x":0,"y":-3},"width":1.5,"length":6},
            {"island":1,"anchor":{"x":5,"y":10},"width":2}
            """;

        var result = ValidateBridge(GeometryPayloads.BridgeRequest(mode: "parts", bridges: bridges, suggest: "true", suggestWidth: "0.5", tolerance: "0.02"));

        Assert.True(result.IsValid);
        var parameters = result.BridgeParameters!;
        Assert.Equal((FloatingMode.Parts, true, 0.5, 0.02), (parameters.Mode, parameters.Suggest, parameters.SuggestWidth, parameters.Tolerance));
        Assert.Equal(3, parameters.Bridges.Count);
        Assert.Equal((2, 0.8), (parameters.Bridges[0].Island, parameters.Bridges[0].Width));
        Assert.Null(parameters.Bridges[0].Anchor);
        Assert.Null(parameters.Bridges[0].Direction);
        Assert.Null(parameters.Bridges[0].Length);
        Assert.Equal([15.0, 7.0], parameters.Bridges[1].Anchor!);
        Assert.Equal([0.0, -3.0], parameters.Bridges[1].Direction!);
        Assert.Equal((1.5, 6.0), (parameters.Bridges[1].Width, parameters.Bridges[1].Length));
        Assert.Null(parameters.Bridges[1].Island);
        Assert.Equal(1, parameters.Bridges[2].Island);
        Assert.Equal([5.0, 10.0], parameters.Bridges[2].Anchor!);
        Assert.Single(parameters.Subjects);
        Assert.Null(result.FloatingParameters);
    }

    [Fact]
    public void ValidateBridge_WhenThereAreNoBridges_AcceptsAnEmptyList_AndSuggestWidthIsIgnoredWithoutSuggest()
    {
        var result = ValidateBridge(GeometryPayloads.BridgeRequest(bridges: string.Empty, suggest: "false", suggestWidth: "0.5"));

        Assert.True(result.IsValid);
        Assert.Empty(result.BridgeParameters!.Bridges);
        Assert.False(result.BridgeParameters.Suggest);
        Assert.Null(result.BridgeParameters.SuggestWidth);
    }

    [Fact]
    public void ValidateBridge_WhenBridgesAndSuggestAreMissing_UsesTheDocumentedDefaults()
    {
        var json = $$"""{"subjects":[{{GeometryPayloads.RingPolygon}}],"mode":"stencil","tolerance":0.01}""";

        var parameters = ValidateBridge(json).BridgeParameters!;

        Assert.Empty(parameters.Bridges);
        Assert.False(parameters.Suggest);
        Assert.Null(parameters.SuggestWidth);
    }

    [Fact]
    public void ValidateBridge_WhenRequestIsNull_ReturnsInvalidParameters()
    {
        AssertFailure(CreateValidator().ValidateBridge(null), "invalid_parameters");
    }

    [Theory]
    [InlineData("hueco")]
    [InlineData("")]
    public void ValidateBridge_WhenModeIsUnknown_ReturnsUnknownFloatingMode(string mode)
    {
        AssertFailure(ValidateBridge(GeometryPayloads.BridgeRequest(mode: mode)), "unknown_floating_mode");
    }

    [Theory]
    [InlineData("0")]
    [InlineData("-0.1")]
    [InlineData("1000001")]
    public void ValidateBridge_WhenToleranceIsOutOfRange_ReturnsInvalidTolerance(string tolerance)
    {
        AssertFailure(ValidateBridge(GeometryPayloads.BridgeRequest(tolerance: tolerance)), "invalid_tolerance");
    }

    [Theory]
    [InlineData("""{"width":1}""")]
    [InlineData("""{"island":null,"anchor":null,"width":1}""")]
    [InlineData("""{"direction":{"x":1,"y":0},"width":1}""")]
    public void ValidateBridge_WhenABridgeHasNeitherIslandNorAnchor_ReturnsInvalidBridge(string bridge)
    {
        AssertFailure(ValidateBridge(GeometryPayloads.BridgeRequest(bridges: bridge)), "invalid_bridge");
    }

    [Fact]
    public void ValidateBridge_WhenTheIslandIsNegative_ReturnsInvalidBridge()
    {
        AssertFailure(ValidateBridge(GeometryPayloads.BridgeRequest(bridges: """{"island":-1,"width":1}""")), "invalid_bridge");
    }

    [Fact]
    public void ValidateBridge_WhenABridgeIsNull_ReturnsInvalidParameters()
    {
        AssertFailure(ValidateBridge(GeometryPayloads.BridgeRequest(bridges: "null")), "invalid_parameters");
    }

    [Theory]
    [InlineData("""{"island":1,"direction":{"x":0,"y":0},"width":1}""")]
    [InlineData("""{"anchor":{"x":1,"y":1},"direction":{"x":-0,"y":0},"width":1}""")]
    public void ValidateBridge_WhenTheDirectionIsTheNullVector_ReturnsInvalidBridge(string bridge)
    {
        AssertFailure(ValidateBridge(GeometryPayloads.BridgeRequest(bridges: bridge)), "invalid_bridge");
    }

    [Theory]
    [InlineData("""{"anchor":{"x":null,"y":1},"width":1}""")]
    [InlineData("""{"anchor":{"x":1},"width":1}""")]
    [InlineData("""{"anchor":{},"width":1}""")]
    [InlineData("""{"anchor":{"x":"NaN","y":1},"width":1}""")]
    [InlineData("""{"anchor":{"x":1,"y":"Infinity"},"width":1}""")]
    [InlineData("""{"anchor":{"x":2000000000,"y":1},"width":1}""")]
    [InlineData("""{"island":1,"direction":{"x":null,"y":1},"width":1}""")]
    [InlineData("""{"island":1,"direction":{"x":"NaN","y":1},"width":1}""")]
    [InlineData("""{"island":1,"direction":{"x":1},"width":1}""")]
    public void ValidateBridge_WhenAnAnchorOrDirectionCoordinateIsMissingNotFiniteOrTooBig_ReturnsInvalidCoordinates(string bridge)
    {
        AssertFailure(ValidateBridge(GeometryPayloads.BridgeRequest(bridges: bridge)), "invalid_coordinates");
    }

    [Theory]
    [InlineData("""{"island":1}""")]
    [InlineData("""{"island":1,"width":null}""")]
    [InlineData("""{"island":1,"width":0}""")]
    [InlineData("""{"island":1,"width":-0.5}""")]
    [InlineData("""{"island":1,"width":"NaN"}""")]
    [InlineData("""{"island":1,"width":"Infinity"}""")]
    [InlineData("""{"island":1,"width":1000001}""")]
    [InlineData("""{"island":1,"width":1,"length":0}""")]
    [InlineData("""{"island":1,"width":1,"length":-2}""")]
    [InlineData("""{"island":1,"width":1,"length":"NaN"}""")]
    [InlineData("""{"island":1,"width":1,"length":1000001}""")]
    public void ValidateBridge_WhenTheWidthOrTheLengthIsMissingNonPositiveNotFiniteOrBeyondTheMaximum_ReturnsInvalidBridgeWidth(string bridge)
    {
        AssertFailure(ValidateBridge(GeometryPayloads.BridgeRequest(bridges: bridge)), "invalid_bridge_width");
    }

    [Fact]
    public void ValidateBridge_AcceptsExactlyTheMaximumWidthAndLength()
    {
        var options = new GeometryOptions { MaxOffsetDistance = 10 };

        Assert.True(ValidateBridge(GeometryPayloads.BridgeRequest(bridges: """{"island":1,"width":10,"length":10}"""), options).IsValid);
        AssertFailure(ValidateBridge(GeometryPayloads.BridgeRequest(bridges: """{"island":1,"width":10.5}"""), options), "invalid_bridge_width");
        AssertFailure(ValidateBridge(GeometryPayloads.BridgeRequest(bridges: """{"island":1,"width":10,"length":10.5}"""), options), "invalid_bridge_width");
    }

    [Theory]
    [InlineData("null")]
    [InlineData("0")]
    [InlineData("-1")]
    [InlineData("\"NaN\"")]
    [InlineData("1000001")]
    public void ValidateBridge_WithSuggest_RequiresAValidSuggestWidth(string suggestWidth)
    {
        AssertFailure(ValidateBridge(GeometryPayloads.BridgeRequest(bridges: string.Empty, suggest: "true", suggestWidth: suggestWidth)), "invalid_bridge_width");
    }

    [Theory]
    [InlineData("0")]
    [InlineData("-1")]
    public void ValidateBridge_WithoutSuggest_StillRejectsAnInvalidSuggestWidthThatWasSent(string suggestWidth)
    {
        // Un valor mandado y absurdo no se ignora en silencio.
        AssertFailure(ValidateBridge(GeometryPayloads.BridgeRequest(bridges: string.Empty, suggest: "false", suggestWidth: suggestWidth)), "invalid_bridge_width");
    }

    [Fact]
    public void ValidateBridge_AcceptsExactlyTheMaximumNumberOfBridgesAndRejectsOneMore()
    {
        var options = new GeometryOptions { MaxBridges = 3 };
        var three = string.Join(",", Enumerable.Repeat(GeometryPayloads.DefaultBridge, 3));
        var four = string.Join(",", Enumerable.Repeat(GeometryPayloads.DefaultBridge, 4));

        Assert.True(ValidateBridge(GeometryPayloads.BridgeRequest(bridges: three), options).IsValid);
        AssertFailure(ValidateBridge(GeometryPayloads.BridgeRequest(bridges: four), options), "too_many_bridges");
    }

    [Theory]
    [InlineData("""{"subjects":[],"mode":"stencil","bridges":[],"tolerance":0.01}""", "invalid_parameters")]
    [InlineData("""{"mode":"stencil","bridges":[],"tolerance":0.01}""", "invalid_parameters")]
    [InlineData("""{"subjects":[{"type":"line","coordinates":[[0,0],[1,1]]}],"mode":"stencil","bridges":[],"tolerance":0.01}""", "invalid_parameters")]
    [InlineData("""{"subjects":[{"type":"polygon","coordinates":[[[0,0],[null,0],[1,1]]]}],"mode":"stencil","bridges":[],"tolerance":0.01}""", "invalid_coordinates")]
    public void ValidateBridge_AppliesTheSameSubjectRulesAsTheAnalysis(string json, string code)
    {
        AssertFailure(ValidateBridge(json), code);
    }

    [Fact]
    public void ValidateBridge_AcceptsExactlyTheMaximumNumberOfSubjectsAndVertices()
    {
        Assert.True(ValidateBridge(GeometryPayloads.BridgeRequest(), new GeometryOptions { MaxVertices = 8, MaxSubjects = 1 }).IsValid);
        AssertFailure(ValidateBridge(GeometryPayloads.BridgeRequest(), new GeometryOptions { MaxVertices = 7 }), "too_many_vertices");
        AssertFailure(
            ValidateBridge(GeometryPayloads.BridgeRequest(subjects: GeometryPayloads.RingPolygon + "," + GeometryPayloads.RingPolygon), new GeometryOptions { MaxSubjects = 1 }),
            "too_many_subjects");
    }
}

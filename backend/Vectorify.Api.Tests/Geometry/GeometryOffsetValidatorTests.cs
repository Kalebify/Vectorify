using Vectorify.Api.Contracts;
using Vectorify.Api.Geometry;
using Vectorify.Api.Options;
using Vectorify.Api.Tests.TestSupport;

namespace Vectorify.Api.Tests.Geometry;

/// <summary>
/// Pruebas unitarias de GeometryRequestValidator.ValidateOffset (M3-S09): cada regla de 400 por separado (cuerpo nulo,
/// distancia 0 / NaN / Infinity / fuera del tope, interior con líneas, join/cap desconocidos, límite de inglete, tolerancia,
/// subjects vacíos, formas mal formadas, null/NaN en coordenadas) y los límites en SU frontera exacta (el máximo pasa, uno más no).
/// </summary>
public sealed class GeometryOffsetValidatorTests
{
    private static GeometryRequestValidator CreateValidator(GeometryOptions? options = null) =>
        new(Microsoft.Extensions.Options.Options.Create(options ?? new GeometryOptions()));

    private static GeometryValidationResult Validate(string json, GeometryOptions? options = null) =>
        CreateValidator(options).ValidateOffset(GeometryPayloads.ParseOffset(json));

    private static void AssertFailure(GeometryValidationResult result, string code)
    {
        Assert.False(result.IsValid);
        Assert.Equal(code, result.ErrorCode);
        Assert.False(string.IsNullOrWhiteSpace(result.ErrorMessage));
        Assert.Null(result.OffsetParameters);
        Assert.Null(result.Parameters);
    }

    [Fact]
    public void ValidateOffset_WhenRequestIsValid_ReturnsTypedParameters()
    {
        var result = Validate(GeometryPayloads.OffsetRequest());

        Assert.True(result.IsValid);
        var parameters = result.OffsetParameters!;
        Assert.Equal(3.0, parameters.Distance);
        Assert.Equal(OffsetJoinStyle.Mitre, parameters.JoinStyle);
        Assert.Equal(2.0, parameters.MitreLimit);
        Assert.Equal(OffsetCapStyle.Round, parameters.CapStyle);
        Assert.Equal(0.01, parameters.Tolerance);
        var subject = Assert.IsType<GeometryShape.Polygon>(Assert.Single(parameters.Subjects));
        Assert.Equal([[0.0, 0.0], [40.0, 0.0], [40.0, 40.0], [0.0, 40.0]], subject.Rings[0]);
    }

    [Fact]
    public void ValidateOffset_AcceptsInteriorDistanceForPolygons_AndKeepsTheSign()
    {
        var result = Validate(GeometryPayloads.OffsetRequest(distance: "-4.5"));

        Assert.True(result.IsValid);
        Assert.Equal(-4.5, result.OffsetParameters!.Distance);
    }

    [Fact]
    public void ValidateOffset_WhenJoinCapAndMitreAreMissing_UsesTheDocumentedDefaults()
    {
        var json = $$"""{"subjects":[{{GeometryPayloads.Square40}}],"distance":2,"tolerance":0.01}""";

        var parameters = Validate(json).OffsetParameters!;

        Assert.Equal(OffsetJoinStyle.Round, parameters.JoinStyle);
        Assert.Equal(OffsetCapStyle.Round, parameters.CapStyle);
        Assert.Equal(2.0, parameters.MitreLimit);
    }

    [Theory]
    [InlineData("round", OffsetJoinStyle.Round)]
    [InlineData("Mitre", OffsetJoinStyle.Mitre)]
    [InlineData("  BEVEL ", OffsetJoinStyle.Bevel)]
    public void ValidateOffset_AcceptsEveryJoinCaseInsensitively(string join, OffsetJoinStyle expected)
    {
        Assert.Equal(expected, Validate(GeometryPayloads.OffsetRequest(joinStyle: join)).OffsetParameters!.JoinStyle);
    }

    [Theory]
    [InlineData("round", OffsetCapStyle.Round)]
    [InlineData("FLAT", OffsetCapStyle.Flat)]
    [InlineData("square", OffsetCapStyle.Square)]
    public void ValidateOffset_AcceptsEveryCapCaseInsensitively(string cap, OffsetCapStyle expected)
    {
        Assert.Equal(expected, Validate(GeometryPayloads.OffsetRequest(capStyle: cap)).OffsetParameters!.CapStyle);
    }

    [Fact]
    public void ValidateOffset_WhenRequestIsNull_ReturnsInvalidParameters()
    {
        AssertFailure(CreateValidator().ValidateOffset(null), "invalid_parameters");
    }

    [Theory]
    [InlineData("0")]
    [InlineData("0.0")]
    [InlineData("-0")]
    [InlineData("1000001")]
    [InlineData("-1000001")]
    public void ValidateOffset_WhenDistanceIsZeroOrOutOfRange_ReturnsInvalidDistance(string distance)
    {
        AssertFailure(Validate(GeometryPayloads.OffsetRequest(distance: distance)), "invalid_distance");
    }

    [Theory]
    [InlineData(double.NaN)]
    [InlineData(double.PositiveInfinity)]
    [InlineData(double.NegativeInfinity)]
    public void ValidateOffset_WhenDistanceIsNotFinite_ReturnsInvalidDistance(double distance)
    {
        var request = GeometryPayloads.ParseOffset(GeometryPayloads.OffsetRequest()) with { Distance = distance };

        AssertFailure(CreateValidator().ValidateOffset(request), "invalid_distance");
    }

    [Fact]
    public void ValidateOffset_WhenDistanceIsMissing_ReturnsInvalidDistance()
    {
        var json = $$"""{"subjects":[{{GeometryPayloads.Square40}}],"tolerance":0.01}""";

        AssertFailure(Validate(json), "invalid_distance");
    }

    [Fact]
    public void ValidateOffset_AcceptsTheDistanceExactlyAtTheConfiguredMaximum_AndRejectsJustBeyond()
    {
        var options = new GeometryOptions { MaxOffsetDistance = 50 };

        Assert.True(Validate(GeometryPayloads.OffsetRequest(distance: "50"), options).IsValid);
        Assert.True(Validate(GeometryPayloads.OffsetRequest(distance: "-50"), options).IsValid);
        AssertFailure(Validate(GeometryPayloads.OffsetRequest(distance: "50.0001"), options), "invalid_distance");
        AssertFailure(Validate(GeometryPayloads.OffsetRequest(distance: "-50.0001"), options), "invalid_distance");
    }

    [Theory]
    [InlineData("miter")]
    [InlineData("")]
    [InlineData("rounded")]
    public void ValidateOffset_WhenJoinIsUnknown_ReturnsUnknownJoinStyle(string join)
    {
        AssertFailure(Validate(GeometryPayloads.OffsetRequest(joinStyle: join)), "unknown_join_style");
    }

    [Theory]
    [InlineData("butt")]
    [InlineData("")]
    [InlineData("squared")]
    public void ValidateOffset_WhenCapIsUnknown_ReturnsUnknownCapStyle(string cap)
    {
        AssertFailure(Validate(GeometryPayloads.OffsetRequest(capStyle: cap)), "unknown_cap_style");
    }

    [Theory]
    [InlineData("0")]
    [InlineData("-1")]
    [InlineData("100.5")]
    public void ValidateOffset_WhenMitreLimitIsOutOfRange_ReturnsInvalidMitreLimit(string mitre)
    {
        AssertFailure(Validate(GeometryPayloads.OffsetRequest(mitreLimit: mitre)), "invalid_mitre_limit");
    }

    [Fact]
    public void ValidateOffset_WhenMitreLimitIsNotFinite_ReturnsInvalidMitreLimit()
    {
        var request = GeometryPayloads.ParseOffset(GeometryPayloads.OffsetRequest()) with { MitreLimit = double.NaN };

        AssertFailure(CreateValidator().ValidateOffset(request), "invalid_mitre_limit");
    }

    [Fact]
    public void ValidateOffset_AcceptsTheMitreLimitExactlyAtTheMaximum()
    {
        var options = new GeometryOptions { MaxMitreLimit = 10 };

        Assert.True(Validate(GeometryPayloads.OffsetRequest(mitreLimit: "10"), options).IsValid);
        Assert.True(Validate(GeometryPayloads.OffsetRequest(mitreLimit: "0.1"), options).IsValid);
        AssertFailure(Validate(GeometryPayloads.OffsetRequest(mitreLimit: "10.5"), options), "invalid_mitre_limit");
    }

    [Theory]
    [InlineData("0")]
    [InlineData("-0.5")]
    [InlineData("1000001")]
    public void ValidateOffset_WhenToleranceIsOutOfRange_ReturnsInvalidTolerance(string tolerance)
    {
        AssertFailure(Validate(GeometryPayloads.OffsetRequest(tolerance: tolerance)), "invalid_tolerance");
    }

    [Fact]
    public void ValidateOffset_WhenToleranceIsMissingOrNotFinite_ReturnsInvalidTolerance()
    {
        var missing = $$"""{"subjects":[{{GeometryPayloads.Square40}}],"distance":2}""";
        AssertFailure(Validate(missing), "invalid_tolerance");

        var infinite = GeometryPayloads.ParseOffset(GeometryPayloads.OffsetRequest()) with { Tolerance = double.PositiveInfinity };
        AssertFailure(CreateValidator().ValidateOffset(infinite), "invalid_tolerance");
    }

    [Fact]
    public void ValidateOffset_WhenSubjectsAreMissingOrEmpty_ReturnsInvalidParameters()
    {
        AssertFailure(Validate("""{"distance":2,"tolerance":0.01}"""), "invalid_parameters");
        AssertFailure(Validate("""{"subjects":[],"distance":2,"tolerance":0.01}"""), "invalid_parameters");
    }

    [Fact]
    public void ValidateOffset_RejectsABufferedLineAsSubject()
    {
        AssertFailure(Validate(GeometryPayloads.OffsetRequest(subjects: GeometryPayloads.Brush)), "invalid_parameters");
    }

    [Theory]
    [InlineData("""{"type":"circle","coordinates":[[0,0]]}""")]
    [InlineData("""{"type":"polygon","coordinates":[]}""")]
    [InlineData("""{"type":"polygon","coordinates":[[[0,0],[1,1]]]}""")]
    [InlineData("""{"type":"line","coordinates":[[0,0]]}""")]
    [InlineData("""{"type":"line","coordinates":[[0,0,5],[1,1,5]]}""")]
    public void ValidateOffset_WhenAShapeIsMalformed_ReturnsInvalidParameters(string subject)
    {
        AssertFailure(Validate(GeometryPayloads.OffsetRequest(subjects: subject)), "invalid_parameters");
    }

    [Theory]
    [InlineData("""{"type":"line","coordinates":[[0,0],[null,1]]}""")]
    [InlineData("""{"type":"line","coordinates":[[0,0],["NaN",1]]}""")]
    [InlineData("""{"type":"line","coordinates":[[0,0],[1e999,1]]}""")]
    [InlineData("""{"type":"line","coordinates":[[0,0],[2000000000,1]]}""")]
    public void ValidateOffset_WhenACoordinateIsNotFinite_ReturnsInvalidCoordinates(string subject)
    {
        AssertFailure(Validate(GeometryPayloads.OffsetRequest(subjects: subject)), "invalid_coordinates");
    }

    [Fact]
    public void ValidateOffset_AcceptsLinesWithAPositiveDistance()
    {
        var result = Validate(GeometryPayloads.OffsetRequest(subjects: GeometryPayloads.Line, distance: "1", capStyle: "square"));

        Assert.True(result.IsValid);
        Assert.IsType<GeometryShape.Line>(Assert.Single(result.OffsetParameters!.Subjects));
        Assert.Equal(OffsetCapStyle.Square, result.OffsetParameters.CapStyle);
    }

    [Fact]
    public void ValidateOffset_WhenALineMeetsAnInteriorDistance_RejectsTheWholeRequest()
    {
        // Una línea abierta no tiene interior: ni se omite ni se reinterpreta, aunque el otro subject sea un polígono.
        var subjects = $"{GeometryPayloads.Square40},{GeometryPayloads.Line}";

        AssertFailure(Validate(GeometryPayloads.OffsetRequest(subjects: subjects, distance: "-1")), "invalid_distance");
        Assert.True(Validate(GeometryPayloads.OffsetRequest(subjects: subjects, distance: "1")).IsValid);
    }

    [Fact]
    public void ValidateOffset_SubjectsAtTheMaximumPass_AndOneMoreFails()
    {
        var options = new GeometryOptions { MaxSubjects = 2 };
        var two = $"{GeometryPayloads.Square40},{GeometryPayloads.Square40}";
        var three = $"{two},{GeometryPayloads.Square40}";

        Assert.True(Validate(GeometryPayloads.OffsetRequest(subjects: two), options).IsValid);
        AssertFailure(Validate(GeometryPayloads.OffsetRequest(subjects: three), options), "too_many_subjects");
    }

    [Fact]
    public void ValidateOffset_VerticesAtTheMaximumPass_AndOneMoreFails()
    {
        // El cuadrado tiene 4 vértices.
        Assert.True(Validate(GeometryPayloads.OffsetRequest(), new GeometryOptions { MaxVertices = 4 }).IsValid);
        AssertFailure(Validate(GeometryPayloads.OffsetRequest(), new GeometryOptions { MaxVertices = 3 }), "too_many_vertices");
    }

    [Fact]
    public void ValidateOffset_DoesNotMutateOrReuseTheBooleanResult()
    {
        var validator = CreateValidator();

        var offset = validator.ValidateOffset(GeometryPayloads.ParseOffset(GeometryPayloads.OffsetRequest()));
        var boolean = validator.Validate(GeometryPayloads.Parse(GeometryPayloads.Request()));

        Assert.NotNull(offset.OffsetParameters);
        Assert.Null(offset.Parameters);
        Assert.NotNull(boolean.Parameters);
        Assert.Null(boolean.OffsetParameters);
    }
}

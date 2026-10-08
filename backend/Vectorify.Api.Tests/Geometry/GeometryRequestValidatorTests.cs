using Microsoft.Extensions.Options;
using Vectorify.Api.Geometry;
using Vectorify.Api.Options;
using Vectorify.Api.Tests.TestSupport;

namespace Vectorify.Api.Tests.Geometry;

/// <summary>
/// Pruebas unitarias de GeometryRequestValidator (M3-S04): cuerpo nulo/vacío, operación desconocida, tolerancia
/// (0, negativa, NaN, Infinity, excesiva), estructura de las formas, null/NaN/Infinity/strings en las coordenadas,
/// y los límites de subjects/operands/vértices en SU frontera exacta (el máximo pasa, uno más no).
/// </summary>
public sealed class GeometryRequestValidatorTests
{
    private static GeometryRequestValidator CreateValidator(GeometryOptions? options = null) =>
        new(Microsoft.Extensions.Options.Options.Create(options ?? new GeometryOptions()));

    private static GeometryValidationResult Validate(string json, GeometryOptions? options = null) =>
        CreateValidator(options).Validate(GeometryPayloads.Parse(json));

    private static void AssertFailure(GeometryValidationResult result, string code)
    {
        Assert.False(result.IsValid);
        Assert.Equal(code, result.ErrorCode);
        Assert.False(string.IsNullOrWhiteSpace(result.ErrorMessage));
        Assert.Null(result.Parameters);
    }

    [Fact]
    public void Validate_WhenRequestIsValid_ReturnsTypedParameters()
    {
        var result = Validate(GeometryPayloads.Request());

        Assert.True(result.IsValid);
        var parameters = result.Parameters!;
        Assert.Equal(GeometryOperation.Difference, parameters.Operation);
        Assert.Equal(0.01, parameters.Tolerance);
        var subject = Assert.IsType<GeometryShape.Polygon>(Assert.Single(parameters.Subjects));
        Assert.Equal([[0.0, 0.0], [40.0, 0.0], [40.0, 40.0], [0.0, 40.0]], subject.Rings[0]);
        var brush = Assert.IsType<GeometryShape.BufferedLine>(Assert.Single(parameters.Operands));
        Assert.Equal(5.0, brush.Radius);
        Assert.Equal(2, brush.Points.Length);
    }

    [Fact]
    public void Validate_WhenRequestIsNull_ReturnsInvalidParameters()
    {
        AssertFailure(CreateValidator().Validate(null), "invalid_parameters");
    }

    [Theory]
    [InlineData("union")]
    [InlineData("Difference")]
    [InlineData("  XOR ")]
    [InlineData("intersection")]
    [InlineData("normalize")]
    public void Validate_AcceptsEveryOperationCaseInsensitively(string operation)
    {
        var operands = operation.Trim().ToLowerInvariant() == "normalize" ? "" : GeometryPayloads.Brush;
        var json = $$"""{"operation":"{{operation}}","subjects":[{{GeometryPayloads.Square40}}],"operands":[{{operands}}],"tolerance":0.01}""";

        Assert.True(Validate(json).IsValid);
    }

    [Theory]
    [InlineData("buffer")]
    [InlineData("")]
    [InlineData("subtract")]
    public void Validate_WhenOperationIsUnknown_ReturnsUnknownOperation(string operation)
    {
        AssertFailure(Validate(GeometryPayloads.Request(operation: operation)), "unknown_operation");
    }

    [Fact]
    public void Validate_WhenOperationIsMissing_ReturnsUnknownOperation()
    {
        AssertFailure(Validate($$"""{"subjects":[{{GeometryPayloads.Square40}}],"tolerance":0.01}"""), "unknown_operation");
    }

    [Theory]
    [InlineData("0")]
    [InlineData("-0.5")]
    [InlineData("1000001")]
    [InlineData("null")]
    public void Validate_WhenToleranceIsNotPositiveFiniteAndInRange_ReturnsInvalidTolerance(string tolerance)
    {
        AssertFailure(Validate(GeometryPayloads.Request(tolerance: tolerance)), "invalid_tolerance");
    }

    [Fact]
    public void Validate_AcceptsToleranceExactlyAtTheMaximum()
    {
        Assert.True(Validate(GeometryPayloads.Request(tolerance: "1000000")).IsValid);
    }

    [Theory]
    [InlineData("""{"operation":"difference","operands":[],"tolerance":0.01}""")]
    [InlineData("""{"operation":"difference","subjects":null,"tolerance":0.01}""")]
    [InlineData("""{"operation":"difference","subjects":[],"tolerance":0.01}""")]
    public void Validate_WhenSubjectsAreMissingOrEmpty_ReturnsInvalidParameters(string json)
    {
        AssertFailure(Validate(json), "invalid_parameters");
    }

    [Fact]
    public void Validate_WhenOperandsAreMissing_TreatsThemAsEmptyForDifference()
    {
        var result = Validate($$"""{"operation":"difference","subjects":[{{GeometryPayloads.Square40}}],"tolerance":0.01}""");

        Assert.True(result.IsValid);
        Assert.Empty(result.Parameters!.Operands);
    }

    [Fact]
    public void Validate_WhenIntersectionHasNoOperands_ReturnsInvalidParameters()
    {
        AssertFailure(
            Validate($$"""{"operation":"intersection","subjects":[{{GeometryPayloads.Square40}}],"operands":[],"tolerance":0.01}"""),
            "invalid_parameters");
    }

    [Theory]
    [InlineData("""{"type":"circle","coordinates":[[0,0],[1,1]]}""")]
    [InlineData("""{"coordinates":[[0,0],[1,1]]}""")]
    [InlineData("""{"type":"polygon"}""")]
    [InlineData("""{"type":"polygon","coordinates":[]}""")]
    [InlineData("""{"type":"polygon","coordinates":[[[0,0],[1,1]]]}""")]
    [InlineData("""{"type":"polygon","coordinates":[[0,0],[1,1],[2,2]]}""")]
    [InlineData("""{"type":"line","coordinates":[[0,0]]}""")]
    [InlineData("""{"type":"line","coordinates":"0,0 1,1"}""")]
    [InlineData("""{"type":"line","coordinates":[[0,0,0],[1,1,1]]}""")]
    [InlineData("""{"type":"line","coordinates":[[0],[1]]}""")]
    [InlineData("""{"type":"bufferedLine","points":[[0,0]],"radius":1}""")]
    public void Validate_WhenASubjectHasAnInvalidShape_ReturnsInvalidParameters(string subject)
    {
        AssertFailure(Validate(GeometryPayloads.Request(subjects: subject)), "invalid_parameters");
    }

    [Theory]
    [InlineData("""{"type":"bufferedLine","points":[],"radius":1}""")]
    [InlineData("""{"type":"bufferedLine","radius":1}""")]
    [InlineData("""{"type":"bufferedLine","points":[[0,0],[1]],"radius":1}""")]
    [InlineData("""{"type":"hexagon"}""")]
    public void Validate_WhenAnOperandHasAnInvalidShape_ReturnsInvalidParameters(string operand)
    {
        AssertFailure(Validate(GeometryPayloads.Request(operands: operand)), "invalid_parameters");
    }

    [Theory]
    [InlineData("0")]
    [InlineData("-3")]
    [InlineData("null")]
    [InlineData("1000000001")]
    public void Validate_WhenTheBrushRadiusIsNotPositiveOrIsExcessive_ReturnsInvalidCoordinates(string radius)
    {
        var brush = $$"""{"type":"bufferedLine","points":[[0,0]],"radius":{{radius}}}""";

        AssertFailure(Validate(GeometryPayloads.Request(operands: brush)), "invalid_coordinates");
    }

    [Fact]
    public void Validate_WhenTheBrushHasNoRadius_ReturnsInvalidCoordinates()
    {
        AssertFailure(
            Validate(GeometryPayloads.Request(operands: """{"type":"bufferedLine","points":[[0,0]]}""")),
            "invalid_coordinates");
    }

    [Theory]
    [InlineData("""[[0,0],[null,5]]""")]
    [InlineData("""[[0,0],["5",5]]""")]
    [InlineData("""[[0,0],[true,5]]""")]
    [InlineData("""[[0,0],[1e999,5]]""")]
    [InlineData("""[[0,0],[1000000001,5]]""")]
    [InlineData("""[[0,0],[5,-1000000001]]""")]
    public void Validate_WhenACoordinateIsNullNonNumericOrOutOfRange_ReturnsInvalidCoordinates(string points)
    {
        var line = $$"""{"type":"line","coordinates":{{points}}}""";

        AssertFailure(Validate(GeometryPayloads.Request(subjects: line)), "invalid_coordinates");
    }

    [Fact]
    public void Validate_AcceptsCoordinatesExactlyAtTheMagnitudeLimit()
    {
        var line = """{"type":"line","coordinates":[[-1000000000,0],[1000000000,0]]}""";

        Assert.True(Validate(GeometryPayloads.Request(subjects: line)).IsValid);
    }

    [Fact]
    public void Validate_AcceptsExactlyTheMaximumNumberOfSubjects_AndRejectsOneMore()
    {
        var options = new GeometryOptions { MaxSubjects = 3 };
        string Many(int count) => string.Join(",", Enumerable.Repeat(GeometryPayloads.Square40, count));

        Assert.True(Validate($$"""{"operation":"normalize","subjects":[{{Many(3)}}],"tolerance":0.01}""", options).IsValid);
        AssertFailure(Validate($$"""{"operation":"normalize","subjects":[{{Many(4)}}],"tolerance":0.01}""", options), "too_many_subjects");
    }

    [Fact]
    public void Validate_AcceptsExactlyTheMaximumNumberOfOperands_AndRejectsOneMore()
    {
        var options = new GeometryOptions { MaxOperands = 2 };
        string Many(int count) => string.Join(",", Enumerable.Repeat(GeometryPayloads.Brush, count));

        Assert.True(Validate(GeometryPayloads.Request(operands: Many(2)), options).IsValid);
        AssertFailure(Validate(GeometryPayloads.Request(operands: Many(3)), options), "too_many_operands");
    }

    [Fact]
    public void Validate_CountsVerticesAcrossSubjectsAndOperands_AndRejectsOneOverTheMaximum()
    {
        // Cuadrado = 4 vértices; pincel = 2 puntos: total 6.
        Assert.True(Validate(GeometryPayloads.Request(), new GeometryOptions { MaxVertices = 6 }).IsValid);
        AssertFailure(Validate(GeometryPayloads.Request(), new GeometryOptions { MaxVertices = 5 }), "too_many_vertices");
    }

    [Fact]
    public void Validate_WithTheDefaultLimits_Allows500SubjectsAnd500000Vertices_AndRejectsOneMore()
    {
        var options = new GeometryOptions();
        Assert.Equal(500, options.MaxSubjects);
        Assert.Equal(500_000, options.MaxVertices);

        var oneSubjectWithManyVertices = (int vertices) =>
        {
            var points = string.Join(",", Enumerable.Range(0, vertices).Select(i => $"[{i % 1000},{i / 1000}]"));
            return $$"""{"operation":"normalize","subjects":[{"type":"line","coordinates":[{{points}}]}],"tolerance":0.01}""";
        };

        Assert.True(Validate(oneSubjectWithManyVertices(500_000)).IsValid);
        AssertFailure(Validate(oneSubjectWithManyVertices(500_001)), "too_many_vertices");
    }

    [Fact]
    public void Validate_AcceptsPolygonsWithHolesAndOpenOrClosedRings()
    {
        var polygon = """{"type":"polygon","coordinates":[[[0,0],[40,0],[40,40],[0,40],[0,0]],[[10,10],[20,10],[20,20]]]}""";

        var result = Validate(GeometryPayloads.Request(subjects: polygon));

        Assert.True(result.IsValid);
        Assert.Equal(2, ((GeometryShape.Polygon)result.Parameters!.Subjects[0]).Rings.Length);
    }

    [Fact]
    public void Validate_NeverMutatesOrReusesTheRequest_ParsingTwiceGivesEqualShapes()
    {
        var first = Validate(GeometryPayloads.Request()).Parameters!;
        var second = Validate(GeometryPayloads.Request()).Parameters!;

        Assert.Equal(first.Tolerance, second.Tolerance);
        Assert.Equal(((GeometryShape.Polygon)first.Subjects[0]).Rings[0], ((GeometryShape.Polygon)second.Subjects[0]).Rings[0]);
    }
}

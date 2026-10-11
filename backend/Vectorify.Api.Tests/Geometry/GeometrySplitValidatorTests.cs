using Vectorify.Api.Contracts;
using Vectorify.Api.Geometry;
using Vectorify.Api.Options;
using Vectorify.Api.Tests.TestSupport;

namespace Vectorify.Api.Tests.Geometry;

/// <summary>
/// Pruebas unitarias de GeometryRequestValidator.ValidateSplit (M3-S10): cada regla de 400 por separado (cuerpo nulo, modo desconocido,
/// ancho de ranura 0 / negativo / NaN / fuera del tope, tolerancia, subjects, línea de corte ausente / de 1 punto / con todos los puntos
/// iguales / con null, NaN o Infinity) y los límites en SU frontera exacta (el máximo pasa, uno más no).
/// </summary>
public sealed class GeometrySplitValidatorTests
{
    private static GeometryRequestValidator CreateValidator(GeometryOptions? options = null) =>
        new(Microsoft.Extensions.Options.Options.Create(options ?? new GeometryOptions()));

    private static GeometryValidationResult Validate(string json, GeometryOptions? options = null) =>
        CreateValidator(options).ValidateSplit(GeometryPayloads.ParseSplit(json));

    private static void AssertFailure(GeometryValidationResult result, string code)
    {
        Assert.False(result.IsValid);
        Assert.Equal(code, result.ErrorCode);
        Assert.False(string.IsNullOrWhiteSpace(result.ErrorMessage));
        Assert.Null(result.SplitParameters);
        Assert.Null(result.OffsetParameters);
        Assert.Null(result.Parameters);
    }

    private static string Cut(string points) => $$"""{"points":{{points}}}""";

    [Fact]
    public void ValidateSplit_WhenRequestIsValid_ReturnsTypedParameters()
    {
        var result = Validate(GeometryPayloads.SplitRequest(mode: "slot", slotWidth: "0.2", extend: "true", tolerance: "0.02"));

        Assert.True(result.IsValid);
        var parameters = result.SplitParameters!;
        Assert.Equal(SplitMode.Slot, parameters.Mode);
        Assert.Equal(0.2, parameters.SlotWidth);
        Assert.True(parameters.Extend);
        Assert.Equal(0.02, parameters.Tolerance);
        Assert.Equal([[20.0, -5.0], [20.0, 45.0]], parameters.CutterPoints);
        var subject = Assert.IsType<GeometryShape.Polygon>(Assert.Single(parameters.Subjects));
        Assert.Equal([[0.0, 0.0], [40.0, 0.0], [40.0, 40.0], [0.0, 40.0]], subject.Rings[0]);
    }

    [Fact]
    public void ValidateSplit_WhenSlotWidthAndExtendAreMissing_UsesTheDocumentedDefaults()
    {
        var json = $$"""{"subjects":[{{GeometryPayloads.Square40}}],"cutter":{{GeometryPayloads.Cutter}},"mode":"split","tolerance":0.01}""";

        var parameters = Validate(json).SplitParameters!;

        Assert.Equal(0.0, parameters.SlotWidth);
        Assert.False(parameters.Extend);
        Assert.Equal(SplitMode.Split, parameters.Mode);
    }

    [Theory]
    [InlineData("split", SplitMode.Split)]
    [InlineData("SLOT", SplitMode.Slot)]
    [InlineData("  Split ", SplitMode.Split)]
    public void ValidateSplit_AcceptsEveryModeCaseInsensitively(string mode, SplitMode expected)
    {
        var width = expected == SplitMode.Slot ? "0.5" : "0";

        Assert.Equal(expected, Validate(GeometryPayloads.SplitRequest(mode: mode, slotWidth: width)).SplitParameters!.Mode);
    }

    [Fact]
    public void ValidateSplit_WhenRequestIsNull_ReturnsInvalidParameters()
    {
        AssertFailure(CreateValidator().ValidateSplit(null), "invalid_parameters");
    }

    [Theory]
    [InlineData("chop")]
    [InlineData("")]
    [InlineData("difference")]
    public void ValidateSplit_WhenModeIsUnknown_ReturnsUnknownSplitMode(string mode)
    {
        AssertFailure(Validate(GeometryPayloads.SplitRequest(mode: mode)), "unknown_split_mode");
    }

    [Fact]
    public void ValidateSplit_WhenModeIsMissing_ReturnsUnknownSplitMode()
    {
        var json = $$"""{"subjects":[{{GeometryPayloads.Square40}}],"cutter":{{GeometryPayloads.Cutter}},"tolerance":0.01}""";

        AssertFailure(Validate(json), "unknown_split_mode");
    }

    [Theory]
    [InlineData("0")]
    [InlineData("-0.2")]
    [InlineData("1000001")]
    public void ValidateSplit_InSlotMode_WhenTheWidthIsZeroNegativeOrBeyondTheMaximum_ReturnsInvalidSlotWidth(string width)
    {
        AssertFailure(Validate(GeometryPayloads.SplitRequest(mode: "slot", slotWidth: width)), "invalid_slot_width");
    }

    [Fact]
    public void ValidateSplit_InSlotMode_WhenTheWidthIsMissing_ReturnsInvalidSlotWidth()
    {
        var json = $$"""{"subjects":[{{GeometryPayloads.Square40}}],"cutter":{{GeometryPayloads.Cutter}},"mode":"slot","tolerance":0.01}""";

        AssertFailure(Validate(json), "invalid_slot_width");
    }

    [Theory]
    [InlineData(double.NaN)]
    [InlineData(double.PositiveInfinity)]
    [InlineData(double.NegativeInfinity)]
    public void ValidateSplit_WhenTheWidthIsNotFinite_ReturnsInvalidSlotWidthInBothModes(double width)
    {
        foreach (var mode in new[] { "split", "slot" })
        {
            var request = GeometryPayloads.ParseSplit(GeometryPayloads.SplitRequest(mode: mode, slotWidth: "1")) with { SlotWidth = width };

            AssertFailure(CreateValidator().ValidateSplit(request), "invalid_slot_width");
        }
    }

    [Fact]
    public void ValidateSplit_InSplitMode_IgnoresTheWidthButStillRejectsANegativeOne()
    {
        // Ancho 50 con el tope en 10: en modo dividir no se compara con el tope (se ignora); uno negativo es absurdo y se rechaza.
        var options = new GeometryOptions { MaxOffsetDistance = 10 };

        Assert.True(Validate(GeometryPayloads.SplitRequest(mode: "split", slotWidth: "50"), options).IsValid);
        AssertFailure(Validate(GeometryPayloads.SplitRequest(mode: "split", slotWidth: "-1"), options), "invalid_slot_width");
    }

    [Fact]
    public void ValidateSplit_AcceptsTheSlotWidthExactlyAtTheConfiguredMaximum_AndRejectsJustBeyond()
    {
        var options = new GeometryOptions { MaxOffsetDistance = 50 };

        Assert.True(Validate(GeometryPayloads.SplitRequest(mode: "slot", slotWidth: "50"), options).IsValid);
        AssertFailure(Validate(GeometryPayloads.SplitRequest(mode: "slot", slotWidth: "50.0001"), options), "invalid_slot_width");
    }

    [Theory]
    [InlineData("0")]
    [InlineData("-1")]
    [InlineData("1000001")]
    public void ValidateSplit_WhenToleranceIsOutOfRange_ReturnsInvalidTolerance(string tolerance)
    {
        AssertFailure(Validate(GeometryPayloads.SplitRequest(tolerance: tolerance)), "invalid_tolerance");
    }

    [Fact]
    public void ValidateSplit_WhenToleranceIsMissingOrNotFinite_ReturnsInvalidTolerance()
    {
        var missing = $$"""{"subjects":[{{GeometryPayloads.Square40}}],"cutter":{{GeometryPayloads.Cutter}},"mode":"split"}""";
        var request = GeometryPayloads.ParseSplit(GeometryPayloads.SplitRequest()) with { Tolerance = double.NaN };

        AssertFailure(Validate(missing), "invalid_tolerance");
        AssertFailure(CreateValidator().ValidateSplit(request), "invalid_tolerance");
        AssertFailure(CreateValidator().ValidateSplit(request with { Tolerance = double.PositiveInfinity }), "invalid_tolerance");
    }

    [Fact]
    public void ValidateSplit_WhenSubjectsAreMissingOrEmpty_ReturnsInvalidParameters()
    {
        AssertFailure(Validate($$"""{"cutter":{{GeometryPayloads.Cutter}},"mode":"split","tolerance":0.01}"""), "invalid_parameters");
        AssertFailure(Validate(GeometryPayloads.SplitRequest(subjects: string.Empty)), "invalid_parameters");
    }

    [Fact]
    public void ValidateSplit_RejectsABufferedLineAsSubject()
    {
        AssertFailure(Validate(GeometryPayloads.SplitRequest(subjects: GeometryPayloads.Brush)), "invalid_parameters");
    }

    [Theory]
    [InlineData("""{"type":"circle","coordinates":[[0,0]]}""")]
    [InlineData("""{"type":"polygon","coordinates":[]}""")]
    [InlineData("""{"type":"polygon","coordinates":[[[0,0],[1,1]]]}""")]
    [InlineData("""{"type":"line","coordinates":[[0,0]]}""")]
    [InlineData("""{"type":"line","coordinates":[[0,0,5],[1,1,5]]}""")]
    public void ValidateSplit_WhenAShapeIsMalformed_ReturnsInvalidParameters(string subject)
    {
        AssertFailure(Validate(GeometryPayloads.SplitRequest(subjects: subject)), "invalid_parameters");
    }

    [Theory]
    [InlineData("""{"type":"line","coordinates":[[0,0],[null,1]]}""")]
    [InlineData("""{"type":"line","coordinates":[[0,0],["NaN",1]]}""")]
    [InlineData("""{"type":"line","coordinates":[[0,0],[1e999,1]]}""")]
    [InlineData("""{"type":"line","coordinates":[[0,0],[2000000000,1]]}""")]
    public void ValidateSplit_WhenASubjectCoordinateIsNotFinite_ReturnsInvalidCoordinates(string subject)
    {
        AssertFailure(Validate(GeometryPayloads.SplitRequest(subjects: subject)), "invalid_coordinates");
    }

    [Fact]
    public void ValidateSplit_AcceptsLinesAsSubjects()
    {
        var result = Validate(GeometryPayloads.SplitRequest(subjects: $"{GeometryPayloads.Square40},{GeometryPayloads.Line}"));

        Assert.True(result.IsValid);
        Assert.IsType<GeometryShape.Polygon>(result.SplitParameters!.Subjects[0]);
        Assert.IsType<GeometryShape.Line>(result.SplitParameters.Subjects[1]);
    }

    // ---- Línea de corte ----

    [Fact]
    public void ValidateSplit_WhenTheCutterIsMissing_ReturnsInvalidCutter()
    {
        AssertFailure(Validate($$"""{"subjects":[{{GeometryPayloads.Square40}}],"mode":"split","tolerance":0.01}"""), "invalid_cutter");
        AssertFailure(Validate(GeometryPayloads.SplitRequest(cutter: "{}")), "invalid_cutter");
        AssertFailure(Validate(GeometryPayloads.SplitRequest(cutter: """{"points":null}""")), "invalid_cutter");
        AssertFailure(Validate(GeometryPayloads.SplitRequest(cutter: """{"points":"abc"}""")), "invalid_cutter");
    }

    [Theory]
    [InlineData("[]")]
    [InlineData("[[1,2]]")]
    [InlineData("[[1,2,3],[4,5,6]]")]
    [InlineData("[[1],[2]]")]
    [InlineData("[1,2]")]
    public void ValidateSplit_WhenTheCutterIsNotAPolylineOfAtLeastTwoPoints_ReturnsInvalidCutter(string points)
    {
        AssertFailure(Validate(GeometryPayloads.SplitRequest(cutter: Cut(points))), "invalid_cutter");
    }

    [Theory]
    [InlineData("[[3,3],[3,3]]")]
    [InlineData("[[3,3],[3,3],[3,3]]")]
    public void ValidateSplit_WhenEveryCutterPointIsTheSame_ReturnsInvalidCutter(string points)
    {
        AssertFailure(Validate(GeometryPayloads.SplitRequest(cutter: Cut(points))), "invalid_cutter");
    }

    [Fact]
    public void ValidateSplit_AcceptsACutterWithSomeRepeatedConsecutivePoints()
    {
        var result = Validate(GeometryPayloads.SplitRequest(cutter: Cut("[[3,3],[3,3],[8,3]]")));

        Assert.True(result.IsValid);
        Assert.Equal(3, result.SplitParameters!.CutterPoints.Length);
    }

    [Theory]
    [InlineData("[[0,0],[null,1]]")]
    [InlineData("[[0,0],[\"NaN\",1]]")]
    [InlineData("[[0,0],[1e999,1]]")]
    [InlineData("[[0,0],[1,2000000000]]")]
    [InlineData("[[0,0],[\"Infinity\",1]]")]
    public void ValidateSplit_WhenACutterCoordinateIsNotFinite_ReturnsInvalidCoordinates(string points)
    {
        AssertFailure(Validate(GeometryPayloads.SplitRequest(cutter: Cut(points))), "invalid_coordinates");
    }

    [Fact]
    public void ValidateSplit_CutterPointsAtTheMaximumPass_AndOneMoreFails()
    {
        var options = new GeometryOptions { MaxCutterPoints = 3 };

        Assert.True(Validate(GeometryPayloads.SplitRequest(cutter: Cut("[[0,0],[1,1],[2,0]]")), options).IsValid);
        AssertFailure(Validate(GeometryPayloads.SplitRequest(cutter: Cut("[[0,0],[1,1],[2,0],[3,1]]")), options), "too_many_cutter_points");
    }

    // ---- Límites de la petición ----

    [Fact]
    public void ValidateSplit_SubjectsAtTheMaximumPass_AndOneMoreFails()
    {
        var options = new GeometryOptions { MaxSubjects = 2 };
        var two = $"{GeometryPayloads.Square40},{GeometryPayloads.Square40}";
        var three = $"{two},{GeometryPayloads.Square40}";

        Assert.True(Validate(GeometryPayloads.SplitRequest(subjects: two), options).IsValid);
        AssertFailure(Validate(GeometryPayloads.SplitRequest(subjects: three), options), "too_many_subjects");
    }

    [Fact]
    public void ValidateSplit_TheCutterPointsCountAgainstTheVertexLimit()
    {
        // 4 vértices del cuadrado + 2 del corte = 6.
        Assert.True(Validate(GeometryPayloads.SplitRequest(), new GeometryOptions { MaxVertices = 6 }).IsValid);
        AssertFailure(Validate(GeometryPayloads.SplitRequest(), new GeometryOptions { MaxVertices = 5 }), "too_many_vertices");
    }

    [Fact]
    public void ValidateSplit_DoesNotMixItsParametersWithTheOtherOperations()
    {
        var validator = CreateValidator();

        var split = validator.ValidateSplit(GeometryPayloads.ParseSplit(GeometryPayloads.SplitRequest()));
        var offset = validator.ValidateOffset(GeometryPayloads.ParseOffset(GeometryPayloads.OffsetRequest()));

        Assert.NotNull(split.SplitParameters);
        Assert.Null(split.OffsetParameters);
        Assert.Null(split.Parameters);
        Assert.NotNull(offset.OffsetParameters);
        Assert.Null(offset.SplitParameters);
    }
}

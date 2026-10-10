using System.Text.Json;
using Microsoft.Extensions.Options;
using Vectorify.Api.Contracts;
using Vectorify.Api.Options;

namespace Vectorify.Api.Geometry;

/// <summary>
/// Implementación de <see cref="IGeometryRequestValidator"/>. Los códigos de error son estables (el frontend los mapea):
/// invalid_parameters (cuerpo/estructura), unknown_operation, invalid_tolerance, invalid_coordinates (null/NaN/Infinity/
/// fuera de límites), too_many_subjects, too_many_operands, too_many_vertices. El offset (M3-S09) suma invalid_distance
/// (0, NaN/Infinity, fuera del tope, interior con líneas), unknown_join_style, unknown_cap_style e invalid_mitre_limit.
/// Todos terminan en 400.
/// </summary>
public sealed class GeometryRequestValidator : IGeometryRequestValidator
{
    private readonly GeometryOptions _options;

    public GeometryRequestValidator(IOptions<GeometryOptions> options)
    {
        _options = options.Value;
    }

    public GeometryValidationResult Validate(GeometryBooleanRequest? request)
    {
        if (request is null)
        {
            return Fail("invalid_parameters", "El cuerpo de la petición es requerido.");
        }

        if (!GeometryOperationNames.TryParse(request.Operation, out var operation))
        {
            return Fail(
                "unknown_operation",
                $"operation '{request.Operation}' desconocida. Valores válidos: union, difference, intersection, intersection_all, xor, normalize.");
        }

        var tolerance = request.Tolerance;
        if (tolerance is null || !double.IsFinite(tolerance.Value) || tolerance.Value <= 0 || tolerance.Value > _options.MaxTolerance)
        {
            return Fail("invalid_tolerance", $"tolerance debe ser un número finito en el rango (0, {_options.MaxTolerance}].");
        }

        if (request.Subjects is null || request.Subjects.Count == 0)
        {
            return Fail("invalid_parameters", "subjects es requerido y no puede estar vacío.");
        }

        if (request.Subjects.Count > _options.MaxSubjects)
        {
            return Fail("too_many_subjects", $"La petición trae {request.Subjects.Count} subjects; el máximo es {_options.MaxSubjects}.");
        }

        var operandRequests = request.Operands ?? [];
        if (operandRequests.Count > _options.MaxOperands)
        {
            return Fail("too_many_operands", $"La petición trae {operandRequests.Count} operands; el máximo es {_options.MaxOperands}.");
        }

        if (operation == GeometryOperation.Intersection && operandRequests.Count == 0)
        {
            return Fail("invalid_parameters", "La intersección necesita al menos un operando.");
        }

        // M3-S08: la región común necesita al menos dos formas entre subjects y operands (con una sola no hay "común").
        if (operation == GeometryOperation.IntersectionAll && request.Subjects.Count + operandRequests.Count < 2)
        {
            return Fail("invalid_parameters", "La intersección común necesita al menos dos formas entre subjects y operands.");
        }

        var vertexCount = 0;
        var subjects = new List<GeometryShape>(request.Subjects.Count);
        for (var index = 0; index < request.Subjects.Count; index++)
        {
            var (shape, failure) = ParseShape(request.Subjects[index], allowBufferedLine: false, $"subjects[{index}]", ref vertexCount);
            if (failure is not null)
            {
                return failure;
            }

            subjects.Add(shape!);
        }

        var operands = new List<GeometryShape>(operandRequests.Count);
        for (var index = 0; index < operandRequests.Count; index++)
        {
            var (shape, failure) = ParseShape(operandRequests[index], allowBufferedLine: true, $"operands[{index}]", ref vertexCount);
            if (failure is not null)
            {
                return failure;
            }

            operands.Add(shape!);
        }

        return GeometryValidationResult.Success(new GeometryBooleanParameters(operation, subjects, operands, tolerance.Value));
    }

    /// <summary>Límite de inglete por defecto (M3-S09) cuando la petición no lo trae: el mismo que el panel del editor.</summary>
    public const double DefaultMitreLimit = 2;

    public GeometryValidationResult ValidateOffset(GeometryOffsetRequest? request)
    {
        if (request is null)
        {
            return Fail("invalid_parameters", "El cuerpo de la petición es requerido.");
        }

        var distance = request.Distance;
        if (distance is null || !double.IsFinite(distance.Value) || distance.Value == 0 || Math.Abs(distance.Value) > _options.MaxOffsetDistance)
        {
            return Fail(
                "invalid_distance",
                $"distance debe ser un número finito distinto de 0 con valor absoluto <= {_options.MaxOffsetDistance} (unidades de documento).");
        }

        // Join y cap son opcionales (default round); uno presente pero desconocido es un error, no se reinterpreta.
        var joinStyle = OffsetJoinStyle.Round;
        if (request.JoinStyle is not null && !OffsetStyleNames.TryParseJoin(request.JoinStyle, out joinStyle))
        {
            return Fail("unknown_join_style", $"joinStyle '{request.JoinStyle}' desconocido. Valores válidos: round, mitre, bevel.");
        }

        var capStyle = OffsetCapStyle.Round;
        if (request.CapStyle is not null && !OffsetStyleNames.TryParseCap(request.CapStyle, out capStyle))
        {
            return Fail("unknown_cap_style", $"capStyle '{request.CapStyle}' desconocido. Valores válidos: round, flat, square.");
        }

        var mitreLimit = request.MitreLimit ?? DefaultMitreLimit;
        if (!double.IsFinite(mitreLimit) || mitreLimit <= 0 || mitreLimit > _options.MaxMitreLimit)
        {
            return Fail("invalid_mitre_limit", $"mitreLimit debe ser un número finito en el rango (0, {_options.MaxMitreLimit}].");
        }

        var tolerance = request.Tolerance;
        if (tolerance is null || !double.IsFinite(tolerance.Value) || tolerance.Value <= 0 || tolerance.Value > _options.MaxTolerance)
        {
            return Fail("invalid_tolerance", $"tolerance debe ser un número finito en el rango (0, {_options.MaxTolerance}].");
        }

        if (request.Subjects is null || request.Subjects.Count == 0)
        {
            return Fail("invalid_parameters", "subjects es requerido y no puede estar vacío.");
        }

        if (request.Subjects.Count > _options.MaxSubjects)
        {
            return Fail("too_many_subjects", $"La petición trae {request.Subjects.Count} subjects; el máximo es {_options.MaxSubjects}.");
        }

        var vertexCount = 0;
        var subjects = new List<GeometryShape>(request.Subjects.Count);
        for (var index = 0; index < request.Subjects.Count; index++)
        {
            var (shape, failure) = ParseShape(request.Subjects[index], allowBufferedLine: false, $"subjects[{index}]", ref vertexCount);
            if (failure is not null)
            {
                return failure;
            }

            subjects.Add(shape!);
        }

        // Una línea abierta no tiene interior: solo se desplaza a ambos lados. Se rechaza en vez de reinterpretarla.
        if (distance.Value < 0 && subjects.Any(shape => shape is GeometryShape.Line))
        {
            return Fail("invalid_distance", "Una línea solo se desplaza a ambos lados: la distancia interior (negativa) no aplica a líneas.");
        }

        return GeometryValidationResult.Success(new GeometryOffsetParameters(subjects, distance.Value, joinStyle, mitreLimit, capStyle, tolerance.Value));
    }

    private static GeometryValidationResult Fail(string code, string message) => GeometryValidationResult.Failure(code, message);

    private (GeometryShape? Shape, GeometryValidationResult? Failure) ParseShape(
        GeometryShapeRequest? shape, bool allowBufferedLine, string path, ref int vertexCount)
    {
        if (shape is null)
        {
            return (null, Fail("invalid_parameters", $"{path} no puede ser nulo."));
        }

        switch (shape.Type?.Trim())
        {
            case "polygon":
            {
                if (shape.Coordinates is not { ValueKind: JsonValueKind.Array } rings)
                {
                    return (null, Fail("invalid_parameters", $"{path}.coordinates debe ser una lista de anillos."));
                }

                var parsedRings = new List<double[][]>();
                foreach (var ring in rings.EnumerateArray())
                {
                    var points = ReadPoints(ring, minPoints: 3, $"{path}.coordinates", ref vertexCount, out var failure);
                    if (failure is not null)
                    {
                        return (null, failure);
                    }

                    parsedRings.Add(points!);
                }

                return parsedRings.Count == 0
                    ? (null, Fail("invalid_parameters", $"{path}.coordinates necesita al menos un anillo."))
                    : (new GeometryShape.Polygon([.. parsedRings]), null);
            }

            case "line":
            {
                if (shape.Coordinates is not { } coordinates)
                {
                    return (null, Fail("invalid_parameters", $"{path}.coordinates debe ser una polilínea."));
                }

                var points = ReadPoints(coordinates, minPoints: 2, $"{path}.coordinates", ref vertexCount, out var failure);
                return failure is not null ? (null, failure) : (new GeometryShape.Line(points!), null);
            }

            case "bufferedLine" when allowBufferedLine:
            {
                if (shape.Points is not { } pointsElement)
                {
                    return (null, Fail("invalid_parameters", $"{path}.points debe ser una lista de puntos."));
                }

                var points = ReadPoints(pointsElement, minPoints: 1, $"{path}.points", ref vertexCount, out var failure);
                if (failure is not null)
                {
                    return (null, failure);
                }

                var radius = shape.Radius;
                if (radius is null || !double.IsFinite(radius.Value) || radius.Value <= 0 || radius.Value > _options.MaxCoordinateMagnitude)
                {
                    return (null, Fail("invalid_coordinates", $"{path}.radius debe ser un número finito mayor que 0."));
                }

                return (new GeometryShape.BufferedLine(points!, radius.Value), null);
            }

            default:
                return (null, Fail(
                    "invalid_parameters",
                    $"{path}.type '{shape.Type}' desconocido. Valores válidos: polygon, line{(allowBufferedLine ? ", bufferedLine" : string.Empty)}."));
        }
    }

    /// <summary>Lee [[x,y],...]: cada vértice con exactamente 2 números finitos dentro de los límites; cuenta los vértices contra el máximo total.</summary>
    private double[][]? ReadPoints(JsonElement element, int minPoints, string path, ref int vertexCount, out GeometryValidationResult? failure)
    {
        failure = null;
        if (element.ValueKind != JsonValueKind.Array)
        {
            failure = Fail("invalid_parameters", $"{path} debe ser una lista de puntos [x, y].");
            return null;
        }

        var points = new List<double[]>();
        foreach (var point in element.EnumerateArray())
        {
            vertexCount++;
            if (vertexCount > _options.MaxVertices)
            {
                failure = Fail("too_many_vertices", $"La petición supera el máximo de {_options.MaxVertices} vértices en total.");
                return null;
            }

            if (point.ValueKind != JsonValueKind.Array || point.GetArrayLength() != 2)
            {
                failure = Fail("invalid_parameters", $"{path}: cada punto debe ser [x, y].");
                return null;
            }

            var coordinates = new double[2];
            var slot = 0;
            foreach (var value in point.EnumerateArray())
            {
                if (value.ValueKind != JsonValueKind.Number
                    || !value.TryGetDouble(out var number)
                    || !double.IsFinite(number)
                    || Math.Abs(number) > _options.MaxCoordinateMagnitude)
                {
                    failure = Fail(
                        "invalid_coordinates",
                        $"{path}: las coordenadas deben ser números finitos (no null, NaN ni Infinity) con valor absoluto <= {_options.MaxCoordinateMagnitude}.");
                    return null;
                }

                coordinates[slot++] = number;
            }

            points.Add(coordinates);
        }

        if (points.Count < minPoints)
        {
            failure = Fail("invalid_parameters", $"{path} necesita al menos {minPoints} punto(s).");
            return null;
        }

        return [.. points];
    }
}

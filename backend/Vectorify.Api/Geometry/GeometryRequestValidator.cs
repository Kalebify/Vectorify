using System.Text.Json;
using Microsoft.Extensions.Options;
using Vectorify.Api.Contracts;
using Vectorify.Api.Options;

namespace Vectorify.Api.Geometry;

/// <summary>
/// Implementación de <see cref="IGeometryRequestValidator"/>. Los códigos de error son estables (el frontend los mapea):
/// invalid_parameters (cuerpo/estructura), unknown_operation, invalid_tolerance, invalid_coordinates (null/NaN/Infinity/
/// fuera de límites), too_many_subjects, too_many_operands, too_many_vertices. Todos terminan en 400.
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
                $"operation '{request.Operation}' desconocida. Valores válidos: union, difference, intersection, xor, normalize.");
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

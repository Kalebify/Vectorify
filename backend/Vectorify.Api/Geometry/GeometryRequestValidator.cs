using System.Text.Json;
using Microsoft.Extensions.Options;
using Vectorify.Api.Contracts;
using Vectorify.Api.Options;

namespace Vectorify.Api.Geometry;

/// <summary>
/// Implementación de <see cref="IGeometryRequestValidator"/>. Los códigos de error son estables (el frontend los mapea):
/// invalid_parameters (cuerpo/estructura), unknown_operation, invalid_tolerance, invalid_coordinates (null/NaN/Infinity/
/// fuera de límites), too_many_subjects, too_many_operands, too_many_vertices. El offset (M3-S09) suma invalid_distance
/// (0, NaN/Infinity, fuera del tope, interior con líneas), unknown_join_style, unknown_cap_style e invalid_mitre_limit. El corte (M3-S10) suma
/// unknown_split_mode, invalid_slot_width, invalid_cutter (ausente, &lt; 2 puntos o todos iguales) y too_many_cutter_points. Las piezas flotantes y los
/// bridges (M3-S11) suman unknown_floating_mode, invalid_bridge (sin isla ni ancla, isla negativa, dirección nula), invalid_bridge_width (ancho o largo no
/// finito, &lt;= 0 o fuera del tope) y too_many_bridges.
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

    public GeometryValidationResult ValidateSplit(GeometrySplitRequest? request)
    {
        if (request is null)
        {
            return Fail("invalid_parameters", "El cuerpo de la petición es requerido.");
        }

        if (!SplitModeNames.TryParse(request.Mode, out var mode))
        {
            return Fail("unknown_split_mode", $"mode '{request.Mode}' desconocido. Valores válidos: split, slot.");
        }

        // El ancho siempre debe ser finito y no negativo (en modo dividir se ignora, pero un valor absurdo no se acepta en silencio);
        // en modo ranura además > 0 y dentro del tope de distancias.
        var slotWidth = request.SlotWidth ?? 0;
        if (!double.IsFinite(slotWidth) || slotWidth < 0 || (mode == SplitMode.Slot && (slotWidth == 0 || slotWidth > _options.MaxOffsetDistance)))
        {
            return Fail(
                "invalid_slot_width",
                mode == SplitMode.Slot
                    ? $"slotWidth debe ser un número finito mayor que 0 y <= {_options.MaxOffsetDistance} (unidades de documento)."
                    : "slotWidth debe ser un número finito mayor o igual que 0.");
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

        if (request.Cutter?.Points is not { ValueKind: JsonValueKind.Array } cutterElement)
        {
            return Fail("invalid_cutter", "cutter.points es requerido y debe ser una polilínea [[x, y], ...] de al menos 2 puntos.");
        }

        if (cutterElement.GetArrayLength() > _options.MaxCutterPoints)
        {
            return Fail(
                "too_many_cutter_points",
                $"La línea de corte trae {cutterElement.GetArrayLength()} puntos; el máximo es {_options.MaxCutterPoints}.");
        }

        var readPoints = ReadPoints(cutterElement, minPoints: 2, "cutter.points", ref vertexCount, out var cutterFailure);
        if (cutterFailure is not null)
        {
            // La estructura inválida del corte tiene su propio código; NaN/Infinity y el tope de vértices conservan el de siempre.
            return cutterFailure.ErrorCode == "invalid_parameters" ? Fail("invalid_cutter", cutterFailure.ErrorMessage!) : cutterFailure;
        }

        // Todos los puntos iguales: no hay dirección ni línea (Python lo rechazaría igual tras quitar los repetidos).
        var cutterPoints = readPoints!;
        if (cutterPoints.All(point => point[0] == cutterPoints[0][0] && point[1] == cutterPoints[0][1]))
        {
            return Fail("invalid_cutter", "cutter.points necesita al menos dos puntos distintos.");
        }

        return GeometryValidationResult.Success(new GeometrySplitParameters(subjects, cutterPoints, mode, slotWidth, request.Extend ?? false, tolerance.Value));
    }

    public GeometryValidationResult ValidateFloating(GeometryFloatingRequest? request)
    {
        if (request is null)
        {
            return Fail("invalid_parameters", "El cuerpo de la petición es requerido.");
        }

        if (!FloatingModeNames.TryParse(request.Mode, out var mode))
        {
            return Fail("unknown_floating_mode", $"mode '{request.Mode}' desconocido. Valores válidos: stencil, parts.");
        }

        var tolerance = request.Tolerance;
        if (tolerance is null || !double.IsFinite(tolerance.Value) || tolerance.Value <= 0 || tolerance.Value > _options.MaxTolerance)
        {
            return Fail("invalid_tolerance", $"tolerance debe ser un número finito en el rango (0, {_options.MaxTolerance}].");
        }

        var vertexCount = 0;
        var (subjects, failure) = ParseFloatingSubjects(request.Subjects, ref vertexCount);
        if (failure is not null)
        {
            return failure;
        }

        return GeometryValidationResult.Success(new GeometryFloatingParameters(subjects!, mode, tolerance.Value));
    }

    public GeometryValidationResult ValidateBridge(GeometryBridgeRequest? request)
    {
        if (request is null)
        {
            return Fail("invalid_parameters", "El cuerpo de la petición es requerido.");
        }

        if (!FloatingModeNames.TryParse(request.Mode, out var mode))
        {
            return Fail("unknown_floating_mode", $"mode '{request.Mode}' desconocido. Valores válidos: stencil, parts.");
        }

        var tolerance = request.Tolerance;
        if (tolerance is null || !double.IsFinite(tolerance.Value) || tolerance.Value <= 0 || tolerance.Value > _options.MaxTolerance)
        {
            return Fail("invalid_tolerance", $"tolerance debe ser un número finito en el rango (0, {_options.MaxTolerance}].");
        }

        var bridgeRequests = request.Bridges ?? [];
        if (bridgeRequests.Count > _options.MaxBridges)
        {
            return Fail("too_many_bridges", $"La petición trae {bridgeRequests.Count} bridges; el máximo es {_options.MaxBridges}.");
        }

        var suggest = request.Suggest ?? false;
        if ((suggest || request.SuggestWidth is not null) && !IsValidSize(request.SuggestWidth))
        {
            return Fail("invalid_bridge_width", $"suggestWidth debe ser un número finito mayor que 0 y <= {_options.MaxOffsetDistance} (unidades de documento).");
        }

        var vertexCount = 0;
        var (subjects, failure) = ParseFloatingSubjects(request.Subjects, ref vertexCount);
        if (failure is not null)
        {
            return failure;
        }

        var bridges = new List<GeometryBridgeSpec>(bridgeRequests.Count);
        for (var index = 0; index < bridgeRequests.Count; index++)
        {
            var (spec, bridgeFailure) = ParseBridge(bridgeRequests[index], $"bridges[{index}]");
            if (bridgeFailure is not null)
            {
                return bridgeFailure;
            }

            bridges.Add(spec!);
        }

        return GeometryValidationResult.Success(
            new GeometryBridgeParameters(subjects!, mode, bridges, suggest, suggest ? request.SuggestWidth : null, tolerance.Value));
    }

    private bool IsValidSize(double? value) => value is { } number && double.IsFinite(number) && number > 0 && number <= _options.MaxOffsetDistance;

    /// <summary>Valida las formas del análisis de piezas flotantes: solo polígonos (el relleno), con <c>locked</c> opcional, dentro de los límites.</summary>
    private (List<GeometryFloatingSubject>? Subjects, GeometryValidationResult? Failure) ParseFloatingSubjects(
        IReadOnlyList<GeometryFloatingSubjectRequest>? requests, ref int vertexCount)
    {
        if (requests is null || requests.Count == 0)
        {
            return (null, Fail("invalid_parameters", "subjects es requerido y no puede estar vacío."));
        }

        if (requests.Count > _options.MaxSubjects)
        {
            return (null, Fail("too_many_subjects", $"La petición trae {requests.Count} subjects; el máximo es {_options.MaxSubjects}."));
        }

        var subjects = new List<GeometryFloatingSubject>(requests.Count);
        for (var index = 0; index < requests.Count; index++)
        {
            var subject = requests[index];
            if (subject is null)
            {
                return (null, Fail("invalid_parameters", $"subjects[{index}] no puede ser nulo."));
            }

            var (shape, failure) = ParseShape(
                new GeometryShapeRequest(subject.Type, subject.Coordinates, null, null), allowBufferedLine: false, $"subjects[{index}]", ref vertexCount);
            if (failure is not null)
            {
                return (null, failure);
            }

            if (shape is not GeometryShape.Polygon polygon)
            {
                return (null, Fail("invalid_parameters", $"subjects[{index}].type debe ser 'polygon': solo las formas con relleno se analizan."));
            }

            subjects.Add(new GeometryFloatingSubject(polygon.Rings, subject.Locked ?? false));
        }

        return (subjects, null);
    }

    /// <summary>Valida UN bridge: isla o ancla, isla no negativa, ancla/dirección finitas (dirección no nula), ancho y largo finitos dentro del tope.</summary>
    private (GeometryBridgeSpec? Spec, GeometryValidationResult? Failure) ParseBridge(GeometryBridgeItemRequest? bridge, string path)
    {
        if (bridge is null)
        {
            return (null, Fail("invalid_parameters", $"{path} no puede ser nulo."));
        }

        if (bridge.Island is null && bridge.Anchor is null)
        {
            return (null, Fail("invalid_bridge", $"{path} necesita 'island' o 'anchor'."));
        }

        if (bridge.Island is < 0)
        {
            return (null, Fail("invalid_bridge", $"{path}.island no puede ser negativo."));
        }

        double[]? anchor = null;
        if (bridge.Anchor is not null)
        {
            anchor = ReadPoint(bridge.Anchor);
            if (anchor is null)
            {
                return (null, Fail(
                    "invalid_coordinates",
                    $"{path}.anchor: x e y deben ser números finitos (no null, NaN ni Infinity) con valor absoluto <= {_options.MaxCoordinateMagnitude}."));
            }
        }

        double[]? direction = null;
        if (bridge.Direction is not null)
        {
            direction = ReadPoint(bridge.Direction);
            if (direction is null)
            {
                return (null, Fail(
                    "invalid_coordinates",
                    $"{path}.direction: x e y deben ser números finitos (no null, NaN ni Infinity) con valor absoluto <= {_options.MaxCoordinateMagnitude}."));
            }

            if (direction[0] == 0 && direction[1] == 0)
            {
                return (null, Fail("invalid_bridge", $"{path}.direction no puede ser el vector nulo."));
            }
        }

        if (!IsValidSize(bridge.Width))
        {
            return (null, Fail("invalid_bridge_width", $"{path}.width debe ser un número finito mayor que 0 y <= {_options.MaxOffsetDistance} (unidades de documento)."));
        }

        if (bridge.Length is not null && !IsValidSize(bridge.Length))
        {
            return (null, Fail("invalid_bridge_width", $"{path}.length debe ser un número finito mayor que 0 y <= {_options.MaxOffsetDistance} (unidades de documento)."));
        }

        return (new GeometryBridgeSpec(bridge.Island, anchor, direction, bridge.Width!.Value, bridge.Length), null);
    }

    private double[]? ReadPoint(GeometryPointRequest point) =>
        point.X is { } x && point.Y is { } y
        && double.IsFinite(x) && double.IsFinite(y)
        && Math.Abs(x) <= _options.MaxCoordinateMagnitude && Math.Abs(y) <= _options.MaxCoordinateMagnitude
            ? [x, y]
            : null;

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

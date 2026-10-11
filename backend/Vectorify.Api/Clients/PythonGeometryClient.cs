using System.Text;
using System.Text.Json;
using Vectorify.Api.Contracts;
using Vectorify.Api.Geometry;

namespace Vectorify.Api.Clients;

/// <summary>
/// Implementación de <see cref="IPythonGeometryClient"/> sobre un HttpClient tipado propio (timeout Geometry:TimeoutSeconds).
/// Igual que PythonPhysicalUnionClient/PythonCheckClient, aplica defensa en profundidad sobre la respuesta de Python:
/// Vectorify.Api nunca confía ciegamente en su caller -- el editor NUNCA debe recibir geometría con NaN, anillos
/// abiertos o piezas que no corresponden al subject, aunque venga de un 200.
/// </summary>
public sealed class PythonGeometryClient : IPythonGeometryClient
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private readonly HttpClient _httpClient;
    private readonly ILogger<PythonGeometryClient> _logger;

    public PythonGeometryClient(HttpClient httpClient, ILogger<PythonGeometryClient> logger)
    {
        _httpClient = httpClient;
        _logger = logger;
    }

    public async Task<PythonGeometryResult> BooleanAsync(GeometryBooleanParameters parameters, CancellationToken cancellationToken = default)
    {
        var requestPayload = new PythonGeometryRequestPayload
        {
            Operation = parameters.Operation.ToWireName(),
            Subjects = [.. parameters.Subjects.Select(ToPayload)],
            Operands = [.. parameters.Operands.Select(ToPayload)],
            Tolerance = parameters.Tolerance,
        };

        var (state, body, message) = await PostAsync("/api/v1/geometry/boolean", JsonSerializer.Serialize(requestPayload), "la operación de geometría", cancellationToken);
        if (state != PythonGeometryState.Success)
        {
            return Failure(state, message!);
        }

        PythonGeometryPayload? payload;
        try
        {
            payload = JsonSerializer.Deserialize<PythonGeometryPayload>(body!, JsonOptions);
        }
        catch (JsonException ex)
        {
            _logger.LogWarning(ex, "Respuesta no-JSON del motor Python en la operación de geometría");
            return Failure(PythonGeometryState.InvalidResponse, "La respuesta del motor Python no es un JSON válido.");
        }

        if (payload?.Results is null || payload.Operation is null || payload.Scope is null)
        {
            _logger.LogWarning("Respuesta incompleta del motor Python en la operación de geometría");
            return Failure(PythonGeometryState.InvalidResponse, "La respuesta del motor Python no contiene los campos esperados.");
        }

        if (!TryValidate(parameters, payload, out var reason, out var mapped))
        {
            _logger.LogWarning("Respuesta de geometría rechazada por la validación defensiva adicional: {Reason}", reason);
            return Failure(PythonGeometryState.InvalidResponse, reason!);
        }

        return new PythonGeometryResult(PythonGeometryState.Success, mapped, Message: null);
    }

    public async Task<PythonGeometryOffsetResult> OffsetAsync(GeometryOffsetParameters parameters, CancellationToken cancellationToken = default)
    {
        var requestPayload = new PythonGeometryOffsetRequestPayload
        {
            Subjects = [.. parameters.Subjects.Select(ToPayload)],
            Distance = parameters.Distance,
            JoinStyle = parameters.JoinStyle.ToWireName(),
            MitreLimit = parameters.MitreLimit,
            CapStyle = parameters.CapStyle.ToWireName(),
            Tolerance = parameters.Tolerance,
        };

        var (state, body, message) = await PostAsync("/api/v1/geometry/offset", JsonSerializer.Serialize(requestPayload), "el offset de geometría", cancellationToken);
        if (state != PythonGeometryState.Success)
        {
            return new PythonGeometryOffsetResult(state, null, message);
        }

        PythonGeometryOffsetPayload? payload;
        try
        {
            payload = JsonSerializer.Deserialize<PythonGeometryOffsetPayload>(body!, JsonOptions);
        }
        catch (JsonException ex)
        {
            _logger.LogWarning(ex, "Respuesta no-JSON del motor Python en el offset de geometría");
            return new PythonGeometryOffsetResult(PythonGeometryState.InvalidResponse, null, "La respuesta del motor Python no es un JSON válido.");
        }

        if (payload?.Results is null || payload.JoinStyle is null || payload.CapStyle is null)
        {
            _logger.LogWarning("Respuesta incompleta del motor Python en el offset de geometría");
            return new PythonGeometryOffsetResult(PythonGeometryState.InvalidResponse, null, "La respuesta del motor Python no contiene los campos esperados.");
        }

        if (!TryValidateOffset(parameters, payload, out var reason, out var mapped))
        {
            _logger.LogWarning("Respuesta de offset rechazada por la validación defensiva adicional: {Reason}", reason);
            return new PythonGeometryOffsetResult(PythonGeometryState.InvalidResponse, null, reason);
        }

        return new PythonGeometryOffsetResult(PythonGeometryState.Success, mapped, Message: null);
    }

    public async Task<PythonGeometrySplitResult> SplitAsync(GeometrySplitParameters parameters, CancellationToken cancellationToken = default)
    {
        var requestPayload = new PythonGeometrySplitRequestPayload
        {
            Subjects = [.. parameters.Subjects.Select(ToPayload)],
            Cutter = new PythonGeometryCutterPayload { Points = parameters.CutterPoints },
            Mode = parameters.Mode.ToWireName(),
            SlotWidth = parameters.SlotWidth,
            Extend = parameters.Extend,
            Tolerance = parameters.Tolerance,
        };

        var (state, body, message) = await PostAsync("/api/v1/geometry/split", JsonSerializer.Serialize(requestPayload), "el corte de geometría", cancellationToken);
        if (state != PythonGeometryState.Success)
        {
            return new PythonGeometrySplitResult(state, null, message);
        }

        PythonGeometrySplitPayload? payload;
        try
        {
            payload = JsonSerializer.Deserialize<PythonGeometrySplitPayload>(body!, JsonOptions);
        }
        catch (JsonException ex)
        {
            _logger.LogWarning(ex, "Respuesta no-JSON del motor Python en el corte de geometría");
            return new PythonGeometrySplitResult(PythonGeometryState.InvalidResponse, null, "La respuesta del motor Python no es un JSON válido.");
        }

        if (payload?.Results is null || payload.Mode is null)
        {
            _logger.LogWarning("Respuesta incompleta del motor Python en el corte de geometría");
            return new PythonGeometrySplitResult(PythonGeometryState.InvalidResponse, null, "La respuesta del motor Python no contiene los campos esperados.");
        }

        if (!TryValidateSplit(parameters, payload, out var reason, out var mapped))
        {
            _logger.LogWarning("Respuesta de corte rechazada por la validación defensiva adicional: {Reason}", reason);
            return new PythonGeometrySplitResult(PythonGeometryState.InvalidResponse, null, reason);
        }

        return new PythonGeometrySplitResult(PythonGeometryState.Success, mapped, Message: null);
    }

    public async Task<PythonGeometryFloatingResult> FloatingAsync(GeometryFloatingParameters parameters, CancellationToken cancellationToken = default)
    {
        var requestPayload = new PythonGeometryFloatingRequestPayload
        {
            Subjects = [.. parameters.Subjects.Select(ToPayload)],
            Mode = parameters.Mode.ToWireName(),
            Tolerance = parameters.Tolerance,
        };

        var (state, body, message) = await PostAsync("/api/v1/geometry/floating", JsonSerializer.Serialize(requestPayload), "el análisis de piezas flotantes", cancellationToken);
        if (state != PythonGeometryState.Success)
        {
            return new PythonGeometryFloatingResult(state, null, message);
        }

        PythonGeometryFloatingPayload? payload;
        try
        {
            payload = JsonSerializer.Deserialize<PythonGeometryFloatingPayload>(body!, JsonOptions);
        }
        catch (JsonException ex)
        {
            _logger.LogWarning(ex, "Respuesta no-JSON del motor Python en el análisis de piezas flotantes");
            return new PythonGeometryFloatingResult(PythonGeometryState.InvalidResponse, null, "La respuesta del motor Python no es un JSON válido.");
        }

        if (payload?.Components is null || payload.Mode is null)
        {
            _logger.LogWarning("Respuesta incompleta del motor Python en el análisis de piezas flotantes");
            return new PythonGeometryFloatingResult(PythonGeometryState.InvalidResponse, null, "La respuesta del motor Python no contiene los campos esperados.");
        }

        if (!TryValidateFloating(parameters, payload, out var reason, out var mapped))
        {
            _logger.LogWarning("Respuesta de piezas flotantes rechazada por la validación defensiva adicional: {Reason}", reason);
            return new PythonGeometryFloatingResult(PythonGeometryState.InvalidResponse, null, reason);
        }

        return new PythonGeometryFloatingResult(PythonGeometryState.Success, mapped, Message: null);
    }

    public async Task<PythonGeometryBridgeResult> BridgeAsync(GeometryBridgeParameters parameters, CancellationToken cancellationToken = default)
    {
        var requestPayload = new PythonGeometryBridgeRequestPayload
        {
            Subjects = [.. parameters.Subjects.Select(ToPayload)],
            Mode = parameters.Mode.ToWireName(),
            Bridges = [.. parameters.Bridges.Select(ToPayload)],
            Suggest = parameters.Suggest,
            SuggestWidth = parameters.SuggestWidth,
            Tolerance = parameters.Tolerance,
        };

        var (state, body, message) = await PostAsync("/api/v1/geometry/bridge", JsonSerializer.Serialize(requestPayload), "el cálculo de bridges", cancellationToken);
        if (state != PythonGeometryState.Success)
        {
            return new PythonGeometryBridgeResult(state, null, message);
        }

        PythonGeometryBridgePayload? payload;
        try
        {
            payload = JsonSerializer.Deserialize<PythonGeometryBridgePayload>(body!, JsonOptions);
        }
        catch (JsonException ex)
        {
            _logger.LogWarning(ex, "Respuesta no-JSON del motor Python en el cálculo de bridges");
            return new PythonGeometryBridgeResult(PythonGeometryState.InvalidResponse, null, "La respuesta del motor Python no es un JSON válido.");
        }

        if (payload?.Bridges is null || payload.Results is null || payload.Reanalysis is null || payload.Mode is null)
        {
            _logger.LogWarning("Respuesta incompleta del motor Python en el cálculo de bridges");
            return new PythonGeometryBridgeResult(PythonGeometryState.InvalidResponse, null, "La respuesta del motor Python no contiene los campos esperados.");
        }

        if (!TryValidateBridge(parameters, payload, out var reason, out var mapped))
        {
            _logger.LogWarning("Respuesta de bridges rechazada por la validación defensiva adicional: {Reason}", reason);
            return new PythonGeometryBridgeResult(PythonGeometryState.InvalidResponse, null, reason);
        }

        return new PythonGeometryBridgeResult(PythonGeometryState.Success, mapped, Message: null);
    }

    /// <summary>
    /// POST JSON al motor Python con el manejo común de fallas: devuelve el cuerpo de un 2xx, o el estado tipado (timeout, sin
    /// conexión, error HTTP mapeado) con su mensaje. Nunca lanza.
    /// </summary>
    private async Task<(PythonGeometryState State, string? Body, string? Message)> PostAsync(
        string path, string json, string operationName, CancellationToken cancellationToken)
    {
        using var content = new StringContent(json, Encoding.UTF8, "application/json");

        HttpResponseMessage response;
        try
        {
            response = await _httpClient.PostAsync(path, content, cancellationToken);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            _logger.LogWarning("Timeout en {Operation} contra el motor Python en {BaseAddress}", operationName, _httpClient.BaseAddress);
            return (PythonGeometryState.Timeout, null, $"Tiempo de espera agotado en {operationName}.");
        }
        catch (HttpRequestException ex)
        {
            _logger.LogWarning(ex, "Motor Python no disponible en {BaseAddress}", _httpClient.BaseAddress);
            return (PythonGeometryState.Unavailable, null, "No se pudo establecer conexión con el motor Python.");
        }

        using (response)
        {
            string body;
            try
            {
                body = await response.Content.ReadAsStringAsync(cancellationToken);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                return (PythonGeometryState.Timeout, null, "Tiempo de espera agotado al leer la respuesta del motor Python.");
            }

            if (!response.IsSuccessStatusCode)
            {
                var (state, message) = MapErrorResponse(response.StatusCode, body);
                return (state, null, message);
            }

            return (PythonGeometryState.Success, body, null);
        }
    }

    private static PythonFloatingSubjectPayload ToPayload(GeometryFloatingSubject subject) =>
        new() { Type = "polygon", Coordinates = subject.Rings, Locked = subject.Locked };

    private static PythonBridgeInputPayload ToPayload(GeometryBridgeSpec bridge) => new()
    {
        Island = bridge.Island,
        Anchor = bridge.Anchor is null ? null : new PythonBridgePointPayload { X = bridge.Anchor[0], Y = bridge.Anchor[1] },
        Direction = bridge.Direction is null ? null : new PythonBridgePointPayload { X = bridge.Direction[0], Y = bridge.Direction[1] },
        Width = bridge.Width,
        Length = bridge.Length,
    };

    private static PythonGeometryShapePayload ToPayload(GeometryShape shape) => shape switch
    {
        GeometryShape.Polygon polygon => new PythonGeometryShapePayload { Type = "polygon", Coordinates = polygon.Rings },
        GeometryShape.Line line => new PythonGeometryShapePayload { Type = "line", Coordinates = line.Points },
        GeometryShape.BufferedLine brush => new PythonGeometryShapePayload { Type = "bufferedLine", Points = brush.Points, Radius = brush.Radius },
        _ => throw new InvalidOperationException($"Forma no reconocida: {shape.GetType()}"),
    };

    /// <summary>
    /// Verifica que la respuesta sea coherente con LA petición: misma operación, alcance correcto (per_subject/combined),
    /// una entrada por subject en orden, piezas del tipo del subject, anillos cerrados y coordenadas finitas, y el
    /// conteo de piezas declarado. Devuelve la respuesta ya tipada para el cliente.
    /// </summary>
    private static bool TryValidate(
        GeometryBooleanParameters parameters, PythonGeometryPayload payload, out string? reason, out GeometryBooleanResponse? response)
    {
        response = null;
        var expectedOperation = parameters.Operation.ToWireName();
        if (!string.Equals(payload.Operation, expectedOperation, StringComparison.Ordinal))
        {
            reason = $"El motor Python respondió la operación '{payload.Operation}' en vez de '{expectedOperation}'.";
            return false;
        }

        var perSubject = parameters.Operation is GeometryOperation.Difference or GeometryOperation.Intersection or GeometryOperation.Normalize;
        var expectedScope = perSubject ? "per_subject" : "combined";
        if (!string.Equals(payload.Scope, expectedScope, StringComparison.Ordinal))
        {
            reason = $"El alcance devuelto ('{payload.Scope}') no corresponde a la operación {expectedOperation} ('{expectedScope}').";
            return false;
        }

        var expectedResults = perSubject ? parameters.Subjects.Count : 1;
        if (payload.Results!.Count != expectedResults)
        {
            reason = $"El motor Python devolvió {payload.Results.Count} resultados; se esperaban {expectedResults}.";
            return false;
        }

        var mappedResults = new List<GeometryResultPayload>(expectedResults);
        var pieceCount = 0;
        for (var index = 0; index < payload.Results.Count; index++)
        {
            var item = payload.Results[index];
            if (item.Geometries is null)
            {
                reason = "Un resultado del motor Python no trae la lista de geometrías.";
                return false;
            }

            if (item.SubjectIndex != (perSubject ? index : (int?)null))
            {
                reason = $"El resultado {index} trae subject_index {item.SubjectIndex?.ToString() ?? "null"}, que no corresponde a su posición.";
                return false;
            }

            var mappedPieces = new List<GeometryPiecePayload>(item.Geometries.Count);
            foreach (var piece in item.Geometries)
            {
                // Un subject-línea solo puede dar líneas y un subject-polígono solo polígonos (difference/intersection/normalize).
                var allowed = perSubject ? (parameters.Subjects[index] is GeometryShape.Line ? "line" : "polygon") : null;
                if (!TryValidatePiece(piece, allowed, out reason))
                {
                    return false;
                }

                mappedPieces.Add(new GeometryPiecePayload(piece.Type!, piece.Coordinates!.Value));
            }

            pieceCount += mappedPieces.Count;
            mappedResults.Add(new GeometryResultPayload(item.SubjectIndex, item.Changed, mappedPieces));
        }

        if (payload.PieceCount != pieceCount)
        {
            reason = $"piece_count ({payload.PieceCount}) no coincide con la cantidad real de piezas ({pieceCount}).";
            return false;
        }

        if (!double.IsFinite(payload.Tolerance) || payload.Tolerance <= 0)
        {
            reason = "La tolerancia devuelta por el motor Python no es un número finito mayor que 0.";
            return false;
        }

        reason = null;
        response = new GeometryBooleanResponse(payload.Operation!, payload.Scope!, payload.Tolerance, mappedResults, pieceCount);
        return true;
    }

    /// <summary>
    /// Verifica que la respuesta del offset sea coherente con LA petición (M3-S09): los parámetros que Python dice haber usado son los
    /// pedidos, una entrada por subject en orden, SOLO polígonos con anillos cerrados y coordenadas finitas, y los datos que el cliente
    /// muestra al usuario (colapso, piezas, huecos, offset interior máximo) coherentes entre sí y con la geometría devuelta: un
    /// `collapsed` que no coincide con las piezas, o un conteo de huecos inventado, harían que el editor mintiera.
    /// </summary>
    private static bool TryValidateOffset(
        GeometryOffsetParameters parameters, PythonGeometryOffsetPayload payload, out string? reason, out GeometryOffsetResponse? response)
    {
        response = null;
        if (payload.Distance != parameters.Distance)
        {
            reason = $"El motor Python respondió la distancia {payload.Distance} en vez de {parameters.Distance}.";
            return false;
        }

        if (!string.Equals(payload.JoinStyle, parameters.JoinStyle.ToWireName(), StringComparison.Ordinal)
            || !string.Equals(payload.CapStyle, parameters.CapStyle.ToWireName(), StringComparison.Ordinal)
            || payload.MitreLimit != parameters.MitreLimit)
        {
            reason = "El motor Python respondió joins/caps/límite de inglete distintos de los pedidos.";
            return false;
        }

        if (!double.IsFinite(payload.Tolerance) || payload.Tolerance <= 0)
        {
            reason = "La tolerancia devuelta por el motor Python no es un número finito mayor que 0.";
            return false;
        }

        if (payload.Results!.Count != parameters.Subjects.Count)
        {
            reason = $"El motor Python devolvió {payload.Results.Count} resultados; se esperaban {parameters.Subjects.Count}.";
            return false;
        }

        var mappedResults = new List<GeometryOffsetResultPayload>(payload.Results.Count);
        var pieceCount = 0;
        for (var index = 0; index < payload.Results.Count; index++)
        {
            var item = payload.Results[index];
            if (item.Geometries is null)
            {
                reason = "Un resultado del motor Python no trae la lista de geometrías.";
                return false;
            }

            if (item.SubjectIndex != index)
            {
                reason = $"El resultado {index} trae subject_index {item.SubjectIndex}, que no corresponde a su posición.";
                return false;
            }

            var mappedPieces = new List<GeometryPiecePayload>(item.Geometries.Count);
            var holes = 0;
            foreach (var piece in item.Geometries)
            {
                // El offset de un polígono o de una línea siempre es un polígono.
                if (!TryValidatePiece(piece, "polygon", out reason))
                {
                    return false;
                }

                holes += piece.Coordinates!.Value.GetArrayLength() - 1;
                mappedPieces.Add(new GeometryPiecePayload(piece.Type!, piece.Coordinates!.Value));
            }

            var isLine = parameters.Subjects[index] is GeometryShape.Line;
            if (item.Collapsed != (mappedPieces.Count == 0) || item.SplitCount != mappedPieces.Count)
            {
                reason = $"El resultado {index} declara collapsed={item.Collapsed} y split_count={item.SplitCount} pero trae {mappedPieces.Count} piezas.";
                return false;
            }

            if (item.PiecesBefore < 0 || item.LostPieces < 0 || item.LostPieces > item.PiecesBefore || item.HolesBefore < 0
                || (isLine && (item.PiecesBefore > 1 || item.LostPieces != 0 || item.HolesBefore != 0)))
            {
                reason = $"El resultado {index} trae conteos de piezas o huecos incoherentes (pieces_before, lost_pieces, holes_before).";
                return false;
            }

            if (item.HolesAfter != holes)
            {
                reason = $"El resultado {index} declara holes_after={item.HolesAfter} pero sus piezas tienen {holes} huecos.";
                return false;
            }

            // Una línea no tiene interior (max_inward_offset nulo); un polígono siempre informa un número finito >= 0.
            var maxInward = item.MaxInwardOffset;
            if (isLine ? maxInward is not null : maxInward is null || !double.IsFinite(maxInward.Value) || maxInward.Value < 0)
            {
                reason = $"El resultado {index} trae un max_inward_offset que no corresponde a {(isLine ? "una línea" : "un polígono")}.";
                return false;
            }

            pieceCount += mappedPieces.Count;
            mappedResults.Add(new GeometryOffsetResultPayload(
                item.SubjectIndex, mappedPieces, item.Collapsed, item.PiecesBefore, item.SplitCount, item.LostPieces, item.HolesBefore, item.HolesAfter, maxInward));
        }

        if (payload.PieceCount != pieceCount)
        {
            reason = $"piece_count ({payload.PieceCount}) no coincide con la cantidad real de piezas ({pieceCount}).";
            return false;
        }

        reason = null;
        response = new GeometryOffsetResponse(
            payload.Distance, payload.JoinStyle!, payload.MitreLimit, payload.CapStyle!, payload.Tolerance, mappedResults, pieceCount);
        return true;
    }

    /// <summary>
    /// Verifica que la respuesta del corte sea coherente con LA petición (M3-S10): los parámetros que Python dice haber usado son los
    /// pedidos, una entrada por subject en orden, piezas del tipo del subject (polígonos para un polígono, polilíneas para una línea) con
    /// anillos cerrados y coordenadas finitas, y los datos que el cliente muestra (tocado, separado, piezas, descartadas) coherentes entre sí:
    /// un `changed` sin tocar, un resultado "separado" con menos de 2 piezas o un `piece_count` inventado harían que el editor mintiera.
    /// </summary>
    private static bool TryValidateSplit(
        GeometrySplitParameters parameters, PythonGeometrySplitPayload payload, out string? reason, out GeometrySplitResponse? response)
    {
        response = null;
        if (!string.Equals(payload.Mode, parameters.Mode.ToWireName(), StringComparison.Ordinal)
            || payload.SlotWidth != parameters.SlotWidth
            || payload.Extend != parameters.Extend)
        {
            reason = "El motor Python respondió modo, ancho de ranura o extensión distintos de los pedidos.";
            return false;
        }

        if (!double.IsFinite(payload.Tolerance) || payload.Tolerance <= 0)
        {
            reason = "La tolerancia devuelta por el motor Python no es un número finito mayor que 0.";
            return false;
        }

        if (payload.Results!.Count != parameters.Subjects.Count)
        {
            reason = $"El motor Python devolvió {payload.Results.Count} resultados; se esperaban {parameters.Subjects.Count}.";
            return false;
        }

        var mappedResults = new List<GeometrySplitResultPayload>(payload.Results.Count);
        var pieceCount = 0;
        for (var index = 0; index < payload.Results.Count; index++)
        {
            var item = payload.Results[index];
            if (item.Pieces is null)
            {
                reason = "Un resultado del motor Python no trae la lista de piezas.";
                return false;
            }

            if (item.SubjectIndex != index)
            {
                reason = $"El resultado {index} trae subject_index {item.SubjectIndex}, que no corresponde a su posición.";
                return false;
            }

            // Un subject-línea solo puede dar líneas y un subject-polígono solo polígonos.
            var allowed = parameters.Subjects[index] is GeometryShape.Line ? "line" : "polygon";
            var mappedPieces = new List<GeometryPiecePayload>(item.Pieces.Count);
            foreach (var piece in item.Pieces)
            {
                if (!TryValidatePiece(piece, allowed, out reason))
                {
                    return false;
                }

                mappedPieces.Add(new GeometryPiecePayload(piece.Type!, piece.Coordinates!.Value));
            }

            if (item.PieceCount != mappedPieces.Count)
            {
                reason = $"El resultado {index} declara piece_count={item.PieceCount} pero trae {mappedPieces.Count} piezas.";
                return false;
            }

            // Cambiar exige haber tocado y haber SEPARADO (>= 2 piezas); lo que no cambió no descartó nada (es el subject tal cual).
            if (item.Changed && (!item.Touched || mappedPieces.Count < 2))
            {
                reason = $"El resultado {index} declara changed=true con touched={item.Touched} y {mappedPieces.Count} piezas.";
                return false;
            }

            if (item.Discarded < 0 || (!item.Changed && item.Discarded != 0))
            {
                reason = $"El resultado {index} trae un conteo de piezas descartadas incoherente ({item.Discarded}).";
                return false;
            }

            pieceCount += mappedPieces.Count;
            mappedResults.Add(new GeometrySplitResultPayload(item.SubjectIndex, item.Changed, item.Touched, mappedPieces, mappedPieces.Count, item.Discarded));
        }

        if (payload.PieceCount != pieceCount)
        {
            reason = $"piece_count ({payload.PieceCount}) no coincide con la cantidad real de piezas ({pieceCount}).";
            return false;
        }

        reason = null;
        response = new GeometrySplitResponse(payload.Mode!, payload.SlotWidth, payload.Extend, payload.Tolerance, mappedResults, pieceCount);
        return true;
    }

    private static readonly HashSet<string> BridgeReasons = new(StringComparer.Ordinal)
    {
        "unknown_island", "anchor_outside", "width_below_tolerance", "invalid_direction", "no_crossing", "too_short", "locked_subject", "no_connection",
    };

    private static bool IsFiniteNumber(double? value) => value is { } number && double.IsFinite(number);

    /// <summary>
    /// Verifica que la respuesta del análisis de piezas flotantes sea coherente con LA petición (M3-S11): el modo pedido, ids = posiciones, un árbol de
    /// contención consistente (cada hijo después de su padre, con un nivel más de profundidad), polígonos cerrados y finitos (la hoja de `stencil` es el
    /// único componente sin polígono), áreas y bounds finitos, formas que existen y los recuentos declarados iguales a lo que trae la lista: un
    /// conteo inventado haría que el editor mintiera sobre cuántas piezas se caen.
    /// </summary>
    private static bool TryValidateFloating(
        GeometryFloatingParameters parameters, PythonGeometryFloatingPayload payload, out string? reason, out GeometryFloatingResponse? response)
    {
        response = null;
        if (!string.Equals(payload.Mode, parameters.Mode.ToWireName(), StringComparison.Ordinal))
        {
            reason = $"El motor Python respondió el modo '{payload.Mode}' en vez de '{parameters.Mode.ToWireName()}'.";
            return false;
        }

        if (!double.IsFinite(payload.Tolerance) || payload.Tolerance <= 0)
        {
            reason = "La tolerancia devuelta por el motor Python no es un número finito mayor que 0.";
            return false;
        }

        var components = payload.Components!;
        var stencil = parameters.Mode == FloatingMode.Stencil;
        var mapped = new List<FloatingComponentPayload>(components.Count);
        var floating = 0;
        var principal = 0;
        for (var index = 0; index < components.Count; index++)
        {
            var component = components[index];
            if (component is null || component.Subjects is null || component.Bounds is null)
            {
                reason = $"El componente {index} del motor Python está incompleto.";
                return false;
            }

            if (component.Id != index)
            {
                reason = $"El componente {index} trae id {component.Id}, que no corresponde a su posición.";
                return false;
            }

            if (component.Kind is not ("principal" or "floating"))
            {
                reason = $"El componente {index} trae un tipo desconocido ('{component.Kind}').";
                return false;
            }

            var isFloating = component.Kind == "floating";
            if (isFloating ? component.Parent is not { } parent || parent < 0 || parent >= index || component.Depth != mapped[parent].Depth + 1 : component.Parent is not null || component.Depth != 0)
            {
                reason = $"El componente {index} declara un padre o una profundidad incoherentes con el árbol de contención.";
                return false;
            }

            var withoutPolygon = stencil && !isFloating;
            if (withoutPolygon)
            {
                if (component.Polygon is not null || component.Area is not null || index != 0)
                {
                    reason = "La hoja de la plantilla no puede traer polígono ni área, y es el componente 0.";
                    return false;
                }
            }
            else
            {
                if (component.Polygon is null)
                {
                    reason = $"El componente {index} no trae un polígono.";
                    return false;
                }

                if (!TryValidatePiece(component.Polygon, "polygon", out reason))
                {
                    return false;
                }

                if (!IsFiniteNumber(component.Area) || component.Area <= 0)
                {
                    reason = $"El componente {index} trae un área que no es un número finito mayor que 0.";
                    return false;
                }
            }

            if (component.Bounds.Count != 4 || component.Bounds.Any(value => !double.IsFinite(value)) || component.Bounds[0] > component.Bounds[2] || component.Bounds[1] > component.Bounds[3])
            {
                reason = $"El componente {index} trae bounds inválidos.";
                return false;
            }

            for (var position = 0; position < component.Subjects.Count; position++)
            {
                var subject = component.Subjects[position];
                if (subject < 0 || subject >= parameters.Subjects.Count || (position > 0 && subject <= component.Subjects[position - 1]))
                {
                    reason = $"El componente {index} referencia formas inexistentes o repetidas.";
                    return false;
                }
            }

            if (isFloating)
            {
                floating++;
            }
            else
            {
                principal++;
            }

            mapped.Add(new FloatingComponentPayload(
                component.Id,
                component.Kind,
                component.Depth,
                component.Parent,
                component.Polygon is null ? null : new GeometryPiecePayload(component.Polygon.Type!, component.Polygon.Coordinates!.Value),
                component.Area,
                [.. component.Bounds],
                [.. component.Subjects]));
        }

        if (payload.FloatingCount != floating || payload.MainCount != principal || (stencil && principal > 1) || payload.Discarded < 0)
        {
            reason = $"Los recuentos declarados (floating_count {payload.FloatingCount}, main_count {payload.MainCount}) no coinciden con los componentes ({floating} flotantes, {principal} principales).";
            return false;
        }

        reason = null;
        response = new GeometryFloatingResponse(payload.Mode!, payload.Tolerance, mapped, floating, principal, payload.Discarded);
        return true;
    }

    private static bool TryReadBridgePoint(PythonBridgePointPayload? point, bool unit, out BridgePointPayload? mapped)
    {
        mapped = null;
        if (point is null)
        {
            return true;
        }

        if (!double.IsFinite(point.X) || !double.IsFinite(point.Y) || (unit && Math.Abs(Math.Sqrt((point.X * point.X) + (point.Y * point.Y)) - 1) > 1e-6))
        {
            return false;
        }

        mapped = new BridgePointPayload(point.X, point.Y);
        return true;
    }

    /// <summary>
    /// Verifica que la respuesta de los bridges sea coherente con LA petición (M3-S11): un resultado por bridge pedido (en orden, con el ancho pedido) y,
    /// solo si se pidió `suggest`, los sugeridos después (con el ancho sugerido); motivos conocidos; un bridge válido con isla, ancla, dirección unitaria,
    /// rectángulo, largo y área finitos y sin tocar una forma bloqueada; la geometría resultante de cada forma (una entrada por forma en orden, `changed`
    /// solo si algún bridge válido la modifica, sin geometría si no cambió) y el reanálisis sin más flotantes que antes. Nada de esto se acepta a ciegas:
    /// el editor aplica esta geometría a los objetos del usuario.
    /// </summary>
    private static bool TryValidateBridge(
        GeometryBridgeParameters parameters, PythonGeometryBridgePayload payload, out string? reason, out GeometryBridgeResponse? response)
    {
        response = null;
        if (!string.Equals(payload.Mode, parameters.Mode.ToWireName(), StringComparison.Ordinal))
        {
            reason = $"El motor Python respondió el modo '{payload.Mode}' en vez de '{parameters.Mode.ToWireName()}'.";
            return false;
        }

        if (!double.IsFinite(payload.Tolerance) || payload.Tolerance <= 0)
        {
            reason = "La tolerancia devuelta por el motor Python no es un número finito mayor que 0.";
            return false;
        }

        var requested = parameters.Bridges.Count;
        var bridges = payload.Bridges!;
        if (bridges.Count < requested || (!parameters.Suggest && bridges.Count != requested))
        {
            reason = $"El motor Python devolvió {bridges.Count} bridges; se pidieron {requested}{(parameters.Suggest ? " (más los sugeridos)" : string.Empty)}.";
            return false;
        }

        var affected = new HashSet<int>();
        var mappedBridges = new List<BridgeResultPayload>(bridges.Count);
        for (var index = 0; index < bridges.Count; index++)
        {
            var bridge = bridges[index];
            if (bridge is null || bridge.Affects is null)
            {
                reason = $"El bridge {index} del motor Python está incompleto.";
                return false;
            }

            var expectedWidth = index < requested ? parameters.Bridges[index].Width : parameters.SuggestWidth;
            if (bridge.Index != index || bridge.Suggested != (index >= requested) || expectedWidth is null || bridge.Width != expectedWidth)
            {
                reason = $"El bridge {index} no corresponde a su posición, o trae un ancho distinto del pedido.";
                return false;
            }

            if (!TryReadBridgePoint(bridge.Anchor, unit: false, out var anchor) || !TryReadBridgePoint(bridge.Direction, unit: true, out var direction))
            {
                reason = $"El bridge {index} trae un ancla o una dirección no válidas (NaN/Infinity o dirección no unitaria).";
                return false;
            }

            if (bridge.Length is not null && (!double.IsFinite(bridge.Length.Value) || bridge.Length < 0)
                || bridge.Area is not null && (!double.IsFinite(bridge.Area.Value) || bridge.Area < 0))
            {
                reason = $"El bridge {index} trae un largo o un área que no son números finitos no negativos.";
                return false;
            }

            if (bridge.Polygon is not null)
            {
                if (!TryValidatePiece(bridge.Polygon, "polygon", out reason))
                {
                    return false;
                }

                if (bridge.Polygon.Coordinates!.Value.GetArrayLength() != 1)
                {
                    reason = $"El rectángulo del bridge {index} debe tener un solo anillo.";
                    return false;
                }
            }

            if (bridge.Valid)
            {
                var lockedTouched = bridge.Affects.Any(subject => subject < 0 || subject >= parameters.Subjects.Count || parameters.Subjects[subject].Locked);
                if (bridge.Reason is not null || bridge.Island is not { } island || island < 0 || anchor is null || direction is null || bridge.Polygon is null
                    || bridge.Length is not > 0 || bridge.Area is not > 0 || bridge.Affects.Count == 0 || lockedTouched)
                {
                    reason = $"El bridge {index} figura como válido pero le faltan datos, o modifica una forma bloqueada o inexistente.";
                    return false;
                }

                affected.UnionWith(bridge.Affects);
            }
            else if (bridge.Reason is null || !BridgeReasons.Contains(bridge.Reason) || bridge.Reduces)
            {
                reason = $"El bridge {index} figura como inválido sin un motivo conocido, o como inválido que reduce.";
                return false;
            }

            if (bridge.Island is < 0)
            {
                reason = $"El bridge {index} trae una isla negativa.";
                return false;
            }

            mappedBridges.Add(new BridgeResultPayload(
                bridge.Index, bridge.Suggested, bridge.Valid, bridge.Reason, bridge.Island, anchor, direction, bridge.Width, bridge.Length, bridge.Area, bridge.Reduces,
                [.. bridge.Affects],
                bridge.Polygon is null ? null : new GeometryPiecePayload(bridge.Polygon.Type!, bridge.Polygon.Coordinates!.Value)));
        }

        var results = payload.Results!;
        if (results.Count != parameters.Subjects.Count)
        {
            reason = $"El motor Python devolvió {results.Count} resultados; se esperaban {parameters.Subjects.Count}.";
            return false;
        }

        var mappedResults = new List<BridgeSubjectResultPayload>(results.Count);
        var pieceCount = 0;
        for (var index = 0; index < results.Count; index++)
        {
            var item = results[index];
            if (item is null || item.Geometries is null)
            {
                reason = "Un resultado del motor Python no trae la lista de geometrías.";
                return false;
            }

            if (item.SubjectIndex != index)
            {
                reason = $"El resultado {index} trae subject_index {item.SubjectIndex}, que no corresponde a su posición.";
                return false;
            }

            if (item.Changed != affected.Contains(index) || (!item.Changed && item.Geometries.Count > 0) || (item.Changed && parameters.Subjects[index].Locked))
            {
                reason = $"El resultado {index} declara changed={item.Changed}, que no coincide con los bridges válidos que lo modifican, o modifica una forma bloqueada.";
                return false;
            }

            var mappedPieces = new List<GeometryPiecePayload>(item.Geometries.Count);
            foreach (var piece in item.Geometries)
            {
                if (!TryValidatePiece(piece, "polygon", out reason))
                {
                    return false;
                }

                mappedPieces.Add(new GeometryPiecePayload(piece.Type!, piece.Coordinates!.Value));
            }

            pieceCount += mappedPieces.Count;
            mappedResults.Add(new BridgeSubjectResultPayload(item.SubjectIndex, item.Changed, mappedPieces));
        }

        var reanalysis = payload.Reanalysis!;
        if (reanalysis.FloatingBefore < 0 || reanalysis.FloatingAfter < 0 || reanalysis.MainAfter < 0 || reanalysis.FloatingAfter > reanalysis.FloatingBefore
            || (affected.Count == 0 && reanalysis.FloatingAfter != reanalysis.FloatingBefore))
        {
            reason = $"El reanálisis ({reanalysis.FloatingBefore} -> {reanalysis.FloatingAfter} flotantes) es incoherente con los bridges válidos.";
            return false;
        }

        if (payload.PieceCount != pieceCount)
        {
            reason = $"piece_count ({payload.PieceCount}) no coincide con la cantidad real de piezas ({pieceCount}).";
            return false;
        }

        reason = null;
        response = new GeometryBridgeResponse(
            payload.Mode!, payload.Tolerance, mappedBridges, mappedResults,
            new BridgeReanalysisPayload(reanalysis.FloatingBefore, reanalysis.FloatingAfter, reanalysis.MainAfter), pieceCount);
        return true;
    }

    private static bool TryValidatePiece(PythonGeometryPiecePayload piece, string? allowedType, out string? reason)
    {
        if (piece.Type is not ("polygon" or "line") || piece.Coordinates is not { } coordinates || coordinates.ValueKind != JsonValueKind.Array)
        {
            reason = "Una pieza del motor Python no tiene un tipo (polygon/line) y coordenadas válidos.";
            return false;
        }

        if (allowedType is not null && piece.Type != allowedType)
        {
            reason = $"El motor Python devolvió una pieza '{piece.Type}' para un subject que solo admite '{allowedType}'.";
            return false;
        }

        if (piece.Type == "line")
        {
            return TryValidateVertices(coordinates, minimum: 2, requireClosed: false, out reason);
        }

        var rings = 0;
        foreach (var ring in coordinates.EnumerateArray())
        {
            rings++;
            // Un anillo cerrado repite su primer vértice: 3 vértices distintos + el cierre.
            if (!TryValidateVertices(ring, minimum: 4, requireClosed: true, out reason))
            {
                return false;
            }
        }

        if (rings == 0)
        {
            reason = "Un polígono del motor Python no tiene anillos.";
            return false;
        }

        reason = null;
        return true;
    }

    private static bool TryValidateVertices(JsonElement vertices, int minimum, bool requireClosed, out string? reason)
    {
        if (vertices.ValueKind != JsonValueKind.Array || vertices.GetArrayLength() < minimum)
        {
            reason = $"Una pieza del motor Python tiene menos de {minimum} vértices.";
            return false;
        }

        double firstX = 0, firstY = 0, lastX = 0, lastY = 0;
        var count = 0;
        foreach (var vertex in vertices.EnumerateArray())
        {
            if (vertex.ValueKind != JsonValueKind.Array || vertex.GetArrayLength() != 2)
            {
                reason = "Un vértice del motor Python no es [x, y].";
                return false;
            }

            var x = vertex[0];
            var y = vertex[1];
            if (x.ValueKind != JsonValueKind.Number || y.ValueKind != JsonValueKind.Number
                || !x.TryGetDouble(out var xv) || !y.TryGetDouble(out var yv) || !double.IsFinite(xv) || !double.IsFinite(yv))
            {
                reason = "Un vértice del motor Python contiene valores no finitos (NaN/Infinity).";
                return false;
            }

            if (count == 0)
            {
                firstX = xv;
                firstY = yv;
            }

            lastX = xv;
            lastY = yv;
            count++;
        }

        if (requireClosed && (firstX != lastX || firstY != lastY))
        {
            reason = "Un anillo del motor Python no está cerrado (el primer y el último vértice difieren).";
            return false;
        }

        reason = null;
        return true;
    }

    private (PythonGeometryState State, string Message) MapErrorResponse(System.Net.HttpStatusCode statusCode, string body)
    {
        PythonErrorPayload? errorPayload;
        try
        {
            errorPayload = JsonSerializer.Deserialize<PythonErrorPayload>(body, JsonOptions);
        }
        catch (JsonException)
        {
            errorPayload = null;
        }

        var state = (errorPayload?.Code, (int)statusCode) switch
        {
            ("invalid_parameters", _) => PythonGeometryState.InvalidParameters,
            ("too_many_geometry_subjects", _) => PythonGeometryState.InvalidParameters,
            ("too_many_geometry_vertices", _) => PythonGeometryState.InvalidParameters,
            ("geometry_request_too_large", _) => PythonGeometryState.TooLarge,
            ("geometry_timeout", _) => PythonGeometryState.Timeout,
            ("geometry_result_invalid", _) => PythonGeometryState.EngineError,
            (_, 413) => PythonGeometryState.TooLarge,
            (_, 422) => PythonGeometryState.InvalidParameters,
            (_, 504) => PythonGeometryState.Timeout,
            _ => PythonGeometryState.EngineError,
        };

        var message = errorPayload?.Message ?? $"El motor Python respondió con código HTTP {(int)statusCode}.";

        if (state == PythonGeometryState.EngineError)
        {
            _logger.LogWarning("El motor Python respondió con código {StatusCode} en la operación de geometría", (int)statusCode);
        }

        return (state, message);
    }

    private static PythonGeometryResult Failure(PythonGeometryState state, string message) => new(state, null, message);
}

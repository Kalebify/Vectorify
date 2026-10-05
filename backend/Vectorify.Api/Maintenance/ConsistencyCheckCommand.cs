using System.Globalization;
using Microsoft.Extensions.Options;
using Vectorify.Api.Data;
using Vectorify.Api.Options;

namespace Vectorify.Api.Maintenance;

/// <summary>
/// Comando de línea de comandos del verificador de consistencia DB&lt;-&gt;storage (M2.2-S10):
/// <c>dotnet Vectorify.Api.dll --check-consistency [--verify-checksums] [--delete-orphan-files]
/// [--orphan-min-age-minutes=N]</c>. Es un modo del propio ejecutable, NO un endpoint HTTP: no expone nada en
/// ningún entorno (hace falta shell en el contenedor, p. ej. <c>docker compose exec backend ...</c>, ver
/// <c>scripts/check-consistency.*</c>). Imprime un reporte legible y termina el proceso sin levantar el servidor
/// web. Solo lectura salvo <c>--delete-orphan-files</c>, que borra archivos sin fila de Asset (nunca filas).
/// Códigos de salida: 0 consistente, 1 hay inconsistencias, 2 no se pudo verificar (base no disponible, etc.).
/// </summary>
public static class ConsistencyCheckCommand
{
    public const string Flag = "--check-consistency";

    public static bool IsRequested(string[] args) => args.Contains(Flag, StringComparer.OrdinalIgnoreCase);

    public static async Task<int> RunAsync(IServiceProvider services, string[] args, TextWriter output)
    {
        var postgresOptions = services.GetRequiredService<IOptions<PostgresOptions>>().Value;
        if (string.IsNullOrWhiteSpace(postgresOptions.ConnectionString))
        {
            await output.WriteLineAsync("ERROR: Postgres:ConnectionString no está configurado; no se puede verificar la consistencia.");
            return 2;
        }

        var options = ParseOptions(args);
        try
        {
            await using var scope = services.CreateAsyncScope();
            var checker = ActivatorUtilities.CreateInstance<StorageConsistencyChecker>(scope.ServiceProvider);
            var (report, deletedOrphans) = await checker.CheckAsync(options, CancellationToken.None);

            await WriteReportAsync(output, report, options, deletedOrphans);
            return report.IsConsistent ? 0 : 1;
        }
        catch (Exception ex)
        {
            // Sin stack ni connection string: solo el tipo y el mensaje de la causa (Npgsql ya omite credenciales).
            await output.WriteLineAsync(
                $"ERROR: no se pudo completar la verificación ({DatabaseConnectionDescriber.Describe(postgresOptions.ConnectionString)}): {ex.GetType().Name}: {ex.Message}");
            return 2;
        }
    }

    public static ConsistencyCheckOptions ParseOptions(string[] args)
    {
        var minAge = ConsistencyCheckOptions.DefaultOrphanMinAge;
        foreach (var arg in args)
        {
            const string prefix = "--orphan-min-age-minutes=";
            if (arg.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)
                && double.TryParse(arg[prefix.Length..], NumberStyles.Float, CultureInfo.InvariantCulture, out var minutes)
                && minutes >= 0)
            {
                minAge = TimeSpan.FromMinutes(minutes);
            }
        }

        return new ConsistencyCheckOptions(
            VerifyChecksums: args.Contains("--verify-checksums", StringComparer.OrdinalIgnoreCase),
            DeleteOrphanFiles: args.Contains("--delete-orphan-files", StringComparer.OrdinalIgnoreCase),
            OrphanMinAge: minAge);
    }

    private static async Task WriteReportAsync(
        TextWriter output, ConsistencyReport report, ConsistencyCheckOptions options, IReadOnlyList<string> deletedOrphans)
    {
        await output.WriteLineAsync("Verificación de consistencia DB <-> storage");
        await output.WriteLineAsync($"  Filas de assets en la base      : {report.AssetRows}");
        await output.WriteLineAsync(report.InventorySupported
            ? $"  Archivos de assets en el storage: {report.AssetFilesInStorage}"
            : "  Archivos de assets en el storage: (este storage no puede listar su contenido: no se buscan archivos huérfanos)");
        await output.WriteLineAsync($"  Checksums verificados           : {(report.ChecksumsVerified ? "sí" : "no (usar --verify-checksums)")}");

        await output.WriteLineAsync();
        await output.WriteLineAsync($"Assets SIN archivo en el storage: {report.AssetsWithoutFile.Count}");
        foreach (var missing in report.AssetsWithoutFile)
        {
            await output.WriteLineAsync(
                $"  - asset {missing.AssetId} ({missing.Type}) del proyecto {missing.ProjectId}{(missing.ProjectDeleted ? " [eliminado]" : string.Empty)}: falta {missing.StorageKey}");
        }

        await output.WriteLineAsync($"Archivos SIN asset en la base (huérfanos): {report.FilesWithoutAsset.Count}");
        foreach (var orphan in report.FilesWithoutAsset)
        {
            await output.WriteLineAsync(
                $"  - {orphan.Key} ({orphan.SizeBytes} bytes, modificado {orphan.LastModifiedUtc:u}){(orphan.Deleted ? " [BORRADO]" : string.Empty)}");
        }

        if (report.ChecksumsVerified)
        {
            await output.WriteLineAsync($"Assets con checksum distinto: {report.ChecksumMismatches.Count}");
            foreach (var mismatch in report.ChecksumMismatches)
            {
                await output.WriteLineAsync(
                    $"  - asset {mismatch.AssetId}: {mismatch.StorageKey} esperado {mismatch.ExpectedChecksum}, actual {mismatch.ActualChecksum}");
            }
        }

        await output.WriteLineAsync();
        if (options.DeleteOrphanFiles)
        {
            var pending = report.FilesWithoutAsset.Count - deletedOrphans.Count;
            await output.WriteLineAsync(
                $"Huérfanos borrados: {deletedOrphans.Count}" +
                (pending > 0 ? $" ({pending} omitidos por tener menos de {(options.OrphanMinAge ?? ConsistencyCheckOptions.DefaultOrphanMinAge).TotalMinutes:0.##} min)" : string.Empty));
        }
        else if (report.FilesWithoutAsset.Count > 0)
        {
            await output.WriteLineAsync("Modo solo lectura: no se borró nada. Para borrar los archivos huérfanos: --delete-orphan-files");
        }

        await output.WriteLineAsync(report.IsConsistent ? "RESULTADO: consistente." : "RESULTADO: INCONSISTENTE.");
    }
}

using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Vectorify.Api.Data;
using Vectorify.Api.Data.Auth;
using Vectorify.Api.Options;
using Vectorify.Api.Users;

namespace Vectorify.Api.Maintenance;

/// <summary>
/// Herramienta de reasignación de datos LEGADOS (M3.1-S10, ADR P10): <c>dotnet Vectorify.Api.dll --reassign-legacy-data --target-email=persona@ejemplo.com [--apply]</c>.
/// Pasa a UNA cuenta real existente (indicada por su correo) los datos que quedaron sin dueño utilizable al activar la autenticación:
/// <list type="number">
/// <item><c>projects."OwnerId"</c> del usuario de desarrollo (<c>DevelopmentUser:UserId</c>, por defecto <c>00000000-0000-0000-0000-000000000001</c>), solo proyectos NO eliminados;
/// los assets, documentos, versiones y capas cuelgan del proyecto y no se tocan.</item>
/// <item>Los registros clásicos de <c>ProjectRegistry:RootPath</c> (sidecars JSON <c>{projectId}/{imageId}.json</c>) cuyo <c>OwnerId</c> es el del usuario de desarrollo o falta/es <c>null</c> (anteriores a M2.2-S09).
/// El resto de sidecars (paleta, capas, vectores, ...) no llevan dueño: heredan el del registro clásico.</item>
/// </list>
/// Garantías: <b>DRY-RUN por defecto</b> (solo informa; no escribe NADA); <c>--apply</c> explícito; idempotente (una segunda ejecución no encuentra nada); un registro de OTRA cuenta jamás se toca; no cambia ningún otro campo
/// (se edita solo <c>OwnerId</c> del JSON y solo <c>OwnerId</c> de la tabla). El cambio en la base es UNA transacción (todo o nada). Con <c>--apply</c>, antes de modificar un sidecar se deja una copia
/// <c>{imageId}.json.pre-reassign.bak</c> a su lado; los JSON nuevos se preparan primero como temporales y solo se mueven a su sitio DESPUÉS de confirmar la transacción: si la base falla, ningún archivo cambia.
/// Es un modo del propio ejecutable (no un endpoint). La API tiene los registros clásicos en memoria: pararla antes de aplicar y arrancarla después (<c>scripts/reassign-legacy-data.*</c> lo hace).
/// Códigos de salida: 0 correcto (dry-run, aplicado o nada que hacer), 1 aplicado a medias (la base cambió pero algún archivo no: volver a ejecutar), 2 no se pudo (argumentos, cuenta, base). HAGA UNA COPIA DE SEGURIDAD antes (<c>scripts/backup.*</c>).
/// </summary>
public static class ReassignLegacyDataCommand
{
    public const string Flag = "--reassign-legacy-data";
    public const string TargetEmailArgument = "--target-email=";
    public const string ApplyFlag = "--apply";
    public const string BackupSuffix = ".pre-reassign.bak";
    private const string TempSuffix = ".reassign.tmp";
    private const int MaxListed = 25;

    public static bool IsRequested(string[] args) => args.Contains(Flag, StringComparer.OrdinalIgnoreCase);

    public static async Task<int> RunAsync(IServiceProvider services, string[] args, TextWriter output)
    {
        var targetEmail = args
            .Where(a => a.StartsWith(TargetEmailArgument, StringComparison.OrdinalIgnoreCase))
            .Select(a => a[TargetEmailArgument.Length..].Trim())
            .FirstOrDefault();
        var apply = args.Contains(ApplyFlag, StringComparer.OrdinalIgnoreCase);

        var unknown = args.Where(a => a.StartsWith("--", StringComparison.Ordinal) && !IsKnownArgument(a)).ToList();
        if (unknown.Count > 0)
        {
            await output.WriteLineAsync($"ERROR: argumento no reconocido: {string.Join(", ", unknown)}. Uso: {Flag} --target-email=<correo> [{ApplyFlag}]");
            return 2;
        }

        if (string.IsNullOrWhiteSpace(targetEmail))
        {
            await output.WriteLineAsync($"ERROR: falta {TargetEmailArgument}<correo de una cuenta existente>. Uso: {Flag} --target-email=<correo> [{ApplyFlag}]");
            return 2;
        }

        var postgres = services.GetRequiredService<IOptions<PostgresOptions>>().Value;
        if (string.IsNullOrWhiteSpace(postgres.ConnectionString))
        {
            await output.WriteLineAsync("ERROR: Postgres:ConnectionString no está configurado; no se puede reasignar nada.");
            return 2;
        }

        try
        {
            await using var scope = services.CreateAsyncScope();
            return await ExecuteAsync(scope.ServiceProvider, services, targetEmail, apply, output);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // Sin stack ni cadena de conexión: solo el tipo y el mensaje de la causa (Npgsql ya omite credenciales).
            await output.WriteLineAsync(
                $"ERROR: no se pudo completar la reasignación ({DatabaseConnectionDescriber.Describe(postgres.ConnectionString)}): {ex.GetType().Name}: {ex.Message}");
            return 2;
        }
    }

    private static bool IsKnownArgument(string argument) =>
        string.Equals(argument, Flag, StringComparison.OrdinalIgnoreCase)
        || string.Equals(argument, ApplyFlag, StringComparison.OrdinalIgnoreCase)
        || argument.StartsWith(TargetEmailArgument, StringComparison.OrdinalIgnoreCase);

    private static async Task<int> ExecuteAsync(
        IServiceProvider scoped, IServiceProvider root, string targetEmail, bool apply, TextWriter output)
    {
        var db = scoped.GetRequiredService<VectorizationDbContext>();
        var users = scoped.GetRequiredService<UserManager<ApplicationUser>>();

        // El usuario de desarrollo sale de la configuración (no de IOptions: sus opciones solo se registran con Auth:Mode=Development y aquí corremos en Authenticated).
        var devUserId = (root.GetRequiredService<IConfiguration>().GetSection(DevelopmentUserOptions.SectionName).Get<DevelopmentUserOptions>()
            ?? new DevelopmentUserOptions()).UserId;

        // 1) Destino: una cuenta de Identity EXISTENTE, con su User interno (el dueño real de los proyectos es el User, no la cuenta).
        var account = await users.FindByEmailAsync(targetEmail);
        if (account is null)
        {
            await output.WriteLineAsync("ERROR: no existe ninguna cuenta con ese correo. La cuenta destino debe estar registrada antes (la herramienta no crea cuentas). No se cambió nada.");
            return 2;
        }

        var targetUserId = await db.UserIdentities.AsNoTracking()
            .Where(i => i.Provider == VectorifyClaimTypes.AspNetIdentityProvider && i.Subject == account.Id.ToString())
            .Select(i => (Guid?)i.UserId)
            .FirstOrDefaultAsync();
        if (targetUserId is null)
        {
            await output.WriteLineAsync("ERROR: la cuenta existe pero todavía no tiene su usuario interno (se crea al iniciar sesión por primera vez). Que inicie sesión una vez y vuelva a ejecutar. No se cambió nada.");
            return 2;
        }

        if (targetUserId == devUserId)
        {
            await output.WriteLineAsync("ERROR: el destino no puede ser el propio usuario de desarrollo. No se cambió nada.");
            return 2;
        }

        // 2) Inventario (solo lectura).
        var projects = await db.Projects.AsNoTracking()
            .Where(p => p.OwnerId == devUserId) // el filtro global excluye los eliminados
            .OrderBy(p => p.CreatedAt)
            .Select(p => new { p.Id, p.Name })
            .ToListAsync();
        var deletedLeftAlone = await db.Projects.IgnoreQueryFilters().AsNoTracking()
            .CountAsync(p => p.OwnerId == devUserId && p.DeletedAt != null);

        var registryRoot = ResolveRegistryRoot(scoped);
        var sidecars = ScanSidecars(registryRoot, devUserId);

        await output.WriteLineAsync($"Reasignación de datos legados — {(apply ? "MODO APLICAR (--apply)" : "DRY-RUN (no se modifica nada)")}");
        await output.WriteLineAsync($"  Destino: cuenta {account.Id} (usuario interno {targetUserId}){(account.EmailConfirmed ? string.Empty : " — AVISO: su correo aún no está confirmado")}");
        await output.WriteLineAsync($"  Origen : usuario de desarrollo {devUserId} y registros clásicos sin dueño");
        await output.WriteLineAsync($"  Carpeta de registros clásicos: {registryRoot}");
        await output.WriteLineAsync();
        await output.WriteLineAsync($"Proyectos v2 (projects.OwnerId) del usuario de desarrollo a reasignar: {projects.Count}");
        foreach (var project in projects.Take(MaxListed))
        {
            await output.WriteLineAsync($"  - {project.Id}  «{project.Name}»");
        }

        if (projects.Count > MaxListed)
        {
            await output.WriteLineAsync($"  ... y {projects.Count - MaxListed} más");
        }

        if (deletedLeftAlone > 0)
        {
            await output.WriteLineAsync($"  (hay {deletedLeftAlone} proyecto(s) ya ELIMINADOS del usuario de desarrollo: no se tocan)");
        }

        await output.WriteLineAsync($"Registros clásicos (sidecars JSON) a reasignar: {sidecars.ToChange.Count} (sin dueño: {sidecars.ToChange.Count(s => s.WasOwnerless)}, del usuario de desarrollo: {sidecars.ToChange.Count(s => !s.WasOwnerless)})");
        foreach (var sidecar in sidecars.ToChange.Take(MaxListed))
        {
            await output.WriteLineAsync($"  - {Path.GetRelativePath(registryRoot, sidecar.Path)}  (OwnerId actual: {(sidecar.WasOwnerless ? "sin dueño" : "usuario de desarrollo")})");
        }

        if (sidecars.ToChange.Count > MaxListed)
        {
            await output.WriteLineAsync($"  ... y {sidecars.ToChange.Count - MaxListed} más");
        }

        await output.WriteLineAsync($"Registros clásicos que NO se tocan: {sidecars.OwnedByOthers} de otra cuenta, {sidecars.Unreadable} ilegibles/ajenos al formato");
        await output.WriteLineAsync();

        var nothingToDo = projects.Count == 0 && sidecars.ToChange.Count == 0;
        if (nothingToDo)
        {
            await output.WriteLineAsync("RESULTADO: nada que reasignar (ya está hecho, o no hay datos legados).");
            return 0;
        }

        if (!apply)
        {
            await output.WriteLineAsync("DRY-RUN: no se modificó nada.");
            await output.WriteLineAsync($"Antes de aplicar: 1) HAGA UNA COPIA DE SEGURIDAD (scripts/backup.sh | scripts/backup.ps1); 2) pare la API (guarda los registros clásicos en memoria). Luego repita el comando con {ApplyFlag}.");
            return 0;
        }

        // 3) Aplicar. Orden: preparar temporales y copias -> transacción de la base -> confirmar -> mover temporales. Si la base falla, ningún sidecar cambió.
        var prepared = new List<PreparedSidecar>();
        try
        {
            foreach (var sidecar in sidecars.ToChange)
            {
                var backupPath = sidecar.Path + BackupSuffix;
                if (!File.Exists(backupPath))
                {
                    File.Copy(sidecar.Path, backupPath);
                }

                sidecar.Node["OwnerId"] = targetUserId.Value.ToString();
                var tempPath = sidecar.Path + TempSuffix;
                await File.WriteAllTextAsync(tempPath, sidecar.Node.ToJsonString(WriteIndented));
                prepared.Add(new PreparedSidecar(sidecar.Path, tempPath));
            }

            int updatedProjects;
            await using (var transaction = await db.Database.BeginTransactionAsync())
            {
                updatedProjects = await db.Projects
                    .Where(p => p.OwnerId == devUserId)
                    .ExecuteUpdateAsync(set => set.SetProperty(p => p.OwnerId, targetUserId.Value));
                await transaction.CommitAsync();
            }

            await output.WriteLineAsync($"Base de datos: {updatedProjects} proyecto(s) reasignado(s) (transacción confirmada).");

            var moved = 0;
            var failed = new List<string>();
            foreach (var item in prepared)
            {
                try
                {
                    File.Move(item.TempPath, item.FinalPath, overwrite: true);
                    moved++;
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    failed.Add($"{item.FinalPath}: {ex.GetType().Name}");
                }
            }

            await output.WriteLineAsync($"Registros clásicos: {moved} reasignado(s) (copias *{BackupSuffix} junto a cada uno).");
            if (failed.Count > 0)
            {
                foreach (var line in failed)
                {
                    await output.WriteLineAsync($"  ERROR de archivo: {line}");
                }

                await output.WriteLineAsync("RESULTADO: APLICADO A MEDIAS. La base ya cambió pero algunos registros clásicos no. Vuelva a ejecutar el mismo comando (es idempotente) para terminar.");
                return 1;
            }

            await output.WriteLineAsync("RESULTADO: reasignación aplicada. ARRANQUE (o reinicie) la API para que recargue los registros clásicos; hasta entonces los sigue viendo con el dueño anterior.");
            return 0;
        }
        catch
        {
            // La base no cambió (o falló antes de confirmar): se descartan los temporales; los originales ni se tocaron.
            foreach (var item in prepared)
            {
                TryDelete(item.TempPath);
            }

            throw;
        }
    }

    private static readonly JsonSerializerOptions WriteIndented = new() { WriteIndented = true };

    private static string ResolveRegistryRoot(IServiceProvider services)
    {
        var configured = services.GetRequiredService<IOptions<ProjectRegistryOptions>>().Value.RootPath;
        var environment = services.GetRequiredService<IHostEnvironment>();
        return Path.IsPathRooted(configured) ? configured : Path.Combine(environment.ContentRootPath, configured);
    }

    private static SidecarScan ScanSidecars(string root, Guid devUserId)
    {
        var toChange = new List<SidecarToChange>();
        var ownedByOthers = 0;
        var unreadable = 0;
        if (!Directory.Exists(root))
        {
            return new SidecarScan(toChange, ownedByOthers, unreadable);
        }

        foreach (var file in Directory.EnumerateFiles(root, "*.json", SearchOption.AllDirectories).OrderBy(f => f, StringComparer.Ordinal))
        {
            JsonObject? node;
            try
            {
                node = JsonNode.Parse(File.ReadAllText(file)) as JsonObject;
            }
            catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
            {
                unreadable++;
                continue;
            }

            // Solo registros de proyecto clásico: llevan ProjectId e ImageId (lo mismo que deserializa PersistentProjectRegistry).
            if (node is null || !node.ContainsKey("ProjectId") || !node.ContainsKey("ImageId"))
            {
                unreadable++;
                continue;
            }

            var owner = node["OwnerId"];
            if (owner is null)
            {
                toChange.Add(new SidecarToChange(file, node, WasOwnerless: true));
            }
            else if (owner is JsonValue value && value.TryGetValue<string>(out var text) && Guid.TryParse(text, out var ownerId))
            {
                if (ownerId == devUserId)
                {
                    toChange.Add(new SidecarToChange(file, node, WasOwnerless: false));
                }
                else
                {
                    ownedByOthers++;
                }
            }
            else
            {
                unreadable++;
            }
        }

        return new SidecarScan(toChange, ownedByOthers, unreadable);
    }

    private static void TryDelete(string path)
    {
        try
        {
            File.Delete(path);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Best effort: un temporal huérfano no afecta a nada (no termina en .json).
        }
    }

    private sealed record SidecarToChange(string Path, JsonObject Node, bool WasOwnerless);

    private sealed record SidecarScan(List<SidecarToChange> ToChange, int OwnedByOthers, int Unreadable);

    private sealed record PreparedSidecar(string FinalPath, string TempPath);
}

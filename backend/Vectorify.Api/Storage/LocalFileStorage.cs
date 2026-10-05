using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using Microsoft.Extensions.Options;
using Vectorify.Api.Options;

namespace Vectorify.Api.Storage;

/// <summary>
/// Implementación de <see cref="IFileStorage"/> sobre el filesystem local, pensada
/// para desarrollo (ver DoD/Fuera de alcance de M1-S02: "no almacenamiento cloud
/// productivo"). Escribe primero a un archivo temporal y lo mueve al destino final
/// para que una carga interrumpida o un fallo de I/O nunca deje un original a medio
/// escribir bajo su clave final.
/// </summary>
public sealed class LocalFileStorage : IFileStorage, IFileStorageInventory
{
    private readonly string _rootPath;
    private readonly ILogger<LocalFileStorage> _logger;

    public LocalFileStorage(
        IOptions<LocalStorageOptions> options,
        IHostEnvironment environment,
        ILogger<LocalFileStorage> logger)
    {
        var configuredPath = options.Value.RootPath;
        _rootPath = Path.IsPathRooted(configuredPath)
            ? configuredPath
            : Path.Combine(environment.ContentRootPath, configuredPath);
        _logger = logger;

        try
        {
            Directory.CreateDirectory(_rootPath);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw new FileStorageException($"No se pudo preparar el directorio de almacenamiento local '{_rootPath}'.", ex);
        }
    }

    public async Task<StoredFile> SaveAsync(string key, Stream content, string contentType, CancellationToken cancellationToken)
    {
        var finalPath = ResolvePath(key);
        var tempPath = finalPath + ".tmp";

        string checksum;
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(finalPath)!);

            // El checksum SHA-256 se calcula EN LA MISMA pasada de escritura (CryptoStream
            // envuelve el FileStream) -- nunca se vuelve a leer el archivo desde disco para
            // esto (M2.2-S04).
            using (var sha256 = SHA256.Create())
            {
                await using (var fileStream = new FileStream(tempPath, FileMode.Create, FileAccess.Write, FileShare.None))
                await using (var hashingStream = new CryptoStream(fileStream, sha256, CryptoStreamMode.Write, leaveOpen: true))
                {
                    await content.CopyToAsync(hashingStream, cancellationToken);
                    await hashingStream.FlushFinalBlockAsync(cancellationToken);
                }

                checksum = Convert.ToHexStringLower(sha256.Hash!);
            }

            File.Move(tempPath, finalPath, overwrite: true);
        }
        catch (OperationCanceledException)
        {
            CleanupTempFile(tempPath);
            throw;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            CleanupTempFile(tempPath);
            _logger.LogError(ex, "Fallo de almacenamiento local al guardar la clave {Key}", key);
            throw new FileStorageException($"No se pudo guardar el archivo bajo la clave '{key}'.", ex);
        }

        var sizeBytes = new FileInfo(finalPath).Length;
        return new StoredFile(key, sizeBytes, checksum);
    }

    public Task DeleteAsync(string key, CancellationToken cancellationToken)
    {
        var path = ResolvePath(key);

        try
        {
            // File.Delete no lanza si el archivo no existe -- la idempotencia que pide la
            // interfaz sale gratis de la semántica del propio BCL en ese caso, no hace falta
            // un File.Exists previo (que además sería una condición de carrera inofensiva
            // pero innecesaria). Pero SÍ lanza DirectoryNotFoundException si ni siquiera el
            // directorio contenedor existe (p. ej. nunca se guardó nada bajo ese prefijo de
            // clave) -- se atrapa aparte, abajo, porque es el MISMO resultado deseado ("esta
            // clave no tiene contenido"), no un error real de storage.
            File.Delete(path);
        }
        catch (DirectoryNotFoundException)
        {
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _logger.LogError(ex, "Fallo de almacenamiento local al borrar la clave {Key}", key);
            throw new FileStorageException($"No se pudo borrar el archivo bajo la clave '{key}'.", ex);
        }

        return Task.CompletedTask;
    }

    public Task<Stream> OpenReadAsync(string key, CancellationToken cancellationToken)
    {
        var path = ResolvePath(key);
        if (!File.Exists(path))
        {
            throw new FileNotFoundException($"No existe un original guardado bajo la clave '{key}'.", path);
        }

        try
        {
            Stream stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
            return Task.FromResult(stream);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException
                                   && ex is not FileNotFoundException and not DirectoryNotFoundException)
        {
            // Permisos/disco desmontado/archivo bloqueado: el storage "existe" pero no responde. Mismo
            // criterio que SaveAsync/DeleteAsync (M2.2-S10); un archivo que desapareció entre el Exists de
            // arriba y el open sigue siendo FileNotFoundException ("no existe"), no una falla de storage.
            _logger.LogError(ex, "Fallo de almacenamiento local al leer la clave {Key}", key);
            throw new FileStorageException($"No se pudo leer el archivo bajo la clave '{key}'.", ex);
        }
    }

    public Task<bool> ExistsAsync(string key, CancellationToken cancellationToken)
    {
        return Task.FromResult(File.Exists(ResolvePath(key)));
    }

    public async IAsyncEnumerable<StoredFileInfo> ListAsync(
        string keyPrefix, [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        var directory = ResolvePath(keyPrefix);
        if (!Directory.Exists(directory))
        {
            yield break;
        }

        foreach (var path in Directory.EnumerateFiles(directory, "*", SearchOption.AllDirectories))
        {
            cancellationToken.ThrowIfCancellationRequested();

            FileInfo info;
            try
            {
                info = new FileInfo(path);
                _ = info.Length; // fuerza la lectura de metadatos: falla si el archivo desapareció entre medio
            }
            catch (FileNotFoundException)
            {
                continue; // borrado mientras se listaba: ya no existe
            }

            var key = Path.GetRelativePath(_rootPath, path).Replace(Path.DirectorySeparatorChar, '/');
            yield return new StoredFileInfo(key, info.Length, new DateTimeOffset(info.LastWriteTimeUtc, TimeSpan.Zero));
        }

        await Task.CompletedTask;
    }

    /// <summary>
    /// Traduce una clave lógica ("proyecto/imagen/original.ext") a un path absoluto
    /// dentro de la raíz de almacenamiento, rechazando segmentos "..".
    /// </summary>
    private string ResolvePath(string key)
    {
        var segments = key.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (segments.Any(segment => segment is "." or ".." || segment.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0))
        {
            throw new FileStorageException($"Clave de almacenamiento inválida: '{key}'.");
        }

        return Path.Combine([_rootPath, .. segments]);
    }

    private void CleanupTempFile(string tempPath)
    {
        try
        {
            if (File.Exists(tempPath))
            {
                File.Delete(tempPath);
            }
        }
        catch (IOException)
        {
            // Best effort: si no se puede limpiar el temporal, no oculta el error original.
        }
    }
}

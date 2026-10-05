namespace Vectorify.Api.Storage;

/// <summary>
/// Capacidad OPCIONAL de un <see cref="IFileStorage"/>: listar lo que hay guardado (M2.2-S10). La necesita el
/// verificador de consistencia DB&lt;-&gt;storage (<c>Vectorify.Api.Maintenance</c>) para encontrar archivos sin
/// fila de Asset. Se separa de <see cref="IFileStorage"/> a propósito: el flujo normal (subir/leer/borrar por
/// clave) no la necesita, y un backend que no pueda listar (o todavía no lo implemente, p. ej. S3) sigue
/// cumpliendo <see cref="IFileStorage"/> sin cambios -- el verificador simplemente avisa que no puede buscar
/// huérfanos.
/// </summary>
public interface IFileStorageInventory
{
    /// <summary>
    /// Lista, en cualquier orden, todos los archivos cuya clave lógica empieza con <paramref name="keyPrefix"/>
    /// (segmentos separados por "/", sin "/" inicial). Solo lectura.
    /// </summary>
    IAsyncEnumerable<StoredFileInfo> ListAsync(string keyPrefix, CancellationToken cancellationToken);
}

/// <summary>Un archivo del storage tal como lo ve <see cref="IFileStorageInventory"/>.</summary>
public sealed record StoredFileInfo(string Key, long SizeBytes, DateTimeOffset LastModifiedUtc);

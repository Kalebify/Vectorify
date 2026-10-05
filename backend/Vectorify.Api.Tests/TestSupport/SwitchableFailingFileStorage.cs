using Vectorify.Api.Storage;

namespace Vectorify.Api.Tests.TestSupport;

/// <summary>
/// <see cref="IFileStorage"/> real (delega todo en <see cref="LocalFileStorage"/>) cuyo comportamiento se puede
/// degradar EN CALIENTE durante un test (M2.2-S10): <see cref="FailReads"/> hace que leer lance
/// <see cref="FileStorageException"/> (el storage "existe" pero no responde: permisos, disco desmontado) y
/// <see cref="FailWriteWhen"/> hace fallar la escritura de las claves que cumplan el predicado. Se activa
/// DESPUÉS de recorrer el flujo clásico, justo antes del paso que se quiere ver fallar -- determinista, sin
/// depender de tiempos. (La variante selectiva privada de <c>VectorDocumentEndpointsTests</c> decide al construirse
/// y no sirve para "se cae en medio de un flujo".)
/// </summary>
public sealed class SwitchableFailingFileStorage : IFileStorage
{
    private readonly IFileStorage _inner;

    public SwitchableFailingFileStorage(IFileStorage inner)
    {
        _inner = inner;
    }

    public bool FailReads { get; set; }

    public Func<string, bool>? FailWriteWhen { get; set; }

    public Task<StoredFile> SaveAsync(string key, Stream content, string contentType, CancellationToken cancellationToken) =>
        FailWriteWhen?.Invoke(key) == true
            ? throw new FileStorageException($"fallo simulado de storage al escribir '{key}'")
            : _inner.SaveAsync(key, content, contentType, cancellationToken);

    public Task<Stream> OpenReadAsync(string key, CancellationToken cancellationToken) =>
        FailReads
            ? throw new FileStorageException($"fallo simulado de storage al leer '{key}'")
            : _inner.OpenReadAsync(key, cancellationToken);

    public Task<bool> ExistsAsync(string key, CancellationToken cancellationToken) =>
        FailReads
            ? throw new FileStorageException($"fallo simulado de storage al consultar '{key}'")
            : _inner.ExistsAsync(key, cancellationToken);

    public Task DeleteAsync(string key, CancellationToken cancellationToken) => _inner.DeleteAsync(key, cancellationToken);
}

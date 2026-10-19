using System.Threading.Channels;

namespace Vectorify.Api.Email;

public enum AuthEmailKind
{
    PasswordReset,
    EmailConfirmation,
}

/// <summary>Pedido de envío. <see cref="Email"/> vive solo en memoria; el trabajador resuelve la cuenta, genera el token y arma el enlace (nada de eso ocurre en la ruta de respuesta).</summary>
public sealed record AuthEmailJob(AuthEmailKind Kind, string Email, Guid? UserId = null);

public interface IAuthEmailQueue
{
    /// <summary>Encola sin esperar. false si la cola está llena (el pedido se descarta).</summary>
    bool TryEnqueue(AuthEmailJob job);
}

/// <summary>
/// Cola en memoria (acotada) entre las peticiones y <see cref="AuthEmailWorker"/>. El envío de correo (y la búsqueda de la cuenta que lo decide) queda FUERA de la
/// ruta de respuesta: así el tiempo de respuesta no depende de si la cuenta existe ni de si el SMTP tarda o falla (T5). Límite conocido: los pedidos pendientes se
/// pierden si el proceso se detiene; la persona puede volver a pedir el enlace.
/// </summary>
public sealed class AuthEmailQueue : IAuthEmailQueue
{
    public const int Capacity = 1000;

    private readonly Channel<AuthEmailJob> _channel = Channel.CreateBounded<AuthEmailJob>(
        new BoundedChannelOptions(Capacity) { FullMode = BoundedChannelFullMode.DropWrite, SingleReader = true });

    private int _pending;

    internal ChannelReader<AuthEmailJob> Reader => _channel.Reader;

    public bool TryEnqueue(AuthEmailJob job)
    {
        Interlocked.Increment(ref _pending);
        if (_channel.Writer.TryWrite(job))
        {
            return true;
        }

        Interlocked.Decrement(ref _pending);
        return false;
    }

    /// <summary>El trabajador terminó de procesar un pedido (con éxito o no).</summary>
    internal void MarkProcessed() => Interlocked.Decrement(ref _pending);

    /// <summary>Espera a que no quede ningún pedido en cola ni en proceso (los tests lo usan para afirmar «no se envió nada» sin dormir a ciegas). true si se vació a tiempo.</summary>
    public async Task<bool> WhenIdleAsync(TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (Volatile.Read(ref _pending) > 0)
        {
            if (DateTime.UtcNow >= deadline)
            {
                return false;
            }

            await Task.Delay(10);
        }

        return true;
    }
}

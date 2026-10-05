using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;

namespace Vectorify.Api.Tests.TestSupport;

/// <summary>
/// Proxy TCP mínimo (loopback) que se interpone entre la Web API y PostgreSQL (Testcontainers) para
/// simular, de forma determinista, "Postgres cayó" y "Postgres volvió" (M2.2-S10): <see cref="Stop"/> cierra el
/// listener y TODAS las conexiones ya establecidas (como un `docker compose stop postgres`), y
/// <see cref="Start"/> vuelve a escuchar en el MISMO puerto (como un `docker compose start`). Detener/arrancar
/// el container de Testcontainers no sirve para esto: Docker puede reasignar el puerto publicado al
/// arrancar de nuevo y la connection string de la API dejaría de ser válida.
/// </summary>
public sealed class TcpForwardingProxy : IAsyncDisposable
{
    private readonly string _targetHost;
    private readonly int _targetPort;
    private readonly ConcurrentDictionary<TcpClient, byte> _connections = new();
    private TcpListener? _listener;
    private CancellationTokenSource? _cts;
    private Task? _acceptLoop;

    public TcpForwardingProxy(string targetHost, int targetPort)
    {
        _targetHost = targetHost;
        _targetPort = targetPort;
    }

    /// <summary>Puerto local fijo (se resuelve en el primer <see cref="Start"/> y se reutiliza en los siguientes).</summary>
    public int Port { get; private set; }

    public void Start()
    {
        if (_listener is not null)
        {
            return;
        }

        _listener = new TcpListener(IPAddress.Loopback, Port);
        _listener.Start();
        Port = ((IPEndPoint)_listener.LocalEndpoint).Port;
        _cts = new CancellationTokenSource();
        _acceptLoop = Task.Run(() => AcceptLoopAsync(_listener, _cts.Token));
    }

    public void Stop()
    {
        _cts?.Cancel();
        _listener?.Stop();
        _listener = null;

        foreach (var connection in _connections.Keys)
        {
            connection.Close();
        }

        _connections.Clear();
    }

    private async Task AcceptLoopAsync(TcpListener listener, CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            TcpClient client;
            try
            {
                client = await listener.AcceptTcpClientAsync(cancellationToken);
            }
            catch (Exception) when (cancellationToken.IsCancellationRequested || !listener.Server.IsBound)
            {
                return;
            }
            catch (Exception ex) when (ex is SocketException or ObjectDisposedException or OperationCanceledException)
            {
                return;
            }

            _ = Task.Run(() => PumpAsync(client, cancellationToken), cancellationToken);
        }
    }

    private async Task PumpAsync(TcpClient client, CancellationToken cancellationToken)
    {
        var upstream = new TcpClient();
        try
        {
            await upstream.ConnectAsync(_targetHost, _targetPort, cancellationToken);
            _connections[client] = 0;
            _connections[upstream] = 0;

            var clientStream = client.GetStream();
            var upstreamStream = upstream.GetStream();
            await Task.WhenAny(
                clientStream.CopyToAsync(upstreamStream, cancellationToken),
                upstreamStream.CopyToAsync(clientStream, cancellationToken));
        }
        catch (Exception)
        {
            // Una conexión cortada (Stop(), cierre del peer) termina el bombeo; no hay nada que reportar.
        }
        finally
        {
            client.Close();
            upstream.Close();
            _connections.TryRemove(client, out _);
            _connections.TryRemove(upstream, out _);
        }
    }

    public async ValueTask DisposeAsync()
    {
        Stop();
        if (_acceptLoop is not null)
        {
            try
            {
                await _acceptLoop.WaitAsync(TimeSpan.FromSeconds(2));
            }
            catch (Exception)
            {
                // El loop ya terminó por cancelación/cierre del listener.
            }
        }
    }
}

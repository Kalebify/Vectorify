using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;

namespace Vectorify.Api.Tests.TestSupport;

/// <summary>Un mensaje recibido por <see cref="FakeSmtpServer"/>, con las partes MIME ya decodificadas.</summary>
public sealed record ReceivedMail(string From, IReadOnlyList<string> Recipients, string Raw, string Subject, string? TextBody, string? HtmlBody);

/// <summary>
/// Servidor SMTP falso EN PROCESO (sin dependencias): habla el protocolo real por TCP (EHLO, AUTH LOGIN, MAIL FROM, RCPT TO, DATA, QUIT) para que
/// <c>SmtpEmailSender</c> (System.Net.Mail.SmtpClient) lo use de verdad, sin imitar la interfaz. Actúa de sumidero tipo Mailpit: guarda los mensajes. Sin TLS (el modo
/// <c>Auth:Email:Smtp:Security=None</c> es solo de desarrollo/test). Puede rechazar destinatarios (550) para probar el manejo de fallos.
/// </summary>
public sealed partial class FakeSmtpServer : IAsyncDisposable
{
    private readonly TcpListener _listener = new(IPAddress.Loopback, 0);
    private readonly ConcurrentQueue<ReceivedMail> _mails = new();
    private readonly ConcurrentQueue<(string User, string Password)> _logins = new();
    private readonly CancellationTokenSource _cts = new();
    private readonly List<Task> _connections = [];
    private Task? _acceptLoop;

    public FakeSmtpServer(bool requireAuth = false, bool rejectRecipients = false)
    {
        RequireAuth = requireAuth;
        RejectRecipients = rejectRecipients;
    }

    public bool RequireAuth { get; }

    public bool RejectRecipients { get; }

    public int Port => ((IPEndPoint)_listener.LocalEndpoint).Port;

    public IReadOnlyList<ReceivedMail> Mails => _mails.ToArray();

    public IReadOnlyList<(string User, string Password)> Logins => _logins.ToArray();

    public FakeSmtpServer Start()
    {
        _listener.Start();
        _acceptLoop = Task.Run(AcceptLoopAsync);
        return this;
    }

    /// <summary>Espera hasta que haya <paramref name="count"/> mensajes (o vence el plazo) y los devuelve.</summary>
    public async Task<IReadOnlyList<ReceivedMail>> WaitForMailsAsync(int count, TimeSpan? timeout = null)
    {
        var deadline = DateTime.UtcNow + (timeout ?? TimeSpan.FromSeconds(20));
        while (_mails.Count < count && DateTime.UtcNow < deadline)
        {
            await Task.Delay(20);
        }

        return Mails;
    }

    public async ValueTask DisposeAsync()
    {
        await _cts.CancelAsync();
        _listener.Stop();
        if (_acceptLoop is not null)
        {
            await Task.WhenAny(_acceptLoop, Task.Delay(1000));
        }

        Task[] connections;
        lock (_connections)
        {
            connections = _connections.ToArray();
        }

        await Task.WhenAny(Task.WhenAll(connections), Task.Delay(1000));
        _cts.Dispose();
    }

    private async Task AcceptLoopAsync()
    {
        while (!_cts.IsCancellationRequested)
        {
            TcpClient client;
            try
            {
                client = await _listener.AcceptTcpClientAsync(_cts.Token);
            }
            catch (Exception ex) when (ex is OperationCanceledException or ObjectDisposedException or SocketException)
            {
                return;
            }

            var task = Task.Run(() => HandleAsync(client));
            lock (_connections)
            {
                _connections.Add(task);
            }
        }
    }

    private async Task HandleAsync(TcpClient client)
    {
        using var _ = client;
        try
        {
            await using var stream = client.GetStream();
            using var reader = new StreamReader(stream, Encoding.UTF8);
            await using var writer = new StreamWriter(stream, new UTF8Encoding(false)) { NewLine = "\r\n", AutoFlush = true };

            await writer.WriteLineAsync("220 fake-smtp ESMTP ready");
            var from = string.Empty;
            var recipients = new List<string>();
            var authenticated = !RequireAuth;

            while (await reader.ReadLineAsync(_cts.Token) is { } line)
            {
                var upper = line.ToUpperInvariant();
                if (upper.StartsWith("EHLO", StringComparison.Ordinal) || upper.StartsWith("HELO", StringComparison.Ordinal))
                {
                    await writer.WriteLineAsync("250-fake-smtp");
                    if (RequireAuth)
                    {
                        await writer.WriteLineAsync("250-AUTH LOGIN");
                    }

                    await writer.WriteLineAsync("250 OK");
                }
                else if (upper.StartsWith("AUTH LOGIN", StringComparison.Ordinal))
                {
                    var initial = line.Length > "AUTH LOGIN".Length ? line["AUTH LOGIN".Length..].Trim() : string.Empty;
                    if (initial.Length == 0)
                    {
                        await writer.WriteLineAsync("334 VXNlcm5hbWU6");
                        initial = (await reader.ReadLineAsync(_cts.Token)) ?? string.Empty;
                    }

                    await writer.WriteLineAsync("334 UGFzc3dvcmQ6");
                    var password = (await reader.ReadLineAsync(_cts.Token)) ?? string.Empty;
                    _logins.Enqueue((Decode(initial), Decode(password)));
                    authenticated = true;
                    await writer.WriteLineAsync("235 2.7.0 Authentication successful");
                }
                else if (upper.StartsWith("MAIL FROM:", StringComparison.Ordinal))
                {
                    if (!authenticated)
                    {
                        await writer.WriteLineAsync("530 5.7.0 Authentication required");
                        continue;
                    }

                    from = Address(line);
                    recipients.Clear();
                    await writer.WriteLineAsync("250 2.1.0 OK");
                }
                else if (upper.StartsWith("RCPT TO:", StringComparison.Ordinal))
                {
                    if (RejectRecipients)
                    {
                        await writer.WriteLineAsync("550 5.1.1 Mailbox unavailable");
                        continue;
                    }

                    recipients.Add(Address(line));
                    await writer.WriteLineAsync("250 2.1.5 OK");
                }
                else if (upper == "DATA")
                {
                    await writer.WriteLineAsync("354 End data with <CR><LF>.<CR><LF>");
                    var data = new StringBuilder();
                    while (await reader.ReadLineAsync(_cts.Token) is { } dataLine && dataLine != ".")
                    {
                        data.Append(dataLine.StartsWith("..", StringComparison.Ordinal) ? dataLine[1..] : dataLine).Append("\r\n");
                    }

                    _mails.Enqueue(Parse(from, recipients.ToArray(), data.ToString()));
                    await writer.WriteLineAsync("250 2.0.0 Queued");
                }
                else if (upper == "QUIT")
                {
                    await writer.WriteLineAsync("221 2.0.0 Bye");
                    return;
                }
                else if (upper is "RSET" or "NOOP")
                {
                    await writer.WriteLineAsync("250 OK");
                }
                else
                {
                    await writer.WriteLineAsync("502 5.5.2 Command not recognized");
                }
            }
        }
        catch (Exception ex) when (ex is IOException or OperationCanceledException or ObjectDisposedException or SocketException)
        {
            // cliente cerrado / apagado del servidor
        }
    }

    private static string Decode(string base64)
    {
        try
        {
            return Encoding.UTF8.GetString(Convert.FromBase64String(base64));
        }
        catch (FormatException)
        {
            return base64;
        }
    }

    private static string Address(string command)
    {
        var match = AngleAddress().Match(command);
        return match.Success ? match.Groups[1].Value : command;
    }

    [GeneratedRegex("<([^>]*)>")]
    private static partial Regex AngleAddress();

    // ------------------------------------------------------------------------------------------------------ MIME mínimo

    private static ReceivedMail Parse(string from, IReadOnlyList<string> recipients, string raw)
    {
        var (headers, body) = Split(raw);
        var subject = DecodeHeader(Header(headers, "Subject") ?? string.Empty);
        var (text, html) = Parts(headers, body);
        return new ReceivedMail(from, recipients, raw, subject, text, html);
    }

    private static (string Headers, string Body) Split(string message)
    {
        var index = message.IndexOf("\r\n\r\n", StringComparison.Ordinal);
        return index < 0 ? (message, string.Empty) : (message[..index], message[(index + 4)..]);
    }

    private static string? Header(string headers, string name)
    {
        // Cabeceras plegadas: una continuación empieza por espacio o tabulador.
        var unfolded = Regex.Replace(headers, "\r\n[ \t]+", " ");
        foreach (var line in unfolded.Split("\r\n"))
        {
            if (line.StartsWith(name + ":", StringComparison.OrdinalIgnoreCase))
            {
                return line[(name.Length + 1)..].Trim();
            }
        }

        return null;
    }

    private static string DecodeHeader(string value) =>
        EncodedWord().Replace(Regex.Replace(value, @"\?=\s+=\?", "?==?"), m =>
        {
            var encoding = Encoding.GetEncoding(m.Groups[1].Value);
            var data = m.Groups[3].Value;
            return string.Equals(m.Groups[2].Value, "B", StringComparison.OrdinalIgnoreCase)
                ? encoding.GetString(Convert.FromBase64String(data))
                : encoding.GetString(QuotedPrintableBytes(data.Replace('_', ' ')));
        });

    [GeneratedRegex(@"=\?([^?]+)\?([BbQq])\?([^?]*)\?=")]
    private static partial Regex EncodedWord();

    private static (string? Text, string? Html) Parts(string headers, string body)
    {
        var contentType = Header(headers, "Content-Type") ?? "text/plain";
        var boundaryMatch = Boundary().Match(contentType);
        if (contentType.StartsWith("multipart/", StringComparison.OrdinalIgnoreCase) && boundaryMatch.Success)
        {
            string? text = null, html = null;
            foreach (var part in body.Split("--" + boundaryMatch.Groups[1].Value))
            {
                if (part.Trim().Length == 0 || part.TrimStart().StartsWith("--", StringComparison.Ordinal))
                {
                    continue;
                }

                var (partHeaders, partBody) = Split(part.TrimStart('\r', '\n'));
                var (nestedText, nestedHtml) = Parts(partHeaders, partBody);
                text ??= nestedText;
                html ??= nestedHtml;
            }

            return (text, html);
        }

        var decoded = DecodeBody(Header(headers, "Content-Transfer-Encoding"), body, contentType);
        return contentType.StartsWith("text/html", StringComparison.OrdinalIgnoreCase) ? (null, decoded) : (decoded, null);
    }

    [GeneratedRegex("boundary=\"?([^\";]+)\"?", RegexOptions.IgnoreCase)]
    private static partial Regex Boundary();

    private static string DecodeBody(string? transferEncoding, string body, string contentType)
    {
        var charset = Charset().Match(contentType);
        var encoding = charset.Success ? Encoding.GetEncoding(charset.Groups[1].Value) : Encoding.UTF8;
        return (transferEncoding ?? "7bit").ToLowerInvariant() switch
        {
            "base64" => encoding.GetString(Convert.FromBase64String(body.Replace("\r\n", string.Empty).Trim())),
            "quoted-printable" => encoding.GetString(QuotedPrintableBytes(body)),
            _ => body,
        };
    }

    [GeneratedRegex("charset=\"?([^\";]+)\"?", RegexOptions.IgnoreCase)]
    private static partial Regex Charset();

    private static byte[] QuotedPrintableBytes(string text)
    {
        text = text.Replace("=\r\n", string.Empty);
        var bytes = new List<byte>();
        for (var i = 0; i < text.Length; i++)
        {
            if (text[i] == '=' && i + 2 < text.Length && Uri.IsHexDigit(text[i + 1]) && Uri.IsHexDigit(text[i + 2]))
            {
                bytes.Add(Convert.ToByte(text.Substring(i + 1, 2), 16));
                i += 2;
            }
            else
            {
                bytes.AddRange(Encoding.UTF8.GetBytes(text[i].ToString()));
            }
        }

        return [.. bytes];
    }
}

using System.Net;
using System.Net.Mail;
using System.Text;
using Microsoft.Extensions.Options;
using Vectorify.Api.Options;

namespace Vectorify.Api.Email;

/// <summary><c>Auth:Email:Mode=Disabled</c>: no envía nada. Forgot/resend siguen respondiendo 202 uniforme; la recuperación por correo no funciona.</summary>
public sealed class DisabledEmailSender : IEmailSender
{
    public Task SendAsync(EmailMessage message, CancellationToken cancellationToken) => Task.CompletedTask;
}

/// <summary>
/// <c>Auth:Email:Mode=Log</c>: escribe el mensaje COMPLETO (destinatario, asunto y enlace con el token) en el log para poder probar a mano. Es lo único
/// del sistema que loguea un correo y un token a propósito, por eso el arranque RECHAZA este modo fuera de Development/Testing/Test.
/// </summary>
public sealed class LogEmailSender : IEmailSender
{
    private readonly ILogger<LogEmailSender> _logger;

    public LogEmailSender(ILogger<LogEmailSender> logger)
    {
        _logger = logger;
    }

    public Task SendAsync(EmailMessage message, CancellationToken cancellationToken)
    {
        _logger.LogWarning(
            "[Auth:Email:Mode=Log, SOLO DESARROLLO] Correo a {To} | Asunto: {Subject}\n{Body}",
            message.To, message.Subject, message.TextBody);
        return Task.CompletedTask;
    }
}

/// <summary>
/// <c>Auth:Email:Mode=Smtp</c>: SMTP genérico con <see cref="SmtpClient"/> (sin dependencias NuGet). STARTTLS por defecto (puerto 587); el SMTPS implícito
/// (465) no lo soporta <see cref="SmtpClient"/>. Usuario/contraseña solo por entorno. Un cliente por envío (el volumen es mínimo).
/// </summary>
public sealed class SmtpEmailSender : IEmailSender
{
    private readonly IOptions<AuthOptions> _options;

    public SmtpEmailSender(IOptions<AuthOptions> options)
    {
        _options = options;
    }

    public async Task SendAsync(EmailMessage message, CancellationToken cancellationToken)
    {
        var email = _options.Value.Email;
        var smtp = email.Smtp;

        using var client = new SmtpClient(smtp.Host, smtp.Port)
        {
            DeliveryMethod = SmtpDeliveryMethod.Network,
            EnableSsl = smtp.Security == AuthSmtpSecurity.StartTls,
            Timeout = (int)Math.Min(int.MaxValue, smtp.Timeout.TotalMilliseconds),
            UseDefaultCredentials = false,
        };

        if (!string.IsNullOrWhiteSpace(smtp.UserName))
        {
            client.Credentials = new NetworkCredential(smtp.UserName, smtp.Password);
        }

        using var mail = new MailMessage
        {
            From = new MailAddress(email.FromAddress!, email.FromName, Encoding.UTF8),
            Subject = message.Subject,
            SubjectEncoding = Encoding.UTF8,
            BodyEncoding = Encoding.UTF8,
            IsBodyHtml = false,
            Body = message.TextBody,
        };
        mail.To.Add(new MailAddress(message.To));

        // multipart/alternative: texto plano (cuerpo) + HTML mínimo.
        var html = AlternateView.CreateAlternateViewFromString(message.HtmlBody, Encoding.UTF8, "text/html");
        html.TransferEncoding = System.Net.Mime.TransferEncoding.QuotedPrintable;
        mail.AlternateViews.Add(html);

        await client.SendMailAsync(mail, cancellationToken);
    }
}

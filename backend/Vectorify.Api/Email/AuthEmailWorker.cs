using System.Net.Mail;
using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.Options;
using Vectorify.Api.Data.Auth;
using Vectorify.Api.Options;

namespace Vectorify.Api.Email;

/// <summary>
/// Trabajador en segundo plano de los correos de recuperación y confirmación (M3.1-S08). Por cada pedido: resuelve la cuenta, genera el token NATIVO de Identity
/// (<c>GeneratePasswordResetTokenAsync</c> / <c>GenerateEmailConfirmationTokenAsync</c>), arma el enlace desde <c>Auth:Email:PublicBaseUrl</c> y envía. Un fallo (SMTP caído,
/// destinatario rechazado, base caída) NUNCA se propaga a la petición que lo originó y se registra SIN correo, token ni mensaje del servidor SMTP.
/// </summary>
public sealed class AuthEmailWorker : BackgroundService
{
    private readonly AuthEmailQueue _queue;
    private readonly IServiceScopeFactory _scopes;
    private readonly ILogger<AuthEmailWorker> _logger;

    public AuthEmailWorker(AuthEmailQueue queue, IServiceScopeFactory scopes, ILogger<AuthEmailWorker> logger)
    {
        _queue = queue;
        _scopes = scopes;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await foreach (var job in _queue.Reader.ReadAllAsync(stoppingToken))
            {
                try
                {
                    await ProcessAsync(job, stoppingToken);
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
                {
                    return;
                }
                catch (Exception ex)
                {
                    // Sin ex.Message/ToString(): una SmtpFailedRecipientException o un error de base pueden incluir la dirección.
                    _logger.LogWarning(
                        "Correo {Kind}: no se pudo enviar ({ExceptionType}{SmtpStatus}).", job.Kind, ex.GetType().Name, SmtpStatus(ex));
                }
                finally
                {
                    _queue.MarkProcessed();
                }
            }
        }
        catch (OperationCanceledException)
        {
            // apagado del host
        }
    }

    private async Task ProcessAsync(AuthEmailJob job, CancellationToken cancellationToken)
    {
        await using var scope = _scopes.CreateAsyncScope();
        var options = scope.ServiceProvider.GetRequiredService<IOptions<AuthOptions>>().Value;
        if (options.Email.Mode == AuthEmailMode.Disabled)
        {
            _logger.LogDebug("Correo {Kind}: Auth:Email:Mode=Disabled, no se envía.", job.Kind);
            return;
        }

        var users = scope.ServiceProvider.GetRequiredService<UserManager<ApplicationUser>>();
        var account = job.UserId is { } id ? await users.FindByIdAsync(id.ToString()) : await users.FindByEmailAsync(job.Email);
        if (account?.Email is null)
        {
            return; // la cuenta no existe: no se envía nada y nada lo delata hacia afuera
        }

        EmailMessage message;
        switch (job.Kind)
        {
            case AuthEmailKind.PasswordReset:
            {
                var token = await users.GeneratePasswordResetTokenAsync(account);
                var link = AuthLinks.PasswordReset(options.Email.PublicBaseUrl!, account.Email, token);
                message = AuthEmailTemplates.PasswordReset(account.Email, link, options.Tokens.PasswordResetLifetime);
                break;
            }

            case AuthEmailKind.EmailConfirmation:
            {
                if (account.EmailConfirmed)
                {
                    return; // nada que confirmar
                }

                var token = await users.GenerateEmailConfirmationTokenAsync(account);
                var link = AuthLinks.EmailConfirmation(options.Email.PublicBaseUrl!, account.Id, token);
                message = AuthEmailTemplates.EmailConfirmation(account.Email, link, options.Tokens.EmailConfirmationLifetime);
                break;
            }

            default:
                return;
        }

        var sender = scope.ServiceProvider.GetRequiredService<IEmailSender>();
        await sender.SendAsync(message, cancellationToken);
        _logger.LogInformation("Correo {Kind}: enviado para la cuenta {AccountId}.", job.Kind, account.Id);
    }

    private static string SmtpStatus(Exception ex) =>
        ex switch
        {
            SmtpFailedRecipientException r => $", SMTP {(int)r.StatusCode}",
            SmtpException s => $", SMTP {(int)s.StatusCode}",
            _ => string.Empty,
        };
}

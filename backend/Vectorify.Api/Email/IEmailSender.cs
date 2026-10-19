namespace Vectorify.Api.Email;

/// <summary>Un correo transaccional listo para enviar (M3.1-S08): texto plano + HTML mínimo, sin imágenes remotas ni rastreo.</summary>
public sealed record EmailMessage(string To, string Subject, string TextBody, string HtmlBody);

/// <summary>
/// Abstracción de envío de correo (M3.1-S08, ADR P5). El proveedor concreto —y su residencia en la UE con DPA— es una decisión HUMANA pendiente:
/// aquí solo hay implementaciones genéricas elegidas por <c>Auth:Email:Mode</c> (<c>Disabled</c> | <c>Log</c> | <c>Smtp</c>). Nunca se invoca dentro de
/// la ruta de respuesta de una petición: lo hace <see cref="AuthEmailWorker"/> en segundo plano.
/// </summary>
public interface IEmailSender
{
    /// <summary>Envía el mensaje. Lanza si el envío falla (el llamador registra el fallo SIN datos personales).</summary>
    Task SendAsync(EmailMessage message, CancellationToken cancellationToken);
}

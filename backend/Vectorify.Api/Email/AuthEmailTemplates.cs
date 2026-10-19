using System.Net;

namespace Vectorify.Api.Email;

/// <summary>Plantillas en español (rioplatense) de los correos de recuperación y confirmación (M3.1-S08): texto plano + HTML mínimo; sin imágenes remotas ni rastreo.</summary>
public static class AuthEmailTemplates
{
    public static EmailMessage PasswordReset(string to, string link, TimeSpan lifetime)
    {
        var duration = Describe(lifetime);
        var text =
            "Hola,\n\n" +
            "Recibimos un pedido para elegir una contraseña nueva en tu cuenta de Vectorify.\n\n" +
            "Abrí este enlace para hacerlo:\n" +
            $"{link}\n\n" +
            $"El enlace vence en {duration} y sirve una sola vez.\n\n" +
            "Si no lo pediste vos, ignorá este mensaje: tu contraseña no cambia.\n\n" +
            "Vectorify\n";
        var html = Html(
            "Restablecé tu contraseña",
            ["Recibimos un pedido para elegir una contraseña nueva en tu cuenta de Vectorify."],
            "Elegir una contraseña nueva",
            link,
            [$"El enlace vence en {duration} y sirve una sola vez.", "Si no lo pediste vos, ignorá este mensaje: tu contraseña no cambia."]);
        return new EmailMessage(to, "Restablecé tu contraseña de Vectorify", text, html);
    }

    public static EmailMessage EmailConfirmation(string to, string link, TimeSpan lifetime)
    {
        var duration = Describe(lifetime);
        var text =
            "Hola,\n\n" +
            "Gracias por crear tu cuenta en Vectorify. Para confirmar tu correo, abrí este enlace:\n" +
            $"{link}\n\n" +
            $"El enlace vence en {duration} y sirve una sola vez. Si vence, podés pedir otro desde la pantalla de inicio de sesión.\n\n" +
            "Si no creaste una cuenta en Vectorify, ignorá este mensaje.\n\n" +
            "Vectorify\n";
        var html = Html(
            "Confirmá tu correo",
            ["Gracias por crear tu cuenta en Vectorify. Para confirmar tu correo, usá el botón de abajo."],
            "Confirmar mi correo",
            link,
            [$"El enlace vence en {duration} y sirve una sola vez. Si vence, podés pedir otro desde la pantalla de inicio de sesión.", "Si no creaste una cuenta en Vectorify, ignorá este mensaje."]);
        return new EmailMessage(to, "Confirmá tu correo en Vectorify", text, html);
    }

    /// <summary>«1 hora», «24 horas», «30 minutos», «2 días» (los días solo desde 2: 24 horas se lee mejor que «1 día»).</summary>
    internal static string Describe(TimeSpan lifetime)
    {
        if (lifetime >= TimeSpan.FromDays(2) && lifetime.Ticks % TimeSpan.FromDays(1).Ticks == 0)
        {
            return $"{(int)lifetime.TotalDays} días";
        }

        if (lifetime >= TimeSpan.FromHours(1) && lifetime.Ticks % TimeSpan.FromHours(1).Ticks == 0)
        {
            var hours = (int)lifetime.TotalHours;
            return hours == 1 ? "1 hora" : $"{hours} horas";
        }

        var minutes = Math.Max(1, (int)Math.Ceiling(lifetime.TotalMinutes));
        return minutes == 1 ? "1 minuto" : $"{minutes} minutos";
    }

    private static string Enc(string value) => WebUtility.HtmlEncode(value);

    private static string Html(string title, string[] intro, string action, string link, string[] notes)
    {
        var href = Enc(link);
        var introHtml = string.Concat(intro.Select(p => $"<p>{Enc(p)}</p>"));
        var notesHtml = string.Concat(notes.Select(p => $"<p style=\"color:#555555;font-size:14px\">{Enc(p)}</p>"));
        return
            "<!DOCTYPE html><html lang=\"es\"><head><meta charset=\"utf-8\"><title>" + Enc(title) + "</title></head>" +
            "<body style=\"font-family:system-ui,Segoe UI,Roboto,sans-serif;color:#08060d;line-height:1.5\">" +
            "<h1 style=\"font-size:20px\">" + Enc(title) + "</h1>" +
            introHtml +
            $"<p><a href=\"{href}\" style=\"display:inline-block;background:#9333ea;color:#ffffff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600\">{Enc(action)}</a></p>" +
            $"<p style=\"font-size:14px\">Si el botón no funciona, copiá y pegá este enlace en el navegador:<br><a href=\"{href}\">{Enc(link)}</a></p>" +
            notesHtml +
            "<p style=\"color:#555555;font-size:14px\">Vectorify</p></body></html>";
    }
}

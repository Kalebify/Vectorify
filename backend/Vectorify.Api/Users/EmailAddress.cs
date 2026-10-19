using System.Net.Mail;

namespace Vectorify.Api.Users;

/// <summary>Validación de direcciones de correo compartida por el registro, la recuperación y las opciones (una sola regla).</summary>
public static class EmailAddress
{
    public const int MaxLength = 254;

    /// <summary>true si <paramref name="email"/> es una dirección pelada (sin nombre ni comentarios), con dominio con punto y sin espacios.</summary>
    public static bool IsValid(string? email)
    {
        if (string.IsNullOrEmpty(email) || email.Length > MaxLength)
        {
            return false;
        }

        // MailAddress acepta formas con nombre ("Ana <a@b.c>") y comentarios: solo vale la dirección pelada.
        if (!MailAddress.TryCreate(email, out var parsed) || !string.Equals(parsed.Address, email, StringComparison.Ordinal))
        {
            return false;
        }

        return email.Contains('@') && parsed.Host.Contains('.') && !email.Any(char.IsWhiteSpace);
    }
}

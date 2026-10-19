namespace Vectorify.Api.Email;

/// <summary>
/// Enlaces de los correos (M3.1-S08). La base sale SIEMPRE de <c>Auth:Email:PublicBaseUrl</c> (configuración validada al arrancar), nunca de la cabecera
/// Host/Origin de la petición (anti host-header injection). El token viaja en el FRAGMENTO (<c>#</c>): el navegador no lo envía a ningún servidor, no
/// queda en logs de acceso ni en la cabecera Referer; la SPA lo lee y lo borra de la barra antes de cualquier petición. Valores con
/// <see cref="Uri.EscapeDataString"/> (equivalente a <c>encodeURIComponent</c>).
/// </summary>
public static class AuthLinks
{
    public const string ResetPasswordView = "reset-password";
    public const string ConfirmEmailView = "confirm-email";

    public static string PasswordReset(string publicBaseUrl, string email, string token) =>
        $"{Base(publicBaseUrl)}/?view={ResetPasswordView}#email={Uri.EscapeDataString(email)}&token={Uri.EscapeDataString(token)}";

    public static string EmailConfirmation(string publicBaseUrl, Guid userId, string token) =>
        $"{Base(publicBaseUrl)}/?view={ConfirmEmailView}#userId={userId:D}&token={Uri.EscapeDataString(token)}";

    private static string Base(string publicBaseUrl) => publicBaseUrl.Trim().TrimEnd('/');
}

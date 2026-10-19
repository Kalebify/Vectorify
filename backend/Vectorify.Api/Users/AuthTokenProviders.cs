using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.Options;
using Vectorify.Api.Data.Auth;

namespace Vectorify.Api.Users;

/// <summary>Opciones del proveedor de tokens de restablecer contraseña (vida = <c>Auth:Tokens:PasswordResetLifetime</c>).</summary>
public sealed class PasswordResetTokenProviderOptions : DataProtectionTokenProviderOptions;

/// <summary>Opciones del proveedor de tokens de confirmar correo (vida = <c>Auth:Tokens:EmailConfirmationLifetime</c>).</summary>
public sealed class EmailConfirmationTokenProviderOptions : DataProtectionTokenProviderOptions;

/// <summary>
/// Proveedor de tokens de restablecer contraseña (M3.1-S08): el <c>DataProtectorTokenProvider</c> NATIVO de Identity, con su propia vida y su propio protector (propósito
/// distinto del de confirmar correo: un token no sirve para el otro uso). El token lleva el <c>SecurityStamp</c>: al restablecer, Identity lo rota y el token deja de valer (un solo uso).
/// </summary>
public sealed class PasswordResetTokenProvider : DataProtectorTokenProvider<ApplicationUser>
{
    public const string ProviderName = "Vectorify.PasswordReset";

    public PasswordResetTokenProvider(
        IDataProtectionProvider dataProtectionProvider,
        IOptions<PasswordResetTokenProviderOptions> options,
        ILogger<DataProtectorTokenProvider<ApplicationUser>> logger)
        : base(dataProtectionProvider, options, logger)
    {
    }
}

/// <summary>Proveedor de tokens de confirmar correo (M3.1-S08): igual que <see cref="PasswordResetTokenProvider"/> pero con la vida y el propósito de la confirmación.</summary>
public sealed class EmailConfirmationTokenProvider : DataProtectorTokenProvider<ApplicationUser>
{
    public const string ProviderName = "Vectorify.EmailConfirmation";

    public EmailConfirmationTokenProvider(
        IDataProtectionProvider dataProtectionProvider,
        IOptions<EmailConfirmationTokenProviderOptions> options,
        ILogger<DataProtectorTokenProvider<ApplicationUser>> logger)
        : base(dataProtectionProvider, options, logger)
    {
    }
}

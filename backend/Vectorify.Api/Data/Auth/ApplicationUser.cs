using Microsoft.AspNetCore.Identity;

namespace Vectorify.Api.Data.Auth;

/// <summary>
/// Cuenta de ASP.NET Core Identity (M3.1-S02): credenciales y estado de la cuenta (hash de contraseña, bloqueo,
/// confirmación de email, <c>SecurityStamp</c>). Vive en el esquema <c>auth</c> de <see cref="AuthDbContext"/>, NO en el
/// <see cref="VectorizationDbContext"/> del dominio, que sigue sin saber que existe Identity. El dominio se relaciona
/// con esta cuenta únicamente a través de <see cref="UserIdentity"/>: <c>Provider = "aspnet-identity"</c>,
/// <c>Subject = ApplicationUser.Id</c>.
/// </summary>
public sealed class ApplicationUser : IdentityUser<Guid>
{
    /// <summary>Alta de la cuenta (timestamp mínimo de privacidad; el resto del estado lo lleva Identity).</summary>
    public DateTimeOffset CreatedAt { get; set; }
}

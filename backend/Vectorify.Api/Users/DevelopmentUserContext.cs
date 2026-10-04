using Microsoft.Extensions.Options;
using Vectorify.Api.Options;

namespace Vectorify.Api.Users;

/// <summary>
/// Implementación de <see cref="IUserContext"/> para desarrollo (M2.2-S03, configurable desde
/// M2.2-S09; sin Auth real): SIEMPRE devuelve el mismo usuario, tomado de
/// <see cref="DevelopmentUserOptions"/> (default: Id fijo
/// <see cref="DevelopmentUserOptions.DefaultUserId"/>), sin leer headers, cookies ni JWT del
/// request. El <see cref="Data.User"/> correspondiente a ese Id se siembra al ARRANCAR la API
/// (ver <see cref="DevelopmentUserSeeder"/> y Program.cs), no lazily en el primer uso:
/// <see cref="GetEffectiveUserId"/> es deliberadamente síncrono (sin acceso a DB) para mantener
/// la interfaz mínima, así que la fila de Postgres tiene que existir ANTES de que cualquier
/// request intente crear un <see cref="Data.Project"/> con este Id como OwnerId (la FK
/// Project.OwnerId -&gt; Users.Id es NOT NULL + Restrict, ver VectorizationDbContext).
///
/// <see cref="IsAuthenticated"/> es true porque representa una identidad YA resuelta, no
/// porque nadie la haya demostrado: "autenticado" != "demostrado" (demostrar quién es el
/// usuario es alcance de MVP 3.1). Solo se registra en Development/Testing (guardrail
/// fail-fast en <see cref="UserContextRegistration"/>). Reemplazarlo por un contexto
/// autenticado no requiere tocar ProjectService/AssetService/VectorDocumentService: todos
/// dependen únicamente de <see cref="IUserContext"/>.
/// </summary>
public sealed class DevelopmentUserContext : IUserContext
{
    private readonly DevelopmentUserOptions _options;

    public DevelopmentUserContext(IOptions<DevelopmentUserOptions> options)
    {
        _options = options.Value;
    }

    public Guid GetEffectiveUserId() => _options.UserId;

    public string? Email => _options.Email;

    public bool IsAuthenticated => true;
}

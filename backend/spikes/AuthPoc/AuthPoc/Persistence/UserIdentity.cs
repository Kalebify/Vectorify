namespace AuthPoc.Persistence;

/// <summary>
/// Vinculo (Provider, Subject) -&gt; <c>Users.Id</c> (modelo propuesto por el ADR de M3.1-S01). En el PoC vive en el esquema
/// <c>poc_auth</c> y NO en el <c>VectorizationDbContext</c> del producto; en M3.1-S02 pasa a ser una entidad del producto.
/// </summary>
public sealed class UserIdentity
{
    public Guid Id { get; set; }

    /// <summary>Emisor/proveedor (claim <c>iss</c> del token, o un literal para la autenticacion propia).</summary>
    public string Provider { get; set; } = string.Empty;

    /// <summary>Identificador estable de la persona dentro de <see cref="Provider"/> (claim <c>sub</c>). Nunca el email.</summary>
    public string Subject { get; set; } = string.Empty;

    public Guid UserId { get; set; }

    public DateTimeOffset CreatedAt { get; set; }
}

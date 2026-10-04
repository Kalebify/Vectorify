using Vectorify.Api.Users;

namespace Vectorify.Api.Tests.TestSupport;

/// <summary>
/// <see cref="IUserContext"/> fijo para pruebas unitarias de servicios (sin host ni DI): el usuario
/// efectivo es el que se le pasa al construirlo. Los tests de integración usan, en cambio, el DI
/// real (ver <see cref="OwnershipTestFixture"/>).
/// </summary>
public sealed class FixedUserContext : IUserContext
{
    private readonly Guid _userId;

    public FixedUserContext(Guid? userId = null, string? email = null, bool isAuthenticated = true)
    {
        _userId = userId ?? Guid.NewGuid();
        Email = email;
        IsAuthenticated = isAuthenticated;
    }

    public Guid GetEffectiveUserId() => _userId;

    public string? Email { get; }

    public bool IsAuthenticated { get; }
}

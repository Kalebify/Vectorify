using Vectorify.Api.Tests.TestSupport;

namespace Vectorify.Api.Tests.EndToEnd;

/// <summary>
/// Las tres clases de recuperación (M3.1-S08) comparten UN solo container PostgreSQL (cada test crea su propia base): arrancar tres containers más en paralelo, además de los de
/// la suite existente, saturaba Docker en una máquina de desarrollo y los timeouts de conexión se contagiaban a tests ajenos. Dentro de la colección corren en serie.
/// </summary>
[CollectionDefinition(Name)]
public sealed class AuthRecoveryCollection : ICollectionFixture<AuthApiFixture>
{
    public const string Name = "AuthRecovery";
}

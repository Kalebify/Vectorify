using Microsoft.Extensions.Options;
using Vectorify.Api.Options;
using Vectorify.Api.Projects;
using Vectorify.Api.Tests.TestSupport;

namespace Vectorify.Api.Tests.Projects;

/// <summary>
/// Regla de dueño única del flujo clásico (M3.1-S06): dueño, otro usuario, registro legado sin dueño e inexistente, en los dos modos de
/// autenticación. Un registro ajeno y uno inexistente son INDISTINGUIBLES para quien llama (<c>null</c>).
/// </summary>
public sealed class ClassicProjectAccessTests
{
    private static readonly Guid Owner = Guid.NewGuid();

    private static ProjectRecord Record(Guid? ownerId) =>
        new(Guid.NewGuid(), Guid.NewGuid(), "logo.png", "image/png", 10, 1, 1, "uploaded", "k/original.png", null, DateTimeOffset.UtcNow, ownerId);

    private static (ClassicProjectAccess Access, InMemoryProjectRegistry Registry) Create(
        AuthMode mode, Guid? userId, bool isAuthenticated = true)
    {
        var registry = new InMemoryProjectRegistry();
        var access = new ClassicProjectAccess(
            registry, new FixedUserContext(userId, isAuthenticated: isAuthenticated), Microsoft.Extensions.Options.Options.Create(new AuthOptions { Mode = mode }));
        return (access, registry);
    }

    [Theory]
    [InlineData(AuthMode.Authenticated)]
    [InlineData(AuthMode.Development)]
    public void TheOwner_CanAccessHisRecord_InEveryMode(AuthMode mode)
    {
        var (access, registry) = Create(mode, Owner);
        var record = Record(Owner);
        registry.Save(record);

        Assert.Same(record, access.FindAccessible(record.ProjectId, record.ImageId));
        Assert.True(access.IsAccessible(record));
    }

    [Theory]
    [InlineData(AuthMode.Authenticated)]
    [InlineData(AuthMode.Development)]
    public void AnotherUsersRecord_AndANonexistentOne_AreIndistinguishable_InEveryMode(AuthMode mode)
    {
        var (access, registry) = Create(mode, Owner);
        var foreign = Record(Guid.NewGuid());
        registry.Save(foreign);

        Assert.Null(access.FindAccessible(foreign.ProjectId, foreign.ImageId));
        Assert.Null(access.FindAccessible(Guid.NewGuid(), Guid.NewGuid()));
        Assert.False(access.IsAccessible(foreign));
    }

    [Fact]
    public void ALegacyRecordWithoutOwner_FailsClosed_InAuthenticatedMode()
    {
        var (access, registry) = Create(AuthMode.Authenticated, Owner);
        var legacy = Record(null);
        registry.Save(legacy);

        Assert.Null(access.FindAccessible(legacy.ProjectId, legacy.ImageId));
        Assert.False(access.IsAccessible(legacy));
    }

    [Fact]
    public void ALegacyRecordWithoutOwner_StaysAccessible_ForTheDevelopmentUser()
    {
        var (access, registry) = Create(AuthMode.Development, DevelopmentUserOptions.DefaultUserId);
        var legacy = Record(null);
        registry.Save(legacy);

        Assert.Same(legacy, access.FindAccessible(legacy.ProjectId, legacy.ImageId));
    }

    [Theory]
    [InlineData(AuthMode.Authenticated)]
    [InlineData(AuthMode.Development)]
    public void WithoutAResolvedUser_NothingIsAccessible_AndItNeverThrows(AuthMode mode)
    {
        var (access, registry) = Create(mode, Owner, isAuthenticated: false);
        var own = Record(Owner);
        var legacy = Record(null);
        registry.Save(own);
        registry.Save(legacy);

        Assert.Null(access.FindAccessible(own.ProjectId, own.ImageId));
        Assert.Null(access.FindAccessible(legacy.ProjectId, legacy.ImageId));
    }
}

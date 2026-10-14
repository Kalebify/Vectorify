using System.Security.Claims;
using AuthPoc.Identity;
using AuthPoc.Users;

namespace AuthPoc.Tests.Units;

/// <summary>Pruebas unitarias (sin host ni base) de la costura: <see cref="ClaimsPrincipal"/> -&gt; <c>IUserContext</c>.</summary>
public sealed class AuthenticatedUserContextTests
{
    private static ClaimsPrincipal Principal(params ClaimsIdentity[] identities) => new(identities);

    private static ClaimsIdentity External(params Claim[] claims) => new(claims, authenticationType: "Bearer");

    private static ClaimsIdentity Internal(string userId) =>
        new([new Claim(VectorifyClaimTypes.InternalUserId, userId)], VectorifyClaimTypes.InternalAuthenticationType);

    [Fact]
    public void WithoutIdentity_IsNotAuthenticated_AndAskingForTheUserIsAWiringError()
    {
        var context = AuthenticatedUserContext.ForPrincipal(new ClaimsPrincipal(new ClaimsIdentity()));

        Assert.False(context.IsAuthenticated);
        Assert.Throws<UnauthenticatedUserException>(() => context.GetEffectiveUserId());
    }

    [Fact]
    public void ExternalIdentityAlone_IsNotEnough_UntilTheServerResolvesTheLocalUser()
    {
        var context = AuthenticatedUserContext.ForPrincipal(Principal(External(new Claim("sub", "idp|1"))));

        Assert.False(context.IsAuthenticated);
        Assert.Throws<UnauthenticatedUserException>(() => context.GetEffectiveUserId());
    }

    [Fact]
    public void ResolvedUser_ComesFromTheInternalIdentity_AndEmailFromTheProviderClaims()
    {
        var userId = Guid.NewGuid();
        var context = AuthenticatedUserContext.ForPrincipal(
            Principal(External(new Claim("email", "a@poc.test")), Internal(userId.ToString())));

        Assert.True(context.IsAuthenticated);
        Assert.Equal(userId, context.GetEffectiveUserId());
        Assert.Equal("a@poc.test", context.Email);
    }

    [Fact]
    public void AClaimWithTheInternalNameInsideTheProviderIdentity_IsIgnored()
    {
        var forged = Guid.NewGuid().ToString();
        var context = AuthenticatedUserContext.ForPrincipal(
            Principal(External(new Claim(VectorifyClaimTypes.InternalUserId, forged))));

        Assert.False(context.IsAuthenticated);
    }

    [Theory]
    [InlineData("not-a-guid")]
    [InlineData("00000000-0000-0000-0000-000000000000")]
    [InlineData("")]
    public void InvalidInternalIds_AreNotAuthenticated(string raw)
    {
        var context = AuthenticatedUserContext.ForPrincipal(Principal(External(new Claim("sub", "x")), Internal(raw)));

        Assert.False(context.IsAuthenticated);
    }

    [Fact]
    public void Reader_UsesIssAsProviderAndSub_AndFallsBackForCookiePrincipals()
    {
        Assert.True(ClaimsIdentityReader.TryRead(
            Principal(External(new Claim("sub", "s1"), new Claim("iss", "https://idp.test"), new Claim("email", "a@b.c"))),
            "fallback", out var oidc));
        Assert.Equal(new ExternalIdentity("https://idp.test", "s1", "a@b.c", null), oidc);

        Assert.True(ClaimsIdentityReader.TryRead(
            Principal(External(new Claim(ClaimTypes.NameIdentifier, "u9"), new Claim(ClaimTypes.Name, "Ana"))),
            "aspnet-identity", out var cookie));
        Assert.Equal(new ExternalIdentity("aspnet-identity", "u9", null, "Ana"), cookie);
    }

    [Fact]
    public void Reader_RejectsMissingOrOversizedSubjects_AndAnonymousPrincipals()
    {
        Assert.False(ClaimsIdentityReader.TryRead(Principal(External(new Claim("iss", "x"))), "f", out _));
        Assert.False(ClaimsIdentityReader.TryRead(
            Principal(External(new Claim("sub", new string('a', ClaimsIdentityReader.MaxSubjectLength + 1)))), "f", out _));
        Assert.False(ClaimsIdentityReader.TryRead(new ClaimsPrincipal(new ClaimsIdentity()), "f", out _));
    }
}

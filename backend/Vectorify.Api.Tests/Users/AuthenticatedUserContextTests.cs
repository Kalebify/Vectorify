using System.Security.Claims;
using Microsoft.AspNetCore.Http;
using Vectorify.Api.Data;
using Vectorify.Api.Users;

namespace Vectorify.Api.Tests.Users;

/// <summary>
/// Pruebas unitarias (sin host ni base) de la costura de identidad de M3.1-S02: <see cref="ClaimsPrincipal"/> -&gt;
/// <see cref="ExternalIdentity"/> (<see cref="ClaimsIdentityReader"/>) -&gt; <see cref="IUserContext"/>
/// (<see cref="AuthenticatedUserContext"/>) y el <see cref="UserProvisioningMiddleware"/>.
/// </summary>
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
            Principal(External(new Claim(ClaimTypes.Email, "a@vectorify.test")), Internal(userId.ToString())));

        Assert.True(context.IsAuthenticated);
        Assert.Equal(userId, context.GetEffectiveUserId());
        Assert.Equal("a@vectorify.test", context.Email);
    }

    [Fact]
    public void AClaimWithTheInternalNameInsideTheProviderIdentity_IsIgnored()
    {
        var context = AuthenticatedUserContext.ForPrincipal(
            Principal(External(new Claim(VectorifyClaimTypes.InternalUserId, Guid.NewGuid().ToString()))));

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
    public void FromDi_ReadsThePrincipalOfTheCurrentRequest()
    {
        var userId = Guid.NewGuid();
        var accessor = new FixedAccessor(
            new DefaultHttpContext { User = Principal(External(new Claim("sub", "x")), Internal(userId.ToString())) });

        Assert.Equal(userId, new AuthenticatedUserContext(accessor).GetEffectiveUserId());
        Assert.False(new AuthenticatedUserContext(new FixedAccessor(null)).IsAuthenticated); // fuera de una request
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
    public void Reader_RejectsMissingOrOversizedSubjectsAndProviders_AndAnonymousPrincipals()
    {
        Assert.False(ClaimsIdentityReader.TryRead(Principal(External(new Claim("iss", "x"))), "f", out _));
        Assert.False(ClaimsIdentityReader.TryRead(
            Principal(External(new Claim("sub", new string('a', UserIdentity.MaxSubjectLength + 1)))), "f", out _));
        Assert.False(ClaimsIdentityReader.TryRead(
            Principal(External(new Claim("sub", "ok"), new Claim("iss", new string('a', UserIdentity.MaxProviderLength + 1)))), "f", out _));
        Assert.False(ClaimsIdentityReader.TryRead(new ClaimsPrincipal(new ClaimsIdentity()), "f", out _));
        Assert.True(ClaimsIdentityReader.TryRead(
            Principal(External(new Claim("sub", new string('a', UserIdentity.MaxSubjectLength)))), "f", out _));
    }

    [Fact]
    public void Reader_NeverReadsTheSubjectFromTheServerCreatedInternalIdentity()
    {
        var principal = Principal(Internal(Guid.NewGuid().ToString()), External(new Claim(ClaimTypes.NameIdentifier, "real")));

        Assert.True(ClaimsIdentityReader.TryRead(principal, "aspnet-identity", out var identity));
        Assert.Equal("real", identity.Subject);
    }

    // ------------------------------------------------------------------ UserProvisioningMiddleware

    [Fact]
    public async Task Middleware_ForAnAuthenticatedPrincipal_ResolvesTheUser_AndAddsTheInternalIdentity()
    {
        var userId = Guid.NewGuid();
        var provisioner = new RecordingProvisioner(userId);
        var context = new DefaultHttpContext
        {
            User = Principal(External(new Claim(ClaimTypes.NameIdentifier, "acct-1"), new Claim(ClaimTypes.Email, "a@vectorify.test"))),
        };
        var nextCalled = false;

        await new UserProvisioningMiddleware(_ => { nextCalled = true; return Task.CompletedTask; }).InvokeAsync(context, provisioner);

        Assert.True(nextCalled);
        Assert.Equal(new ExternalIdentity("aspnet-identity", "acct-1", "a@vectorify.test", null), Assert.Single(provisioner.Calls));
        Assert.Equal(userId, AuthenticatedUserContext.ForPrincipal(context.User).GetEffectiveUserId());
    }

    [Fact]
    public async Task Middleware_ForAnAnonymousRequest_DoesNotTouchTheProvisioner()
    {
        var provisioner = new RecordingProvisioner(Guid.NewGuid());
        var context = new DefaultHttpContext();
        var nextCalled = false;

        await new UserProvisioningMiddleware(_ => { nextCalled = true; return Task.CompletedTask; }).InvokeAsync(context, provisioner);

        Assert.True(nextCalled);
        Assert.Empty(provisioner.Calls);
        Assert.False(AuthenticatedUserContext.ForPrincipal(context.User).IsAuthenticated);
    }

    [Fact]
    public async Task Middleware_ForAnAuthenticatedPrincipalWithoutSubject_Returns401_AndDoesNotContinue()
    {
        var provisioner = new RecordingProvisioner(Guid.NewGuid());
        var context = new DefaultHttpContext { User = Principal(External(new Claim("email", "a@vectorify.test"))) };
        var nextCalled = false;

        await new UserProvisioningMiddleware(_ => { nextCalled = true; return Task.CompletedTask; }).InvokeAsync(context, provisioner);

        Assert.False(nextCalled);
        Assert.Equal(StatusCodes.Status401Unauthorized, context.Response.StatusCode);
        Assert.Empty(provisioner.Calls);
    }

    [Fact]
    public async Task Middleware_IgnoresAForgedInternalIdentityComingFromTheProvider()
    {
        var realUser = Guid.NewGuid();
        var provisioner = new RecordingProvisioner(realUser);
        var victim = Guid.NewGuid();
        var context = new DefaultHttpContext
        {
            User = Principal(External(
                new Claim(ClaimTypes.NameIdentifier, "attacker"), new Claim(VectorifyClaimTypes.InternalUserId, victim.ToString()))),
        };

        await new UserProvisioningMiddleware(_ => Task.CompletedTask).InvokeAsync(context, provisioner);

        Assert.Equal(realUser, AuthenticatedUserContext.ForPrincipal(context.User).GetEffectiveUserId());
    }

    // HttpContextAccessor guarda el contexto en un AsyncLocal ESTÁTICO: dos instancias comparten estado. Este doble no.
    private sealed class FixedAccessor : IHttpContextAccessor
    {
        public FixedAccessor(HttpContext? context)
        {
            HttpContext = context;
        }

        public HttpContext? HttpContext { get; set; }
    }

    private sealed class RecordingProvisioner : IUserProvisioner
    {
        private readonly Guid _userId;

        public RecordingProvisioner(Guid userId)
        {
            _userId = userId;
        }

        public List<ExternalIdentity> Calls { get; } = [];

        public Task<ProvisionedUser> EnsureUserAsync(ExternalIdentity identity, CancellationToken cancellationToken)
        {
            Calls.Add(identity);
            return Task.FromResult(new ProvisionedUser(_userId, Created: true));
        }
    }
}

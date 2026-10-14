using System.Net;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using AuthPoc.Tests.Support;
using Microsoft.IdentityModel.Tokens;

namespace AuthPoc.Tests.Contract;

/// <summary>Fuente (A): emisor OIDC simulado. Hereda todo el contrato y suma las comprobaciones propias de un token.</summary>
[Collection(PostgresCollection.Name)]
public sealed class OidcJwtSourceTests : IdentityBoundaryContract
{
    private OidcHarness? _harness;

    public OidcJwtSourceTests(PostgresFixture postgres)
        : base(postgres)
    {
    }

    protected override AuthSourceHarness Harness => _harness ?? throw new InvalidOperationException("Harness no inicializado.");

    private OidcHarness Oidc => (OidcHarness)Harness;

    public override Task InitializeAsync()
    {
        _harness = OidcHarness.Create(Postgres.ConnectionString);
        return Task.CompletedTask;
    }

    [Fact]
    public async Task ValidToken_IsAccepted_AndTheSigningKeyIsDiscoveredFromTheIssuer()
    {
        var actor = await Oidc.SignUpAsync();

        var me = await GetMeAsync(actor.Client);

        Assert.True(me.IsAuthenticated);
        Assert.Equal(actor.Email, me.Email);
        Assert.True(Oidc.Issuer.DiscoveryRequests >= 2, "Se esperaba discovery + JWKS: la clave no esta hardcodeada en la API.");
    }

    [Fact]
    public async Task ExpiredToken_Is401()
    {
        var token = Oidc.Issuer.MintToken("idp|expired", lifetime: TimeSpan.FromMinutes(10), issuedAgo: TimeSpan.FromMinutes(30));

        await AssertUnauthorizedAsync(token);
    }

    [Fact]
    public async Task TokenSignedWithAnotherKey_EvenWithTheSameKid_Is401()
    {
        var token = Oidc.Issuer.MintToken("idp|forged", signingKey: Oidc.Issuer.CreateForeignKey());

        await AssertUnauthorizedAsync(token);
    }

    [Fact]
    public async Task TokenFromAnotherIssuer_Is401()
    {
        var token = Oidc.Issuer.MintToken("idp|wrong-iss", issuer: "https://evil.poc.test");

        await AssertUnauthorizedAsync(token);
    }

    [Fact]
    public async Task TokenForAnotherAudience_Is401()
    {
        var token = Oidc.Issuer.MintToken("idp|wrong-aud", audience: "api://another-api");

        await AssertUnauthorizedAsync(token);
    }

    [Fact]
    public async Task UnsignedToken_AlgNone_Is401()
    {
        static string B64(string json) => Base64UrlEncoder.Encode(Encoding.UTF8.GetBytes(json));
        var exp = DateTimeOffset.UtcNow.AddMinutes(10).ToUnixTimeSeconds();
        var token = $"{B64("""{"alg":"none","typ":"JWT"}""")}." +
                    $"{B64($$"""{"sub":"idp|none","iss":"{{Oidc.Issuer.Issuer}}","aud":"{{Oidc.Issuer.Audience}}","exp":{{exp}}}""")}.";

        await AssertUnauthorizedAsync(token);
    }

    [Fact]
    public async Task TokenSignedWithASymmetricAlgorithm_Hs256_Is401()
    {
        var hmacKey = new SymmetricSecurityKey(RandomNumberGenerator.GetBytes(32)) { KeyId = Oidc.Issuer.KeyId };
        var descriptor = new SecurityTokenDescriptor
        {
            Subject = new ClaimsIdentity([new Claim("sub", "idp|hs256")]),
            Issuer = Oidc.Issuer.Issuer,
            Audience = Oidc.Issuer.Audience,
            Expires = DateTime.UtcNow.AddMinutes(10),
            SigningCredentials = new SigningCredentials(hmacKey, SecurityAlgorithms.HmacSha256),
        };
        var token = new Microsoft.IdentityModel.JsonWebTokens.JsonWebTokenHandler().CreateToken(descriptor);

        await AssertUnauthorizedAsync(token);
    }

    [Fact]
    public async Task ValidTokenWithoutSubject_CannotBeMappedToAUser_And401()
    {
        var usersBefore = await Postgres.ScalarAsync<long>("SELECT count(*) FROM users");
        var token = Oidc.Issuer.MintToken("unused", includeSubject: false);

        await AssertUnauthorizedAsync(token);

        Assert.Equal(usersBefore, await Postgres.ScalarAsync<long>("SELECT count(*) FROM users"));
    }

    [Fact]
    public async Task TokenCarryingTheInternalUserIdClaim_CannotImpersonateAnotherUser()
    {
        var victim = await Oidc.SignUpAsync();
        var victimId = (await GetMeAsync(victim.Client)).UserId;

        // El proveedor (o un atacante con un token valido propio) mete un claim con el nombre del claim interno.
        var attackerSubject = "idp|" + Guid.NewGuid().ToString("N");
        var token = Oidc.Issuer.MintToken(
            attackerSubject, extraClaims: [new Claim("vectorify:uid", victimId.ToString())]);
        using var attacker = Oidc.CreateClientWithToken(token);

        var me = await GetMeAsync(attacker);

        Assert.NotEqual(victimId, me.UserId);
    }

    [Fact]
    public async Task SameSubjectFromTwoIssuers_AreTwoDifferentUsers()
    {
        await using var other = OidcHarness.Create(Postgres.ConnectionString, "https://issuer-b.poc.test");
        var subject = "shared|" + Guid.NewGuid().ToString("N");

        using var viaA = Oidc.CreateClientWithToken(Oidc.Issuer.MintToken(subject));
        using var viaB = other.CreateClientWithToken(other.Issuer.MintToken(subject));

        var a = await GetMeAsync(viaA);
        var b = await GetMeAsync(viaB);

        Assert.NotEqual(a.UserId, b.UserId);
        Assert.Equal(2, await Postgres.ScalarAsync<long>("SELECT count(*) FROM poc_auth.user_identities WHERE \"Subject\" = @s", ("s", subject)));
    }

    [Fact]
    public async Task TheEmailIsNotTheIdentity_TwoSubjectsWithTheSameEmailAreTwoUsers()
    {
        var email = TestSecrets.NewEmail();
        using var first = Oidc.CreateClientWithToken(Oidc.Issuer.MintToken("idp|" + Guid.NewGuid().ToString("N"), email));
        using var second = Oidc.CreateClientWithToken(Oidc.Issuer.MintToken("idp|" + Guid.NewGuid().ToString("N"), email));

        Assert.NotEqual((await GetMeAsync(first)).UserId, (await GetMeAsync(second)).UserId);
    }

    [Fact]
    public async Task MalformedAuthorizationHeaders_Are401()
    {
        using var client = Oidc.CreateRawClient();

        foreach (var header in new[] { "Bearer", "Bearer not-a-jwt", "Basic dXNlcjpwYXNz", "Bearer a.b.c" })
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, "/api/v2/projects");
            request.Headers.TryAddWithoutValidation("Authorization", header);
            Assert.Equal(HttpStatusCode.Unauthorized, (await client.SendAsync(request)).StatusCode);
        }
    }

    private async Task AssertUnauthorizedAsync(string token)
    {
        using var client = Oidc.CreateClientWithToken(token);
        var response = await client.GetAsync("/api/v2/projects");
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }
}

using System.Net;
using System.Net.Http.Headers;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;

namespace AuthPoc.Tests.Support;

/// <summary>
/// Emisor OIDC SIMULADO (stand-in de Auth0/Entra External ID/Clerk/Keycloak): genera una clave RSA efimera en el test, sirve el
/// documento de discovery y el JWKS a traves de un <see cref="HttpMessageHandler"/> (sin red) y firma tokens. Nada de esto es un
/// secreto: la clave nace y muere con el test.
/// </summary>
public sealed class FakeOidcIssuer : IDisposable
{
    private readonly RSA _rsa = RSA.Create(2048);

    public FakeOidcIssuer(string issuer, string audience, string keyId = "poc-key-1")
    {
        Issuer = issuer;
        Audience = audience;
        KeyId = keyId;
        Handler = new DiscoveryHandler(this);
    }

    public string Issuer { get; }

    public string Audience { get; }

    public string KeyId { get; }

    public HttpMessageHandler Handler { get; }

    /// <summary>Numero de veces que el middleware pidio el discovery/JWKS (prueba que de verdad se descubre, no se hardcodea).</summary>
    public int DiscoveryRequests { get; private set; }

    public string MintToken(
        string subject,
        string? email = null,
        string? issuer = null,
        string? audience = null,
        TimeSpan? lifetime = null,
        TimeSpan? issuedAgo = null,
        SecurityKey? signingKey = null,
        IEnumerable<Claim>? extraClaims = null,
        bool includeSubject = true,
        string? keyId = null)
    {
        var now = DateTime.UtcNow;
        var start = now - (issuedAgo ?? TimeSpan.Zero);

        var claims = new List<Claim>();
        if (includeSubject)
        {
            claims.Add(new Claim("sub", subject));
        }

        if (email is not null)
        {
            claims.Add(new Claim("email", email));
        }

        if (extraClaims is not null)
        {
            claims.AddRange(extraClaims);
        }

        var key = signingKey ?? new RsaSecurityKey(_rsa) { KeyId = keyId ?? KeyId };
        var descriptor = new SecurityTokenDescriptor
        {
            Subject = new ClaimsIdentity(claims),
            Issuer = issuer ?? Issuer,
            Audience = audience ?? Audience,
            NotBefore = start.AddSeconds(-1),
            IssuedAt = start,
            Expires = start + (lifetime ?? TimeSpan.FromMinutes(10)),
            SigningCredentials = new SigningCredentials(key, SecurityAlgorithms.RsaSha256),
        };

        return new JsonWebTokenHandler().CreateToken(descriptor);
    }

    /// <summary>Clave RSA distinta (la de un atacante) con el MISMO <c>kid</c> que la legitima.</summary>
    public RsaSecurityKey CreateForeignKey(string? keyId = null) =>
        new(RSA.Create(2048)) { KeyId = keyId ?? KeyId };

    public void Dispose() => _rsa.Dispose();

    private string DiscoveryDocument() => JsonSerializer.Serialize(new Dictionary<string, object?>
    {
        ["issuer"] = Issuer,
        ["jwks_uri"] = $"{Issuer}/.well-known/jwks.json",
        ["authorization_endpoint"] = $"{Issuer}/authorize",
        ["token_endpoint"] = $"{Issuer}/oauth/token",
        ["response_types_supported"] = new[] { "code" },
        ["subject_types_supported"] = new[] { "public" },
        ["id_token_signing_alg_values_supported"] = new[] { "RS256" },
    });

    private string Jwks()
    {
        var jwk = JsonWebKeyConverter.ConvertFromRSASecurityKey(new RsaSecurityKey(_rsa.ExportParameters(includePrivateParameters: false)) { KeyId = KeyId });
        jwk.Use = "sig";
        jwk.Alg = SecurityAlgorithms.RsaSha256;
        var set = new JsonWebKeySet();
        set.Keys.Add(jwk);
        return JsonSerializer.Serialize(set, new JsonSerializerOptions { DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull });
    }

    private sealed class DiscoveryHandler : HttpMessageHandler
    {
        private readonly FakeOidcIssuer _issuer;

        public DiscoveryHandler(FakeOidcIssuer issuer) => _issuer = issuer;

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var url = request.RequestUri!.ToString();
            string? body = null;
            if (url == $"{_issuer.Issuer}/.well-known/openid-configuration")
            {
                body = _issuer.DiscoveryDocument();
            }
            else if (url == $"{_issuer.Issuer}/.well-known/jwks.json")
            {
                body = _issuer.Jwks();
            }

            if (body is null)
            {
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound));
            }

            _issuer.DiscoveryRequests++;
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(body, Encoding.UTF8, new MediaTypeHeaderValue("application/json")),
            });
        }
    }
}

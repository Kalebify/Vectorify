using System.Net;
using System.Text.Json;
using Vectorify.Api.Contracts;
using Vectorify.Api.Endpoints;
using Vectorify.Api.Tests.TestSupport;

namespace Vectorify.Api.Tests.EndToEnd;

/// <summary>
/// Límites de frecuencia de la recuperación (M3.1-S08) con el limitador nativo: por IP (429 + <c>Retry-After</c>, expuesto por CORS) y por dirección hasheada (202 uniforme SIN enviar).
/// Login y registro NO se limitan aquí (S09).
/// </summary>
[Collection(AuthRecoveryCollection.Name)]
public sealed class AuthRecoveryRateLimitTests : IAsyncLifetime
{
    private readonly AuthApiFixture _fixture;
    private readonly List<RecoveryHost> _hosts = [];
    private string _connectionString = string.Empty;

    public AuthRecoveryRateLimitTests(AuthApiFixture fixture)
    {
        _fixture = fixture;
    }

    public async Task InitializeAsync() => _connectionString = await _fixture.CreateDatabaseAsync();

    public async Task DisposeAsync()
    {
        foreach (var host in _hosts)
        {
            await host.DisposeAsync();
        }
    }

    private RecoveryHost CreateHost(IDictionary<string, string?> settings)
    {
        var host = RecoveryHost.Create(_fixture, _connectionString, settings);
        _hosts.Add(host);
        return host;
    }

    // ------------------------------------------------------------------------------------------------------------ por IP

    [Fact]
    public async Task PerIp_TheRequestOverTheLimit_Gets429_WithARetryAfter_ExposedToTheBrowserThroughCors()
    {
        var host = CreateHost(new Dictionary<string, string?>
        {
            ["Auth:RateLimit:IpPermitLimit"] = "3",
            ["Auth:RateLimit:IpWindow"] = "00:10:00",
        });
        var email = RecoveryHost.NewEmail();

        for (var i = 0; i < 3; i++)
        {
            Assert.Equal(HttpStatusCode.Accepted, (await host.PostAsync(AuthRecoveryEndpoints.ForgotPasswordPath, new ForgotPasswordRequest(email), ip: "10.0.0.1")).StatusCode);
        }

        var limited = await host.PostAsync(AuthRecoveryEndpoints.ForgotPasswordPath, new ForgotPasswordRequest(email), ip: "10.0.0.1");

        Assert.Equal(HttpStatusCode.TooManyRequests, limited.StatusCode);
        var retryAfter = Assert.Single(limited.Headers.GetValues("Retry-After"));
        var seconds = int.Parse(retryAfter, System.Globalization.CultureInfo.InvariantCulture);
        Assert.InRange(seconds, 1, 600);
        Assert.Equal("no-store", limited.Headers.CacheControl?.ToString());
        Assert.Equal(RecoveryHost.PublicBaseUrl, Assert.Single(limited.Headers.GetValues("Access-Control-Allow-Origin")));
        Assert.Contains("Retry-After", string.Join(",", limited.Headers.GetValues("Access-Control-Expose-Headers")), StringComparison.OrdinalIgnoreCase);
        using var body = JsonDocument.Parse(await limited.Content.ReadAsStringAsync());
        Assert.Equal("rate_limited", body.RootElement.GetProperty("code").GetString());
    }

    [Fact]
    public async Task PerIp_EachAddressAndEachRouteHasItsOwnCounter()
    {
        var host = CreateHost(new Dictionary<string, string?> { ["Auth:RateLimit:IpPermitLimit"] = "2" });
        var request = new ForgotPasswordRequest(RecoveryHost.NewEmail());

        await host.PostAsync(AuthRecoveryEndpoints.ForgotPasswordPath, request, ip: "10.0.0.1");
        await host.PostAsync(AuthRecoveryEndpoints.ForgotPasswordPath, request, ip: "10.0.0.1");
        Assert.Equal(HttpStatusCode.TooManyRequests, (await host.PostAsync(AuthRecoveryEndpoints.ForgotPasswordPath, request, ip: "10.0.0.1")).StatusCode);

        Assert.Equal(HttpStatusCode.Accepted, (await host.PostAsync(AuthRecoveryEndpoints.ForgotPasswordPath, request, ip: "10.0.0.2")).StatusCode); // otra IP
        Assert.Equal(HttpStatusCode.Accepted, (await host.PostAsync(
            AuthRecoveryEndpoints.ResendConfirmationPath, new ResendConfirmationRequest(request.Email), ip: "10.0.0.1")).StatusCode); // otra ruta
    }

    [Theory]
    [InlineData(AuthRecoveryEndpoints.ResetPasswordPath)]
    [InlineData(AuthRecoveryEndpoints.ConfirmEmailPath)]
    [InlineData(AuthRecoveryEndpoints.ResendConfirmationPath)]
    public async Task PerIp_AlsoCoversResetConfirmAndResend(string path)
    {
        var host = CreateHost(new Dictionary<string, string?> { ["Auth:RateLimit:IpPermitLimit"] = "2" });
        var body = new { email = RecoveryHost.NewEmail(), userId = Guid.NewGuid().ToString(), token = "x", newPassword = RecoveryHost.NewPassword };

        await host.PostAsync(path, body, ip: "10.0.0.7");
        await host.PostAsync(path, body, ip: "10.0.0.7");

        Assert.Equal(HttpStatusCode.TooManyRequests, (await host.PostAsync(path, body, ip: "10.0.0.7")).StatusCode);
    }

    [Fact]
    public async Task LoginAndRegister_AreNotRateLimitedByThisCard()
    {
        var host = CreateHost(new Dictionary<string, string?> { ["Auth:RateLimit:IpPermitLimit"] = "1" });

        for (var i = 0; i < 6; i++)
        {
            var login = await host.LoginAsync(RecoveryHost.NewEmail());
            Assert.Equal(HttpStatusCode.Unauthorized, login.StatusCode);
        }

        for (var i = 0; i < 3; i++)
        {
            await host.RegisterAsync();
        }
    }

    // ----------------------------------------------------------------------------------------------------- por dirección

    [Fact]
    public async Task PerAddress_ForgotAndResendShareACounter_AndTheExcessGetsTheSame202WithoutSending()
    {
        var host = CreateHost(new Dictionary<string, string?> { ["Auth:RateLimit:AddressSendPermitLimit"] = "2" });
        var email = await host.RegisterAsync(); // el registro no gasta el cupo de la dirección
        await host.SettleAsync();
        var before = host.Email.Messages.Count;

        var first = await host.PostAsync(AuthRecoveryEndpoints.ForgotPasswordPath, new ForgotPasswordRequest(email));
        var second = await host.PostAsync(AuthRecoveryEndpoints.ResendConfirmationPath, new ResendConfirmationRequest(email.ToUpperInvariant()));
        var third = await host.PostAsync(AuthRecoveryEndpoints.ForgotPasswordPath, new ForgotPasswordRequest(" " + email + " "));
        var fourth = await host.PostAsync(AuthRecoveryEndpoints.ForgotPasswordPath, new ForgotPasswordRequest(email.ToUpperInvariant()));
        await host.SettleAsync();

        Assert.All(new[] { first, second, third, fourth }, r => Assert.Equal(HttpStatusCode.Accepted, r.StatusCode));
        Assert.Equal(await first.Content.ReadAsStringAsync(), await fourth.Content.ReadAsStringAsync()); // mismo cuerpo que el no limitado
        Assert.Equal(before + 2, host.Email.Messages.Count); // solo los dos primeros salieron

        // Otra dirección no se ve afectada.
        var other = await host.RegisterAsync();
        await host.SettleAsync();
        await host.PostAsync(AuthRecoveryEndpoints.ForgotPasswordPath, new ForgotPasswordRequest(other));
        await host.SettleAsync();
        Assert.Equal(other, host.Email.Messages[^1].To);
        Assert.Contains("reset-password", RecoveryHost.LinkOf(host.Email.Messages[^1]), StringComparison.Ordinal);
    }

    [Fact]
    public async Task PerAddress_ResetAttemptsBeyondTheLimit_GetTheGenericError_EvenWithAValidToken()
    {
        var host = CreateHost(new Dictionary<string, string?> { ["Auth:RateLimit:AddressVerifyPermitLimit"] = "2" });
        var email = await host.RegisterAsync();
        await host.SettleAsync();
        await host.PostAsync(AuthRecoveryEndpoints.ForgotPasswordPath, new ForgotPasswordRequest(email));
        await host.SettleAsync();
        var token = RecoveryHost.TokenOf(host.Email.Messages[^1]);

        await host.PostAsync(AuthRecoveryEndpoints.ResetPasswordPath, new ResetPasswordRequest(email, "mal-1", RecoveryHost.NewPassword));
        await host.PostAsync(AuthRecoveryEndpoints.ResetPasswordPath, new ResetPasswordRequest(email, "mal-2", RecoveryHost.NewPassword));
        var limited = await host.PostAsync(AuthRecoveryEndpoints.ResetPasswordPath, new ResetPasswordRequest(email, token, RecoveryHost.NewPassword));

        Assert.Equal(HttpStatusCode.BadRequest, limited.StatusCode); // mismo error genérico: no revela que se frenó
        using var body = JsonDocument.Parse(await limited.Content.ReadAsStringAsync());
        Assert.Equal("invalid_token", body.RootElement.GetProperty("code").GetString());
        Assert.Equal(HttpStatusCode.OK, (await host.LoginAsync(email)).StatusCode); // la contraseña no cambió
    }
}

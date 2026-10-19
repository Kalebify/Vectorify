using System.Net;
using System.Net.Http.Json;
using System.Text.RegularExpressions;
using Vectorify.Api.Contracts;
using Vectorify.Api.Endpoints;
using Vectorify.Api.Tests.TestSupport;

namespace Vectorify.Api.Tests.EndToEnd;

/// <summary>
/// Higiene de logs de TODA la superficie de autenticación (M3.1-S09; amplía los tests de S02/S08, que cubrían registro, login y recuperación por separado): con el log a nivel
/// <b>Trace</b> (el más verboso: framework, EF Core, Kestrel-TestServer, middlewares) se recorren register (cuenta nueva y existente), login (mala y buena contraseña, «recordarme»),
/// me, perfil (GET/PATCH), confirm-email (válido y reusado), forgot/resend (cuenta conocida y desconocida), reset-password (válido, token inválido, contraseña débil), change-password,
/// logout, logout-all, rechazos CSRF con cabeceras <c>Authorization</c>/<c>Cookie</c>, JSON roto con una contraseña dentro y 429. Después se busca, en TODO lo escrito al log, cualquier contraseña,
/// valor de cookie de sesión, cabecera <c>Authorization</c>/<c>Cookie</c>/<c>Set-Cookie</c>, token de recuperación/confirmación y dirección de correo en claro.
/// </summary>
[Collection(AuthRecoveryCollection.Name)]
public sealed class AuthLogHygieneTests : IAsyncLifetime
{
    private const string Pw1 = "primera-contrasena-secreta-1";
    private const string Pw2 = "segunda-contrasena-secreta-2";
    private const string Pw3 = "tercera-contrasena-secreta-3";
    private const string WrongPw = "contrasena-equivocada-secreta-9";
    private const string WeakPw = "debil-9";
    private const string BrokenBodyPassword = "contrasena-en-json-roto-777";
    private const string BearerSecret = "bearer-token-secreto-qwerty-4242";
    private const string ForgedCookieValue = "valor-de-cookie-forjada-zzzz-8080";
    private const string SmtpPasswordSentinel = "smtp-password-centinela-5151";
    private const string DisplayName = "Nombre Visible Sensible";

    private readonly AuthApiFixture _fixture;
    private string _connectionString = string.Empty;

    public AuthLogHygieneTests(AuthApiFixture fixture)
    {
        _fixture = fixture;
    }

    public async Task InitializeAsync() => _connectionString = await _fixture.CreateDatabaseAsync();

    public Task DisposeAsync() => Task.CompletedTask;

    private static string ValueOf(string cookie) => cookie[(cookie.IndexOf('=') + 1)..];

    private static Task<HttpResponseMessage> Send(RecoveryHost host, HttpMethod method, string path, object? body = null, string? cookie = null, Action<HttpRequestMessage>? configure = null)
    {
        var request = new HttpRequestMessage(method, path);
        if (body is not null)
        {
            request.Content = JsonContent.Create(body);
        }

        if (cookie is not null)
        {
            request.Headers.Add("Cookie", cookie);
        }

        configure?.Invoke(request);
        return host.Client.SendAsync(request);
    }

    [Fact]
    public async Task TraceLevelLogs_OfEveryAuthFlow_NeverContainPasswordsCookiesAuthHeadersTokensOrEmails()
    {
        var logs = new CapturingLoggerProvider();
        await using var host = RecoveryHost.Create(
            _fixture,
            _connectionString,
            new Dictionary<string, string?>
            {
                ["Logging:LogLevel:Default"] = "Trace",
                ["Auth:Email:Smtp:Password"] = SmtpPasswordSentinel,
                ["Auth:RateLimit:LoginAddressPermitLimit"] = "6",
                ["Auth:Lockout:MaxAttempts"] = "50",
            },
            logProvider: logs);

        var secrets = new List<string>();
        var emails = new List<string>();
        string NewEmail()
        {
            var email = RecoveryHost.NewEmail();
            emails.Add(email);
            return email;
        }

        var emailA = NewEmail();
        var unknown = NewEmail();

        // ---- register: cuenta nueva, correo existente, entrada inválida
        Assert.Equal(HttpStatusCode.Accepted, (await host.PostAsync(AuthEndpoints.RegisterPath, new RegisterRequest(emailA, Pw1))).StatusCode);
        Assert.Equal(HttpStatusCode.Accepted, (await host.PostAsync(AuthEndpoints.RegisterPath, new RegisterRequest(emailA, Pw1))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await host.PostAsync(AuthEndpoints.RegisterPath, new RegisterRequest(NewEmail(), WeakPw))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await host.PostAsync(AuthEndpoints.RegisterPath, new RegisterRequest("no-es-un-correo", Pw1))).StatusCode);
        var confirmation = await host.NextEmailAsync();
        var confirmToken = RecoveryHost.TokenOf(confirmation);
        var accountId = RecoveryHost.FragmentOf(RecoveryHost.LinkOf(confirmation))["userId"];

        // ---- login: contraseña mala, desconocido, buena, «recordarme»
        Assert.Equal(HttpStatusCode.Unauthorized, (await host.LoginAsync(emailA, WrongPw)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await host.LoginAsync(unknown, WrongPw)).StatusCode);
        var cookie1 = await host.LoginCookieAsync(emailA, Pw1);
        var cookie2 = await host.LoginCookieAsync(emailA, Pw1, rememberMe: true);

        // ---- me, perfil
        Assert.Equal(HttpStatusCode.OK, (await Send(host, HttpMethod.Get, AuthEndpoints.MePath, cookie: cookie1)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await Send(host, HttpMethod.Get, "/api/v1/me", cookie: cookie1)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await Send(host, HttpMethod.Patch, "/api/v1/me", new UpdateProfileRequest(DisplayName), cookie1)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await Send(host, HttpMethod.Get, AuthEndpoints.MePath, cookie: "vectorify.session=" + ForgedCookieValue)).StatusCode);

        // ---- confirm-email (válido y reusado), resend, forgot (conocido y desconocido)
        Assert.Equal(HttpStatusCode.NoContent, (await host.PostAsync(AuthRecoveryEndpoints.ConfirmEmailPath, new ConfirmEmailRequest(accountId, null, confirmToken))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await host.PostAsync(AuthRecoveryEndpoints.ConfirmEmailPath, new ConfirmEmailRequest(accountId, null, confirmToken))).StatusCode);
        Assert.Equal(HttpStatusCode.Accepted, (await host.PostAsync(AuthRecoveryEndpoints.ResendConfirmationPath, new ResendConfirmationRequest(emailA))).StatusCode);
        Assert.Equal(HttpStatusCode.Accepted, (await host.PostAsync(AuthRecoveryEndpoints.ForgotPasswordPath, new ForgotPasswordRequest(unknown))).StatusCode);
        Assert.Equal(HttpStatusCode.Accepted, (await host.PostAsync(AuthRecoveryEndpoints.ForgotPasswordPath, new ForgotPasswordRequest(emailA))).StatusCode);
        await host.SettleAsync();
        var resetMail = host.Email.Messages.Last(m => m.TextBody.Contains("reset-password", StringComparison.Ordinal));
        var resetToken = RecoveryHost.TokenOf(resetMail);

        // ---- reset-password: token inválido, contraseña débil, válido
        Assert.Equal(HttpStatusCode.BadRequest, (await host.PostAsync(AuthRecoveryEndpoints.ResetPasswordPath, new ResetPasswordRequest(emailA, "token-invalido-0000", Pw2))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await host.PostAsync(AuthRecoveryEndpoints.ResetPasswordPath, new ResetPasswordRequest(emailA, resetToken, WeakPw))).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await host.PostAsync(AuthRecoveryEndpoints.ResetPasswordPath, new ResetPasswordRequest(emailA, resetToken, Pw2))).StatusCode);

        // ---- login con la nueva, change-password (actual mala, buena), logout, logout-all
        var cookie3 = await host.LoginCookieAsync(emailA, Pw2);
        Assert.Equal(HttpStatusCode.BadRequest, (await host.PostAsync(AuthRecoveryEndpoints.ChangePasswordPath, new ChangePasswordRequest(WrongPw, Pw3), cookie3)).StatusCode);
        var changed = await host.PostAsync(AuthRecoveryEndpoints.ChangePasswordPath, new ChangePasswordRequest(Pw2, Pw3), cookie3);
        Assert.Equal(HttpStatusCode.NoContent, changed.StatusCode);
        var cookie4 = RecoveryHost.CookieOf(changed);
        Assert.Equal(HttpStatusCode.NoContent, (await host.PostAsync(AuthEndpoints.LogoutPath, new { }, cookie4)).StatusCode);
        var cookie5 = await host.LoginCookieAsync(emailA, Pw3);
        Assert.Equal(HttpStatusCode.NoContent, (await host.PostAsync(AuthEndpoints.LogoutAllPath, new { }, cookie5)).StatusCode);

        // ---- rechazos con cabeceras sensibles: sin CSRF (con Authorization/Cookie/contraseña), JSON roto con una contraseña dentro, 429
        using (var noCsrf = host.Factory.CreateClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { HandleCookies = false }))
        {
            var rejected = new HttpRequestMessage(HttpMethod.Post, AuthEndpoints.LoginPath) { Content = JsonContent.Create(new LoginRequest(emailA, Pw3)) };
            rejected.Headers.TryAddWithoutValidation("Authorization", "Bearer " + BearerSecret);
            rejected.Headers.TryAddWithoutValidation("Cookie", cookie1);
            Assert.Equal(HttpStatusCode.Forbidden, (await noCsrf.SendAsync(rejected)).StatusCode);
        }

        var withAuthorization = await Send(host, HttpMethod.Get, AuthEndpoints.MePath, cookie: cookie1, configure: r => r.Headers.TryAddWithoutValidation("Authorization", "Bearer " + BearerSecret));
        Assert.True((int)withAuthorization.StatusCode is 200 or 401);
        var brokenJson = new HttpRequestMessage(HttpMethod.Post, AuthEndpoints.LoginPath)
        {
            Content = new StringContent("{\"email\":\"" + emailA + "\",\"password\":\"" + BrokenBodyPassword + "\"", System.Text.Encoding.UTF8, "application/json"),
        };
        Assert.Equal(HttpStatusCode.BadRequest, (await host.Client.SendAsync(brokenJson)).StatusCode);

        var limited = NewEmail();
        HttpStatusCode last = default;
        for (var i = 0; i < 8; i++)
        {
            last = (await host.LoginAsync(limited, WrongPw)).StatusCode;
        }

        Assert.Equal(HttpStatusCode.TooManyRequests, last);

        // ---- búsqueda
        secrets.AddRange([Pw1, Pw2, Pw3, WrongPw, BrokenBodyPassword, BearerSecret, ForgedCookieValue, SmtpPasswordSentinel, confirmToken, resetToken, "token-invalido-0000",
            ValueOf(cookie1), ValueOf(cookie2), ValueOf(cookie3), ValueOf(cookie4), ValueOf(cookie5), Uri.EscapeDataString(confirmToken), Uri.EscapeDataString(resetToken)]);
        var entries = logs.Entries;
        Assert.True(entries.Count > 200, $"El log a nivel Trace debería ser abundante (hay {entries.Count} entradas); si no, el test no está mirando nada.");

        var leaks = new List<string>();
        foreach (var entry in entries)
        {
            foreach (var secret in secrets.Where(s => s.Length >= 8))
            {
                if (entry.Contains(secret, StringComparison.Ordinal))
                {
                    leaks.Add($"secreto «{Mask(secret)}» en: {Shorten(entry)}");
                }
            }

            foreach (var email in emails)
            {
                if (entry.Contains(email, StringComparison.OrdinalIgnoreCase))
                {
                    leaks.Add($"correo «{email}» en: {Shorten(entry)}");
                }
            }

            if (entry.Contains("@vectorify.test", StringComparison.OrdinalIgnoreCase))
            {
                leaks.Add($"dirección de correo en claro: {Shorten(entry)}");
            }

            // Nombres de cabecera sensibles seguidos de un valor («Authorization: Bearer …», «Cookie: x=y», «Set-Cookie: …», «Password=…»).
            if (SensitiveHeaderWithValue.IsMatch(entry))
            {
                leaks.Add($"cabecera sensible con valor en: {Shorten(entry)}");
            }

            if (entry.Contains(DisplayName, StringComparison.Ordinal))
            {
                leaks.Add($"nombre visible del perfil en: {Shorten(entry)}");
            }
        }

        Assert.True(leaks.Count == 0, "Datos sensibles en el log:\n" + string.Join("\n", leaks.Distinct().Take(15)));
    }

    private static readonly Regex SensitiveHeaderWithValue = new(
        @"(?i)(\bauthorization\s*[:=]\s*(bearer|basic)\b|\bset-cookie\s*[:=]\s*\S|\bcookie\s*:\s*\S+=|\bpassword\s*=\s*\S|\bx-vectorify-request\s*[:=]\s*\S)",
        RegexOptions.Compiled);

    private static string Mask(string secret) => secret.Length <= 6 ? "******" : secret[..3] + "…" + secret[^2..];

    private static string Shorten(string entry) => entry.Length <= 240 ? entry : entry[..240] + "…";
}

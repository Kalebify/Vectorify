using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Vectorify.Api.Contracts;
using Vectorify.Api.Endpoints;
using Vectorify.Api.Tests.TestSupport;

namespace Vectorify.Api.Tests.EndToEnd;

/// <summary>
/// Recuperación de acceso y verificación de correo (M3.1-S08) contra la Web API REAL y PostgreSQL real (Testcontainers), con los tokens NATIVOS de Identity: forgot/reset,
/// confirm/resend, <c>Auth:RequireConfirmedEmail</c>, change-password y el correo de confirmación del registro. El correo se captura en memoria (el sender real se prueba en
/// <see cref="AuthRecoverySmtpTests"/>). Las sesiones se revalidan en cada petición (<c>RevalidationInterval=0</c>) para observar la invalidación del SecurityStamp sin esperar.
/// </summary>
[Collection(AuthRecoveryCollection.Name)]
public sealed class AuthRecoveryEndpointsTests : IAsyncLifetime
{
    private readonly AuthApiFixture _fixture;
    private readonly List<RecoveryHost> _hosts = [];
    private string _connectionString = string.Empty;

    public AuthRecoveryEndpointsTests(AuthApiFixture fixture)
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

    private RecoveryHost CreateHost(IDictionary<string, string?>? settings = null)
    {
        var host = RecoveryHost.Create(_fixture, _connectionString, settings);
        _hosts.Add(host);
        return host;
    }

    private static object Forgot(string email) => new ForgotPasswordRequest(email);

    private static object Reset(string email, string token, string password = RecoveryHost.NewPassword) =>
        new ResetPasswordRequest(email, token, password);

    private static async Task<string> CodeOf(HttpResponseMessage response)
    {
        using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        return json.RootElement.GetProperty("code").GetString()!;
    }

    /// <summary>Estado, cabeceras estables (sin Date ni el correlation id, distintos en cada petición) y cuerpo, para afirmar que dos respuestas son idénticas.</summary>
    private static async Task<(HttpStatusCode Status, string Headers, string Body)> ShapeOf(HttpResponseMessage response)
    {
        var headers = response.Headers.Concat(response.Content.Headers)
            .Where(h => !h.Key.Equals("Date", StringComparison.OrdinalIgnoreCase) && !h.Key.Equals("X-Correlation-Id", StringComparison.OrdinalIgnoreCase))
            .OrderBy(h => h.Key, StringComparer.OrdinalIgnoreCase)
            .Select(h => $"{h.Key}={string.Join(",", h.Value)}");
        return (response.StatusCode, string.Join("\n", headers), await response.Content.ReadAsStringAsync());
    }

    /// <summary>Registra una cuenta, descarta su correo de confirmación y devuelve el correo + un token de reset ya emitido.</summary>
    private async Task<(string Email, string Token)> AccountWithResetTokenAsync(RecoveryHost host)
    {
        var email = await host.RegisterAsync();
        await host.SettleAsync(); // confirmación del registro ya enviada
        var response = await host.PostAsync(AuthRecoveryEndpoints.ForgotPasswordPath, Forgot(email));
        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        await host.SettleAsync();
        return (email, RecoveryHost.TokenOf(host.Email.Messages[^1]));
    }

    // ------------------------------------------------------------------------------------------------------ forgot-password

    [Fact]
    public async Task ForgotPassword_ForAKnownAccount_Returns202_AndSendsOneSpanishEmail_WithALinkBuiltFromPublicBaseUrl()
    {
        var host = CreateHost();
        var email = await host.RegisterAsync();
        await host.NextEmailAsync();

        var response = await host.PostAsync(AuthRecoveryEndpoints.ForgotPasswordPath, Forgot(email));

        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        Assert.Equal("no-store", response.Headers.CacheControl?.ToString());
        var mail = await host.NextEmailAsync(2);
        Assert.Equal(email, mail.To);
        Assert.Contains("contraseña", mail.Subject, StringComparison.Ordinal);
        Assert.Contains("1 hora", mail.TextBody, StringComparison.Ordinal);
        Assert.Contains("<a href=", mail.HtmlBody, StringComparison.Ordinal);
        Assert.DoesNotContain("<img", mail.HtmlBody, StringComparison.OrdinalIgnoreCase);

        var link = RecoveryHost.LinkOf(mail);
        Assert.StartsWith($"{RecoveryHost.PublicBaseUrl}/?view=reset-password#email=", link, StringComparison.Ordinal);
        var fragment = RecoveryHost.FragmentOf(link);
        Assert.Equal(email, fragment["email"]);
        Assert.False(string.IsNullOrWhiteSpace(fragment["token"]));
        Assert.DoesNotContain("token=", new Uri(link).Query, StringComparison.Ordinal); // el token NO viaja en la query
    }

    [Fact]
    public async Task ForgotPassword_UnknownEmail_IsIndistinguishableFromAKnownOne_AndSendsNothing()
    {
        var host = CreateHost();
        var known = await host.RegisterAsync();
        await host.NextEmailAsync();
        var unknown = RecoveryHost.NewEmail();

        var forKnown = await host.PostAsync(AuthRecoveryEndpoints.ForgotPasswordPath, Forgot(known));
        var forUnknown = await host.PostAsync(AuthRecoveryEndpoints.ForgotPasswordPath, Forgot(unknown));
        await host.SettleAsync();

        Assert.Equal(await ShapeOf(forKnown), await ShapeOf(forUnknown)); // estado, cabeceras y cuerpo idénticos
        Assert.Equal(HttpStatusCode.Accepted, forUnknown.StatusCode);
        Assert.Equal(2, host.Email.Messages.Count); // registro + el de la cuenta conocida; ninguno al desconocido
        Assert.DoesNotContain(host.Email.Messages, m => m.To == unknown);
    }

    [Fact]
    public async Task ForgotPassword_MalformedEmail_Is400InvalidEmail_RegardlessOfAnyAccount()
    {
        var host = CreateHost();

        foreach (var email in new[] { "", "   ", "no-es-un-correo", "a@b", "Ana <ana@ejemplo.com>", new string('a', 300) + "@ejemplo.com" })
        {
            var response = await host.PostAsync(AuthRecoveryEndpoints.ForgotPasswordPath, Forgot(email));
            Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
            Assert.Equal("invalid_email", await CodeOf(response));
        }

        var noBody = await host.PostAsync(AuthRecoveryEndpoints.ForgotPasswordPath, new { });
        Assert.Equal(HttpStatusCode.BadRequest, noBody.StatusCode);
    }

    [Fact]
    public async Task ForgotPassword_SendingHappensOutsideTheResponsePath()
    {
        var host = CreateHost();
        var email = await host.RegisterAsync();
        await host.NextEmailAsync();
        var gate = new TaskCompletionSource();
        host.Email.Gate = gate.Task; // el «SMTP» queda colgado

        var response = await host.PostAsync(AuthRecoveryEndpoints.ForgotPasswordPath, Forgot(email)).WaitAsync(TimeSpan.FromSeconds(10));

        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode); // la respuesta no espera al correo
        Assert.Single(host.Email.Messages);
        gate.SetResult();
        Assert.Equal(2, (await host.Email.WaitForAsync(2)).Count);
    }

    [Fact]
    public async Task ForgotPassword_TheLinkNeverUsesTheRequestHostOrOrigin()
    {
        var host = CreateHost();
        var email = await host.RegisterAsync();
        await host.NextEmailAsync();

        var response = await host.PostAsync(
            AuthRecoveryEndpoints.ForgotPasswordPath,
            Forgot(email),
            configure: request =>
            {
                request.Headers.Host = "evil.example";
                request.Headers.Add("X-Forwarded-Host", "evil.example");
                request.Headers.Add("Referer", "https://evil.example/phish");
            });

        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        var link = RecoveryHost.LinkOf(await host.NextEmailAsync(2));
        Assert.StartsWith(RecoveryHost.PublicBaseUrl + "/", link, StringComparison.Ordinal);
        Assert.DoesNotContain("evil.example", link, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ForgotPassword_AlsoWorksForALockedOutOrUnconfirmedAccount()
    {
        var host = CreateHost();
        var email = await host.RegisterAsync();
        for (var i = 0; i < 5; i++)
        {
            await host.LoginAsync(email, "contrasena-equivocada-1");
        }

        var response = await host.PostAsync(AuthRecoveryEndpoints.ForgotPasswordPath, Forgot(email));

        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        Assert.Equal(2, (await host.Email.WaitForAsync(2)).Count);
    }

    // ------------------------------------------------------------------------------------------------------ reset-password

    [Fact]
    public async Task ResetPassword_WithAValidToken_ChangesThePassword_AndTheOldOneStopsWorking()
    {
        var host = CreateHost();
        var (email, token) = await AccountWithResetTokenAsync(host);

        var response = await host.PostAsync(AuthRecoveryEndpoints.ResetPasswordPath, Reset(email, token));

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal("no-store", response.Headers.CacheControl?.ToString());
        Assert.Equal(HttpStatusCode.OK, (await host.LoginAsync(email, RecoveryHost.NewPassword)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await host.LoginAsync(email, RecoveryHost.Password)).StatusCode);
    }

    [Fact]
    public async Task ResetPassword_ASecondUseOfTheSameToken_Fails_BecauseTheStampRotated()
    {
        var host = CreateHost();
        var (email, token) = await AccountWithResetTokenAsync(host);
        var stampBefore = await host.StampAsync(email);

        Assert.Equal(HttpStatusCode.NoContent, (await host.PostAsync(AuthRecoveryEndpoints.ResetPasswordPath, Reset(email, token))).StatusCode);
        var stampAfter = await host.StampAsync(email);
        var reused = await host.PostAsync(AuthRecoveryEndpoints.ResetPasswordPath, Reset(email, token, "una-tercera-contrasena-3"));

        Assert.NotEqual(stampBefore, stampAfter);
        Assert.Equal(HttpStatusCode.BadRequest, reused.StatusCode);
        Assert.Equal("invalid_token", await CodeOf(reused));
        Assert.Equal(HttpStatusCode.OK, (await host.LoginAsync(email, RecoveryHost.NewPassword)).StatusCode); // la contraseña no cambió por el reuso
    }

    [Fact]
    public async Task ResetPassword_AnExpiredToken_IsRejected()
    {
        // Identity.Core valida la caducidad con DateTimeOffset.UtcNow (no usa TimeProvider): no hay reloj que controlar, así que se prueba con una vida de 2 s y una espera real.
        var host = CreateHost(new Dictionary<string, string?> { ["Auth:Tokens:PasswordResetLifetime"] = "00:00:02" });
        var (email, token) = await AccountWithResetTokenAsync(host);

        await Task.Delay(TimeSpan.FromSeconds(3));
        var response = await host.PostAsync(AuthRecoveryEndpoints.ResetPasswordPath, Reset(email, token));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("invalid_token", await CodeOf(response));
        Assert.Equal(HttpStatusCode.OK, (await host.LoginAsync(email, RecoveryHost.Password)).StatusCode); // la contraseña sigue siendo la de antes
    }

    [Fact]
    public async Task ResetPassword_ATokenWithinItsLifetime_IsAccepted_ControlForTheExpiryTest()
    {
        var host = CreateHost(new Dictionary<string, string?> { ["Auth:Tokens:PasswordResetLifetime"] = "00:10:00" });
        var (email, token) = await AccountWithResetTokenAsync(host);

        await Task.Delay(TimeSpan.FromSeconds(3));

        Assert.Equal(HttpStatusCode.NoContent, (await host.PostAsync(AuthRecoveryEndpoints.ResetPasswordPath, Reset(email, token))).StatusCode);
    }

    [Fact]
    public async Task ResetPassword_MalformedUnknownAndForeignTokens_AllGetTheSameGenericAnswer()
    {
        var host = CreateHost();
        var (email, token) = await AccountWithResetTokenAsync(host);
        var (otherEmail, otherToken) = await AccountWithResetTokenAsync(host);
        var unknown = RecoveryHost.NewEmail();

        var attempts = new Dictionary<string, object>
        {
            ["basura"] = Reset(email, "esto-no-es-un-token"),
            ["truncado"] = Reset(email, token[..(token.Length / 2)]),
            ["alterado"] = Reset(email, token[..^4] + (token.EndsWith("AAAA", StringComparison.Ordinal) ? "BBBB" : "AAAA")),
            ["vacío"] = Reset(email, string.Empty),
            ["sin token"] = new { email, newPassword = RecoveryHost.NewPassword },
            ["desmesurado"] = Reset(email, new string('A', 5000)),
            ["token de otra cuenta"] = Reset(email, otherToken),
            ["cuenta inexistente"] = Reset(unknown, token),
            ["correo malformado"] = Reset("no-es-un-correo", token),
        };

        string? expected = null;
        foreach (var (name, body) in attempts)
        {
            var response = await host.PostAsync(AuthRecoveryEndpoints.ResetPasswordPath, body);
            Assert.True(response.StatusCode == HttpStatusCode.BadRequest, $"{name}: {response.StatusCode}");
            var shape = (await ShapeOf(response)).Body;
            expected ??= shape;
            Assert.True(expected == shape, $"{name}: el cuerpo difiere de los demás errores");
            Assert.Equal("invalid_token", await CodeOf(await host.PostAsync(AuthRecoveryEndpoints.ResetPasswordPath, body)));
        }

        // Ninguno de los intentos cambió nada: las dos cuentas siguen con su contraseña y sus tokens siguen siendo válidos.
        Assert.Equal(HttpStatusCode.OK, (await host.LoginAsync(email)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await host.LoginAsync(otherEmail)).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await host.PostAsync(AuthRecoveryEndpoints.ResetPasswordPath, Reset(email, token))).StatusCode);
    }

    [Fact]
    public async Task ResetPassword_AWeakPassword_Is400WeakPassword_AndDoesNotConsumeTheToken()
    {
        var host = CreateHost();
        var (email, token) = await AccountWithResetTokenAsync(host);

        foreach (var weak in new[] { "corta", "12345678901", new string('x', 129) })
        {
            var response = await host.PostAsync(AuthRecoveryEndpoints.ResetPasswordPath, Reset(email, token, weak));
            Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
            Assert.Equal("weak_password", await CodeOf(response));
        }

        var empty = await host.PostAsync(AuthRecoveryEndpoints.ResetPasswordPath, new { email, token });
        Assert.Equal("weak_password", await CodeOf(empty));
        Assert.Equal(HttpStatusCode.NoContent, (await host.PostAsync(AuthRecoveryEndpoints.ResetPasswordPath, Reset(email, token))).StatusCode);
    }

    [Fact]
    public async Task ResetPassword_InvalidatesEverySessionIssuedBefore()
    {
        var host = CreateHost();
        var (email, token) = await AccountWithResetTokenAsync(host);
        var firstBrowser = await host.LoginCookieAsync(email);
        var secondBrowser = await host.LoginCookieAsync(email, rememberMe: true);
        Assert.Equal(HttpStatusCode.OK, await host.MeStatusAsync(firstBrowser));
        Assert.Equal(HttpStatusCode.OK, await host.MeStatusAsync(secondBrowser));

        Assert.Equal(HttpStatusCode.NoContent, (await host.PostAsync(AuthRecoveryEndpoints.ResetPasswordPath, Reset(email, token))).StatusCode);

        Assert.Equal(HttpStatusCode.Unauthorized, await host.MeStatusAsync(firstBrowser));
        Assert.Equal(HttpStatusCode.Unauthorized, await host.MeStatusAsync(secondBrowser));
        var fresh = await host.LoginCookieAsync(email, RecoveryHost.NewPassword);
        Assert.Equal(HttpStatusCode.OK, await host.MeStatusAsync(fresh));
    }

    [Fact]
    public async Task ResetPassword_ClearsTheAccountLockout()
    {
        var host = CreateHost();
        var email = await host.RegisterAsync();
        await host.NextEmailAsync();
        for (var i = 0; i < 5; i++)
        {
            await host.LoginAsync(email, "contrasena-equivocada-1");
        }

        Assert.Equal(HttpStatusCode.Unauthorized, (await host.LoginAsync(email)).StatusCode); // bloqueada: ni la correcta entra
        await host.PostAsync(AuthRecoveryEndpoints.ForgotPasswordPath, Forgot(email));
        var token = RecoveryHost.TokenOf(await host.NextEmailAsync(2));

        Assert.Equal(HttpStatusCode.NoContent, (await host.PostAsync(AuthRecoveryEndpoints.ResetPasswordPath, Reset(email, token))).StatusCode);

        Assert.Equal(HttpStatusCode.OK, (await host.LoginAsync(email, RecoveryHost.NewPassword)).StatusCode);
        Assert.Equal(0, await _fixture.ScalarAsync<int>(
            _connectionString, "SELECT \"AccessFailedCount\" FROM auth.\"AspNetUsers\" WHERE \"NormalizedEmail\" = @e", ("e", email.ToUpperInvariant())));
    }

    [Fact]
    public async Task ResetPassword_OnlyTheNewestOfTwoOutstandingTokensSurvives_NoneAfterTheFirstIsUsed()
    {
        var host = CreateHost();
        var (email, first) = await AccountWithResetTokenAsync(host);
        await host.PostAsync(AuthRecoveryEndpoints.ForgotPasswordPath, Forgot(email));
        var second = RecoveryHost.TokenOf(await host.NextEmailAsync(3));

        Assert.Equal(HttpStatusCode.NoContent, (await host.PostAsync(AuthRecoveryEndpoints.ResetPasswordPath, Reset(email, first))).StatusCode);

        Assert.Equal(HttpStatusCode.BadRequest, (await host.PostAsync(AuthRecoveryEndpoints.ResetPasswordPath, Reset(email, second, "una-tercera-contrasena-3"))).StatusCode);
    }

    [Fact]
    public async Task Tokens_AreNotInterchangeable_BetweenResettingAndConfirming()
    {
        var host = CreateHost();
        var (email, resetToken) = await AccountWithResetTokenAsync(host);
        var userId = await host.ScalarStringAsync("SELECT \"Id\"::text FROM auth.\"AspNetUsers\" WHERE \"NormalizedEmail\" = @e", ("e", email.ToUpperInvariant()));
        var confirmationToken = RecoveryHost.TokenOf(host.Email.Messages[0]);

        var confirmWithResetToken = await host.PostAsync(AuthRecoveryEndpoints.ConfirmEmailPath, new ConfirmEmailRequest(userId, null, resetToken));
        var resetWithConfirmationToken = await host.PostAsync(AuthRecoveryEndpoints.ResetPasswordPath, Reset(email, confirmationToken));

        Assert.Equal(HttpStatusCode.BadRequest, confirmWithResetToken.StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, resetWithConfirmationToken.StatusCode);
        Assert.False(await host.EmailConfirmedAsync(email));
    }

    // ------------------------------------------------------------------------------------- confirmación de correo (registro + confirm + resend)

    [Fact]
    public async Task Register_SendsTheConfirmationEmail_AndAnExistingEmailGetsNoneWithTheSameResponse()
    {
        var host = CreateHost();
        var email = RecoveryHost.NewEmail();

        var first = await host.PostAsync(AuthEndpoints.RegisterPath, new RegisterRequest(email, RecoveryHost.Password));
        var mail = await host.NextEmailAsync();
        var second = await host.PostAsync(AuthEndpoints.RegisterPath, new RegisterRequest(email, RecoveryHost.Password));
        await host.SettleAsync();

        Assert.Equal(await ShapeOf(first), await ShapeOf(second));
        Assert.Single(host.Email.Messages); // el segundo registro (correo ya existente) no envía nada
        Assert.Equal(email, mail.To);
        Assert.Contains("Confirmá", mail.Subject, StringComparison.Ordinal);
        var link = RecoveryHost.LinkOf(mail);
        Assert.StartsWith($"{RecoveryHost.PublicBaseUrl}/?view=confirm-email#userId=", link, StringComparison.Ordinal);
        Assert.Contains("24 horas", mail.TextBody, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Register_WhenTheEmailSenderFails_StillReturns202_AndTheAccountCanLogIn()
    {
        var host = CreateHost();
        host.Email.Failure = new InvalidOperationException("SMTP caído");

        var email = await host.RegisterAsync();
        await host.SettleAsync();

        Assert.Empty(host.Email.Messages);
        Assert.Equal(HttpStatusCode.OK, (await host.LoginAsync(email)).StatusCode);
    }

    [Fact]
    public async Task ConfirmEmail_WithAValidToken_ConfirmsTheAccount_AndASecondUseFails()
    {
        var host = CreateHost();
        var email = await host.RegisterAsync();
        var token = RecoveryHost.TokenOf(await host.NextEmailAsync());
        var fragment = RecoveryHost.FragmentOf(RecoveryHost.LinkOf(host.Email.Messages[0]));
        Assert.False(await host.EmailConfirmedAsync(email));

        var ok = await host.PostAsync(AuthRecoveryEndpoints.ConfirmEmailPath, new ConfirmEmailRequest(fragment["userId"], null, token));
        var reused = await host.PostAsync(AuthRecoveryEndpoints.ConfirmEmailPath, new ConfirmEmailRequest(fragment["userId"], null, token));

        Assert.Equal(HttpStatusCode.NoContent, ok.StatusCode);
        Assert.Equal("no-store", ok.Headers.CacheControl?.ToString());
        Assert.True(await host.EmailConfirmedAsync(email));
        Assert.Equal(HttpStatusCode.BadRequest, reused.StatusCode);
        Assert.Equal("invalid_token", await CodeOf(reused));
    }

    [Fact]
    public async Task ConfirmEmail_CanIdentifyTheAccountByEmail_Too()
    {
        var host = CreateHost();
        var email = await host.RegisterAsync();
        var token = RecoveryHost.TokenOf(await host.NextEmailAsync());

        var response = await host.PostAsync(AuthRecoveryEndpoints.ConfirmEmailPath, new ConfirmEmailRequest(null, email, token));

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.True(await host.EmailConfirmedAsync(email));
    }

    [Fact]
    public async Task ConfirmEmail_MalformedForeignAndUnknownTokens_AllGetTheSameGenericAnswer()
    {
        var host = CreateHost();
        var email = await host.RegisterAsync();
        var otherEmail = await host.RegisterAsync();
        var token = RecoveryHost.TokenOf(await host.NextEmailAsync(1));
        var otherToken = RecoveryHost.TokenOf(await host.NextEmailAsync(2));
        var userId = RecoveryHost.FragmentOf(RecoveryHost.LinkOf(host.Email.Messages[0]))["userId"];

        var attempts = new[]
        {
            new ConfirmEmailRequest(userId, null, "basura"),
            new ConfirmEmailRequest(userId, null, token[..(token.Length / 2)]),
            new ConfirmEmailRequest(userId, null, string.Empty),
            new ConfirmEmailRequest(userId, null, otherToken), // token de otra cuenta
            new ConfirmEmailRequest(Guid.NewGuid().ToString(), null, token), // cuenta inexistente
            new ConfirmEmailRequest("no-es-un-guid", null, token),
            new ConfirmEmailRequest(null, null, token), // sin identificador
            new ConfirmEmailRequest(null, RecoveryHost.NewEmail(), token),
        };

        foreach (var attempt in attempts)
        {
            var response = await host.PostAsync(AuthRecoveryEndpoints.ConfirmEmailPath, attempt);
            Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
            Assert.Equal("invalid_token", await CodeOf(response));
        }

        Assert.False(await host.EmailConfirmedAsync(email));
        Assert.False(await host.EmailConfirmedAsync(otherEmail));
    }

    [Fact]
    public async Task ConfirmEmail_AnExpiredToken_IsRejected()
    {
        var host = CreateHost(new Dictionary<string, string?> { ["Auth:Tokens:EmailConfirmationLifetime"] = "00:00:02" });
        var email = await host.RegisterAsync();
        var mail = await host.NextEmailAsync();
        var userId = RecoveryHost.FragmentOf(RecoveryHost.LinkOf(mail))["userId"];

        await Task.Delay(TimeSpan.FromSeconds(3));
        var response = await host.PostAsync(AuthRecoveryEndpoints.ConfirmEmailPath, new ConfirmEmailRequest(userId, null, RecoveryHost.TokenOf(mail)));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.False(await host.EmailConfirmedAsync(email));
    }

    [Fact]
    public async Task TokenLifetimes_DefaultToOneHourForResettingAndTwentyFourForConfirming()
    {
        var host = CreateHost();
        await host.Client.GetAsync("/health");
        var options = host.Factory.Services.GetRequiredService<Microsoft.Extensions.Options.IOptions<Vectorify.Api.Options.AuthOptions>>().Value;

        Assert.Equal(TimeSpan.FromHours(1), options.Tokens.PasswordResetLifetime);
        Assert.Equal(TimeSpan.FromHours(24), options.Tokens.EmailConfirmationLifetime);
        Assert.False(options.RequireConfirmedEmail);
    }

    [Fact]
    public async Task ResendConfirmation_SendsOnlyForAnUnconfirmedAccount_WithAnIdenticalAnswerInEveryCase()
    {
        var host = CreateHost();
        var unconfirmed = await host.RegisterAsync();
        var confirmed = await host.RegisterAsync();
        var userId = RecoveryHost.FragmentOf(RecoveryHost.LinkOf(await host.NextEmailAsync(2)))["userId"];
        Assert.Equal(HttpStatusCode.NoContent, (await host.PostAsync(
            AuthRecoveryEndpoints.ConfirmEmailPath, new ConfirmEmailRequest(userId, null, RecoveryHost.TokenOf(host.Email.Messages[1])))).StatusCode);
        Assert.True(await host.EmailConfirmedAsync(confirmed));
        var before = host.Email.Messages.Count;

        var forUnconfirmed = await host.PostAsync(AuthRecoveryEndpoints.ResendConfirmationPath, new ResendConfirmationRequest(unconfirmed));
        var forConfirmed = await host.PostAsync(AuthRecoveryEndpoints.ResendConfirmationPath, new ResendConfirmationRequest(confirmed));
        var forUnknown = await host.PostAsync(AuthRecoveryEndpoints.ResendConfirmationPath, new ResendConfirmationRequest(RecoveryHost.NewEmail()));
        await host.SettleAsync();

        var shape = await ShapeOf(forUnconfirmed);
        Assert.Equal(HttpStatusCode.Accepted, shape.Status);
        Assert.Equal(shape, await ShapeOf(forConfirmed));
        Assert.Equal(shape, await ShapeOf(forUnknown));
        Assert.Equal(before + 1, host.Email.Messages.Count);
        Assert.Equal(unconfirmed, host.Email.Messages[^1].To);
        Assert.Contains("confirm-email", RecoveryHost.LinkOf(host.Email.Messages[^1]), StringComparison.Ordinal);
    }

    [Fact]
    public async Task ResendConfirmation_MalformedEmail_Is400InvalidEmail()
    {
        var host = CreateHost();

        var response = await host.PostAsync(AuthRecoveryEndpoints.ResendConfirmationPath, new ResendConfirmationRequest("no-es-un-correo"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("invalid_email", await CodeOf(response));
    }

    // ------------------------------------------------------------------------------------------ Auth:RequireConfirmedEmail

    [Fact]
    public async Task Login_WithRequireConfirmedEmailFalse_LetsAnUnconfirmedAccountIn()
    {
        var host = CreateHost();
        var email = await host.RegisterAsync();

        Assert.Equal(HttpStatusCode.OK, (await host.LoginAsync(email)).StatusCode);
    }

    [Fact]
    public async Task Login_WithRequireConfirmedEmailTrue_RejectsAnUnconfirmedAccountWithTheUniform401_UntilItIsConfirmed()
    {
        var host = CreateHost(new Dictionary<string, string?> { ["Auth:RequireConfirmedEmail"] = "true" });
        var email = await host.RegisterAsync();
        var mail = await host.NextEmailAsync();

        var unconfirmed = await host.LoginAsync(email);
        var wrongPassword = await host.LoginAsync(email, "contrasena-equivocada-1");
        var unknown = await host.LoginAsync(RecoveryHost.NewEmail());

        Assert.Equal(HttpStatusCode.Unauthorized, unconfirmed.StatusCode);
        var shape = await ShapeOf(unconfirmed);
        Assert.Equal(shape, await ShapeOf(wrongPassword)); // idéntico a «contraseña errónea»: no delata que falta confirmar
        Assert.Equal(shape, await ShapeOf(unknown));
        Assert.Empty(RecoveryHost.SessionSetCookies(unconfirmed));

        // El reenvío sigue funcionando con la confirmación obligatoria.
        await host.PostAsync(AuthRecoveryEndpoints.ResendConfirmationPath, new ResendConfirmationRequest(email));
        var resent = await host.NextEmailAsync(2);
        var userId = RecoveryHost.FragmentOf(RecoveryHost.LinkOf(resent))["userId"];
        Assert.Equal(HttpStatusCode.NoContent, (await host.PostAsync(
            AuthRecoveryEndpoints.ConfirmEmailPath, new ConfirmEmailRequest(userId, null, RecoveryHost.TokenOf(resent)))).StatusCode);

        Assert.Equal(HttpStatusCode.OK, (await host.LoginAsync(email)).StatusCode);
        Assert.NotEmpty(mail.TextBody);
    }

    // ------------------------------------------------------------------------------------------------------- change-password

    [Fact]
    public async Task ChangePassword_WithoutASession_Is401_AndWithoutCsrfIs403()
    {
        var host = CreateHost();

        var anonymous = await host.PostAsync(AuthRecoveryEndpoints.ChangePasswordPath, new ChangePasswordRequest(RecoveryHost.Password, RecoveryHost.NewPassword));
        Assert.Equal(HttpStatusCode.Unauthorized, anonymous.StatusCode);

        var email = await host.RegisterAsync();
        var cookie = await host.LoginCookieAsync(email);
        using var withoutCsrf = host.Factory.CreateClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { HandleCookies = false });
        using var noCsrfRequest = new HttpRequestMessage(HttpMethod.Post, AuthRecoveryEndpoints.ChangePasswordPath)
        {
            Content = JsonContent.Create(new ChangePasswordRequest(RecoveryHost.Password, RecoveryHost.NewPassword)),
        };
        noCsrfRequest.Headers.Add("Cookie", cookie);
        var noCsrf = await withoutCsrf.SendAsync(noCsrfRequest);
        Assert.Equal(HttpStatusCode.Forbidden, noCsrf.StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await host.LoginAsync(email)).StatusCode); // no cambió nada
    }

    [Fact]
    public async Task ChangePassword_WithTheWrongCurrentPassword_Is400InvalidCurrentPassword_NeverA401_AndTheSessionSurvives()
    {
        var host = CreateHost();
        var email = await host.RegisterAsync();
        var cookie = await host.LoginCookieAsync(email);

        var response = await host.PostAsync(
            AuthRecoveryEndpoints.ChangePasswordPath, new ChangePasswordRequest("contrasena-equivocada-1", RecoveryHost.NewPassword), cookie);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("invalid_current_password", await CodeOf(response));
        Assert.Equal(HttpStatusCode.OK, await host.MeStatusAsync(cookie)); // la sesión sigue viva
        Assert.Equal(HttpStatusCode.OK, (await host.LoginAsync(email)).StatusCode); // la contraseña no cambió
    }

    [Fact]
    public async Task ChangePassword_WithAWeakNewPassword_Is400WeakPassword()
    {
        var host = CreateHost();
        var email = await host.RegisterAsync();
        var cookie = await host.LoginCookieAsync(email);

        foreach (var weak in new[] { "corta", string.Empty, new string('x', 129) })
        {
            var response = await host.PostAsync(
                AuthRecoveryEndpoints.ChangePasswordPath, new ChangePasswordRequest(RecoveryHost.Password, weak), cookie);
            Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
            Assert.Equal("weak_password", await CodeOf(response));
        }

        Assert.Equal(HttpStatusCode.OK, await host.MeStatusAsync(cookie));
    }

    [Fact]
    public async Task ChangePassword_Succeeds_KeepsTheCurrentSessionAlive_AndKillsEveryOtherOne()
    {
        var host = CreateHost();
        var email = await host.RegisterAsync();
        var current = await host.LoginCookieAsync(email);
        var otherDevice = await host.LoginCookieAsync(email);
        var stampBefore = await host.StampAsync(email);

        var response = await host.PostAsync(
            AuthRecoveryEndpoints.ChangePasswordPath, new ChangePasswordRequest(RecoveryHost.Password, RecoveryHost.NewPassword), current);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Contains("no-store", response.Headers.CacheControl?.ToString(), StringComparison.Ordinal); // el handler de cookies añade no-cache al emitir la cookie
        Assert.NotEqual(stampBefore, await host.StampAsync(email));
        var reissued = RecoveryHost.CookieOf(response); // la cookie de ESTA sesión se re-emitió con el stamp nuevo
        Assert.Equal(HttpStatusCode.OK, await host.MeStatusAsync(reissued));
        Assert.Equal(HttpStatusCode.Unauthorized, await host.MeStatusAsync(current)); // la cookie anterior ya no vale
        Assert.Equal(HttpStatusCode.Unauthorized, await host.MeStatusAsync(otherDevice));
        Assert.Equal(HttpStatusCode.OK, (await host.LoginAsync(email, RecoveryHost.NewPassword)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await host.LoginAsync(email, RecoveryHost.Password)).StatusCode);
    }

    [Fact]
    public async Task ChangePassword_OnARememberedSession_ReissuesAPersistentCookie_WithTheOriginalAbsoluteCap()
    {
        var host = CreateHost();
        var email = await host.RegisterAsync();
        var login = await host.LoginAsync(email, rememberMe: true);
        var loginCookie = Assert.Single(RecoveryHost.SessionSetCookies(login));
        var originalExpiry = ExpiresOf(loginCookie);

        await Task.Delay(TimeSpan.FromSeconds(2));
        var response = await host.PostAsync(
            AuthRecoveryEndpoints.ChangePasswordPath,
            new ChangePasswordRequest(RecoveryHost.Password, RecoveryHost.NewPassword),
            RecoveryHost.CookieOf(login));

        var reissued = Assert.Single(RecoveryHost.SessionSetCookies(response));
        Assert.Equal(originalExpiry, ExpiresOf(reissued), TimeSpan.FromSeconds(1)); // el tope de «recordarme» NO se reinicia
        Assert.Equal(HttpStatusCode.OK, await host.MeStatusAsync(RecoveryHost.CookieOf(response)));
    }

    [Fact]
    public async Task ChangePassword_RepeatedWrongCurrentPasswords_CountTowardsTheLockout()
    {
        var host = CreateHost();
        var email = await host.RegisterAsync();
        var cookie = await host.LoginCookieAsync(email);

        for (var i = 0; i < 5; i++)
        {
            var response = await host.PostAsync(
                AuthRecoveryEndpoints.ChangePasswordPath, new ChangePasswordRequest("contrasena-equivocada-1", RecoveryHost.NewPassword), cookie);
            Assert.Equal("invalid_current_password", await CodeOf(response));
        }

        // Cuenta bloqueada: ni siquiera la contraseña actual correcta cambia nada con una sesión robada, y sigue siendo un 400 (no un 401).
        var blocked = await host.PostAsync(
            AuthRecoveryEndpoints.ChangePasswordPath, new ChangePasswordRequest(RecoveryHost.Password, RecoveryHost.NewPassword), cookie);
        Assert.Equal(HttpStatusCode.BadRequest, blocked.StatusCode);
        Assert.Equal("invalid_current_password", await CodeOf(blocked));
    }

    private static DateTimeOffset ExpiresOf(string setCookie)
    {
        var expires = setCookie.Split(';').Select(a => a.Trim()).Single(a => a.StartsWith("expires=", StringComparison.OrdinalIgnoreCase))["expires=".Length..];
        return DateTimeOffset.Parse(expires, System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.AssumeUniversal);
    }
}

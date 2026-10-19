using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using Vectorify.Api.Contracts;
using Vectorify.Api.Endpoints;
using Vectorify.Api.Tests.TestSupport;

namespace Vectorify.Api.Tests.EndToEnd;

/// <summary>
/// Evidencia ejecutable de la revisión de amenazas de M3.1-S09 (docs/AUTH_SECURITY_REVIEW.md) para lo que no tenía test: fijación de sesión (T2), sesión solo por cookie (no por URL/cabecera),
/// separación de propósito de los tokens (T15, repetición), enumeración de cuentas por respuestas y por TIEMPOS (T5), enlaces de correo que no dependen de la request (open redirect) y atributos de la cookie en
/// Production (T1). El resto de la tabla T1–T15 remite a los tests de S02–S08 (ver el documento).
/// </summary>
[Collection(AuthRecoveryCollection.Name)]
public sealed class AuthThreatReviewTests : IAsyncLifetime
{
    private const string Wrong = "una-contrasena-erronea-9";

    private readonly AuthApiFixture _fixture;
    private readonly List<RecoveryHost> _hosts = [];
    private string _connectionString = string.Empty;

    public AuthThreatReviewTests(AuthApiFixture fixture)
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

    private RecoveryHost CreateHost(IDictionary<string, string?>? settings = null, string? environment = null, bool pooled = false)
    {
        // AuthApiFixture entrega cadenas SIN pool (cada consulta abre una conexión nueva con SCRAM, ~30 ms en Windows): para medir tiempos hay que usar el pool, como el servidor real.
        var connectionString = pooled
            ? new Npgsql.NpgsqlConnectionStringBuilder(_connectionString) { Pooling = true, MaxPoolSize = 20 }.ConnectionString
            : _connectionString;
        var host = RecoveryHost.Create(_fixture, connectionString, settings, environment: environment);
        _hosts.Add(host);
        return host;
    }

    private static async Task<string> Shape(HttpResponseMessage response)
    {
        var names = response.Headers.Select(h => h.Key)
            .Concat(response.Content.Headers.Select(h => h.Key))
            .Where(name => !name.Equals("Date", StringComparison.OrdinalIgnoreCase) && !name.Equals("X-Correlation-Id", StringComparison.OrdinalIgnoreCase))
            .Order(StringComparer.OrdinalIgnoreCase);
        return $"{(int)response.StatusCode} | {string.Join(",", names)} | {await response.Content.ReadAsStringAsync()}";
    }

    // ----------------------------------------------------------------------------------------------------- T2 fijación de sesión

    [Fact]
    public async Task SessionFixation_ALoginAlwaysIssuesAFreshCookie_AndNeverAdoptsOneChosenByTheClient()
    {
        var host = CreateHost();
        var email = await host.RegisterAsync();
        const string attackerChosen = "valor-elegido-por-el-atacante-0123456789";

        var login = await host.PostAsync(
            AuthEndpoints.LoginPath, new LoginRequest(email, RecoveryHost.Password), cookie: $"{RecoveryHost.CookieName}={attackerChosen}");

        Assert.Equal(HttpStatusCode.OK, login.StatusCode);
        var issued = RecoveryHost.CookieOf(login);
        Assert.NotEqual($"{RecoveryHost.CookieName}={attackerChosen}", issued);
        Assert.DoesNotContain(attackerChosen, issued);
        Assert.Equal(HttpStatusCode.Unauthorized, await host.MeStatusAsync($"{RecoveryHost.CookieName}={attackerChosen}")); // el valor del atacante no es una sesión
        Assert.Equal(HttpStatusCode.OK, await host.MeStatusAsync(issued));
    }

    [Fact]
    public async Task SessionFixation_ALoginWhileHoldingASession_IssuesADifferentCookie_EachTime()
    {
        var host = CreateHost();
        var email = await host.RegisterAsync();
        var first = await host.LoginCookieAsync(email);

        var secondResponse = await host.PostAsync(AuthEndpoints.LoginPath, new LoginRequest(email, RecoveryHost.Password), cookie: first);
        var second = RecoveryHost.CookieOf(secondResponse);
        var third = await host.LoginCookieAsync(email);

        Assert.NotEqual(first, second);
        Assert.NotEqual(second, third);
        Assert.NotEqual(first, third);
    }

    [Fact]
    public async Task TheSession_IsOnlyReadFromTheCookie_NeverFromTheUrlOrFromAnotherHeader()
    {
        var host = CreateHost();
        var email = await host.RegisterAsync();
        var cookie = await host.LoginCookieAsync(email);
        var value = cookie[(cookie.IndexOf('=') + 1)..];

        var viaQuery = await host.Client.GetAsync($"{AuthEndpoints.MePath}?{RecoveryHost.CookieName}={Uri.EscapeDataString(value)}&access_token={Uri.EscapeDataString(value)}");
        var viaBearer = new HttpRequestMessage(HttpMethod.Get, AuthEndpoints.MePath);
        viaBearer.Headers.TryAddWithoutValidation("Authorization", "Bearer " + value);
        var viaCustomHeader = new HttpRequestMessage(HttpMethod.Get, AuthEndpoints.MePath);
        viaCustomHeader.Headers.TryAddWithoutValidation("X-Session", value);
        viaCustomHeader.Headers.TryAddWithoutValidation(RecoveryHost.CookieName, value);

        Assert.Equal(HttpStatusCode.Unauthorized, viaQuery.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await host.Client.SendAsync(viaBearer)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await host.Client.SendAsync(viaCustomHeader)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, await host.MeStatusAsync(cookie)); // la cookie real sí
    }

    // ------------------------------------------------------------------------------------------- T15 tokens: propósito y repetición

    [Fact]
    public async Task Tokens_AResetTokenIsNotAConfirmationToken_AndViceVersa()
    {
        var host = CreateHost();
        var email = await host.RegisterAsync();
        var confirmMail = await host.NextEmailAsync();
        var confirmToken = RecoveryHost.TokenOf(confirmMail);
        var accountId = RecoveryHost.FragmentOf(RecoveryHost.LinkOf(confirmMail))["userId"];
        await host.PostAsync(AuthRecoveryEndpoints.ForgotPasswordPath, new ForgotPasswordRequest(email));
        var resetMail = await host.NextEmailAsync(2);
        var resetToken = RecoveryHost.TokenOf(resetMail);

        // El token de confirmación no sirve para restablecer la contraseña, y el de restablecer no confirma el correo.
        var resetWithConfirmToken = await host.PostAsync(AuthRecoveryEndpoints.ResetPasswordPath, new ResetPasswordRequest(email, confirmToken, RecoveryHost.NewPassword));
        var confirmWithResetToken = await host.PostAsync(AuthRecoveryEndpoints.ConfirmEmailPath, new ConfirmEmailRequest(accountId, null, resetToken));

        Assert.Equal(HttpStatusCode.BadRequest, resetWithConfirmToken.StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, confirmWithResetToken.StatusCode);
        Assert.False(await host.EmailConfirmedAsync(email));
        Assert.Equal(HttpStatusCode.OK, (await host.LoginAsync(email, RecoveryHost.Password)).StatusCode); // la contraseña no cambió

        // Y cada uno sigue sirviendo para lo suyo, UNA vez.
        Assert.Equal(HttpStatusCode.NoContent, (await host.PostAsync(AuthRecoveryEndpoints.ConfirmEmailPath, new ConfirmEmailRequest(accountId, null, confirmToken))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await host.PostAsync(AuthRecoveryEndpoints.ConfirmEmailPath, new ConfirmEmailRequest(accountId, null, confirmToken))).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await host.PostAsync(AuthRecoveryEndpoints.ResetPasswordPath, new ResetPasswordRequest(email, resetToken, RecoveryHost.NewPassword))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await host.PostAsync(AuthRecoveryEndpoints.ResetPasswordPath, new ResetPasswordRequest(email, resetToken, "tercera-contrasena-larga-3"))).StatusCode);
    }

    [Fact]
    public async Task Tokens_AResetTokenOfOneAccountDoesNotWorkForAnother()
    {
        var host = CreateHost();
        var victim = await host.RegisterAsync();
        var attacker = await host.RegisterAsync();
        await host.PostAsync(AuthRecoveryEndpoints.ForgotPasswordPath, new ForgotPasswordRequest(attacker));
        await host.SettleAsync();
        var attackerToken = RecoveryHost.TokenOf(host.Email.Messages.Last(m => m.To.Equals(attacker, StringComparison.OrdinalIgnoreCase) && m.TextBody.Contains("reset-password", StringComparison.Ordinal)));

        var response = await host.PostAsync(AuthRecoveryEndpoints.ResetPasswordPath, new ResetPasswordRequest(victim, attackerToken, "contrasena-del-atacante-1"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await host.LoginAsync(victim, RecoveryHost.Password)).StatusCode);
    }

    // ----------------------------------------------------------------------------------------------- T5 enumeración: respuestas

    [Fact]
    public async Task Enumeration_ResponsesAreIndistinguishable_ForAnExistingAndAnUnknownAddress_OnEveryAnonymousRoute()
    {
        var host = CreateHost();
        var existing = await host.RegisterAsync();
        var unknown = RecoveryHost.NewEmail();

        async Task<string> Run(Func<string, Task<HttpResponseMessage>> call, string email) => await Shape(await call(email));

        var scenarios = new (string Name, Func<string, Task<HttpResponseMessage>> Call)[]
        {
            ("register", e => host.PostAsync(AuthEndpoints.RegisterPath, new RegisterRequest(e, RecoveryHost.Password))),
            ("login", e => host.PostAsync(AuthEndpoints.LoginPath, new LoginRequest(e, Wrong))),
            ("forgot-password", e => host.PostAsync(AuthRecoveryEndpoints.ForgotPasswordPath, new ForgotPasswordRequest(e))),
            ("resend-confirmation", e => host.PostAsync(AuthRecoveryEndpoints.ResendConfirmationPath, new ResendConfirmationRequest(e))),
            ("reset-password", e => host.PostAsync(AuthRecoveryEndpoints.ResetPasswordPath, new ResetPasswordRequest(e, "token-que-no-existe", "otra-contrasena-larga-5"))),
            ("confirm-email", e => host.PostAsync(AuthRecoveryEndpoints.ConfirmEmailPath, new ConfirmEmailRequest(null, e, "token-que-no-existe"))),
        };

        foreach (var (name, call) in scenarios)
        {
            Assert.Equal(await Run(call, unknown), await Run(call, existing));
        }
    }

    [Fact]
    public async Task Enumeration_ALockedAccount_ReturnsTheSame401AsAWrongPasswordAndAnUnknownAccount()
    {
        var host = CreateHost(new Dictionary<string, string?> { ["Auth:Lockout:MaxAttempts"] = "2" });
        var locked = await host.RegisterAsync();
        await host.LoginAsync(locked, Wrong);
        await host.LoginAsync(locked, Wrong);

        var shapeOfLocked = await Shape(await host.LoginAsync(locked, RecoveryHost.Password)); // ni la contraseña correcta entra
        var shapeOfUnknown = await Shape(await host.LoginAsync(RecoveryHost.NewEmail(), RecoveryHost.Password));
        var shapeOfWrong = await Shape(await host.LoginAsync(await host.RegisterAsync(), Wrong));

        Assert.StartsWith("401", shapeOfLocked);
        Assert.Equal(shapeOfUnknown, shapeOfLocked);
        Assert.Equal(shapeOfWrong, shapeOfLocked);
    }

    // ------------------------------------------------------------------------------------------------ T5 enumeración: tiempos

    /// <summary>
    /// Tiempos del LOGIN: las tres ramas de fallo (cuenta inexistente, contraseña errónea, cuenta bloqueada) hacen el mismo trabajo caro (el hash adaptativo), así que ninguna es mucho más rápida
    /// que otra. Mediana de varias muestras intercaladas y umbral generoso (0.5×) a propósito: no es un microbenchmark, detecta que alguna rama SALTE el hash (lo que sí se distinguiría desde fuera).
    /// Antes de M3.1-S09 la cuenta bloqueada no hasheaba: bloqueando un correo a propósito se distinguía «existe» de «no existe» por el tiempo.
    /// </summary>
    [Fact]
    public async Task Enumeration_LoginTimings_OfUnknownWrongPasswordAndLockedAccounts_ArePracticallyTheSame()
    {
        // Umbral de bloqueo altísimo: la cuenta «contraseña errónea» recibe decenas de fallos y NO debe acabar bloqueada (si no, mediría la rama equivocada); la bloqueada se bloquea directamente en la base.
        var host = CreateHost(new Dictionary<string, string?>
        {
            ["Auth:Lockout:MaxAttempts"] = "100000",
            ["Auth:Lockout:Duration"] = "01:00:00",
            ["Logging:LogLevel:Default"] = "Warning", // el Trace de los demás tests multiplica el coste de cada consulta y falsea la medición
            ["Logging:LogLevel:Microsoft"] = "Warning",
        }, pooled: true);
        var wrongPasswordAccount = await host.RegisterAsync();
        var lockedAccount = await host.RegisterAsync();
        await host.Fixture.ScalarAsync<int>(
            host.ConnectionString,
            "UPDATE auth.\"AspNetUsers\" SET \"LockoutEnd\" = now() + interval '1 hour', \"LockoutEnabled\" = true WHERE \"NormalizedEmail\" = @e RETURNING 1",
            ("e", lockedAccount.ToUpperInvariant()));
        Assert.Equal(HttpStatusCode.Unauthorized, (await host.LoginAsync(lockedAccount, RecoveryHost.Password)).StatusCode); // bloqueada de verdad: ni la contraseña correcta entra

        // Calentamiento (JIT, caché de EF, conexiones).
        for (var i = 0; i < 3; i++)
        {
            await host.LoginAsync(RecoveryHost.NewEmail(), Wrong);
            await host.LoginAsync(lockedAccount, Wrong);
        }

        var unknown = new List<double>();
        var wrong = new List<double>();
        var locked = new List<double>();
        const int samples = 9;
        for (var i = 0; i < samples; i++)
        {
            unknown.Add(await TimeAsync(() => host.LoginAsync(RecoveryHost.NewEmail(), Wrong)));
            locked.Add(await TimeAsync(() => host.LoginAsync(lockedAccount, Wrong)));
            wrong.Add(await TimeAsync(() => host.PostAsync(AuthEndpoints.LoginPath, new LoginRequest(wrongPasswordAccount, Wrong))));
        }

        var medianUnknown = Median(unknown);
        var medianWrong = Median(wrong);
        var medianLocked = Median(locked);
        var report = $"inexistente={medianUnknown:F1} ms, contraseña errónea={medianWrong:F1} ms, bloqueada={medianLocked:F1} ms";

        Assert.True(medianUnknown >= medianWrong * 0.5, "Una cuenta inexistente responde claramente más rápido que una real: " + report);
        Assert.True(medianLocked >= medianWrong * 0.5, "Una cuenta bloqueada responde claramente más rápido que una real: " + report);
        Assert.True(medianWrong >= medianUnknown * 0.5 && medianWrong >= medianLocked * 0.5, "Una cuenta real responde claramente más rápido que las otras: " + report);
    }

    private static async Task<double> TimeAsync(Func<Task<HttpResponseMessage>> call)
    {
        var watch = Stopwatch.StartNew();
        using var response = await call();
        watch.Stop();
        return watch.Elapsed.TotalMilliseconds;
    }

    private static double Median(List<double> values)
    {
        var sorted = values.Order().ToList();
        return sorted[sorted.Count / 2];
    }

    // ------------------------------------------------------------------------------------------------- open redirect (enlaces)

    [Fact]
    public async Task EmailLinks_AlwaysPointToTheConfiguredPublicBaseUrl_NeverToTheHostOrOriginOfTheRequest()
    {
        var host = CreateHost();
        var email = await host.RegisterAsync();
        await host.NextEmailAsync();

        var response = await host.PostAsync(
            AuthRecoveryEndpoints.ForgotPasswordPath,
            new ForgotPasswordRequest(email),
            configure: request =>
            {
                request.Headers.Host = "evil.example";
                request.Headers.TryAddWithoutValidation("X-Forwarded-Host", "evil.example");
                request.Headers.TryAddWithoutValidation("Referer", "https://evil.example/phish");
            });
        var link = RecoveryHost.LinkOf(await host.NextEmailAsync(2));

        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        Assert.StartsWith(RecoveryHost.PublicBaseUrl + "/", link, StringComparison.Ordinal);
        Assert.DoesNotContain("evil.example", link, StringComparison.OrdinalIgnoreCase);
    }

    // -------------------------------------------------------------------------------------------------- T1 cookie en Production

    [Fact]
    public async Task ProductionCookie_HasTheHostPrefix_Secure_HttpOnly_SameSiteLax_PathRoot_AndNoDomain()
    {
        var host = CreateHost(
            new Dictionary<string, string?>
            {
                ["Auth:Email:Mode"] = "Disabled",
                ["Auth:DataProtection:KeysPath"] = Path.Combine(Path.GetTempPath(), "vectorify-s09-keys-" + Guid.NewGuid().ToString("N")),
            },
            environment: "Production");
        var email = RecoveryHost.NewEmail();
        Assert.Equal(HttpStatusCode.Accepted, (await host.PostAsync(AuthEndpoints.RegisterPath, new RegisterRequest(email, RecoveryHost.Password))).StatusCode);

        var login = await host.LoginAsync(email);

        Assert.Equal(HttpStatusCode.OK, login.StatusCode);
        var setCookie = Assert.Single(login.Headers.GetValues("Set-Cookie"));
        Assert.StartsWith("__Host-vectorify.session=", setCookie, StringComparison.Ordinal);
        var attributes = setCookie.ToLowerInvariant();
        Assert.Contains("; secure", attributes);
        Assert.Contains("; httponly", attributes);
        Assert.Contains("samesite=lax", attributes);
        Assert.Contains("path=/", attributes);
        Assert.DoesNotContain("domain=", attributes);
        Assert.True(login.Headers.CacheControl?.NoStore == true); // el handler de cookies añade además no-cache al emitirla
    }
}

using System.Net;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Text.RegularExpressions;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Vectorify.Api.Contracts;
using Vectorify.Api.Endpoints;
using Vectorify.Api.Options;
using Vectorify.Api.Tests.TestSupport;

namespace Vectorify.Api.Tests.EndToEnd;

/// <summary>
/// Entrega REAL por SMTP (M3.1-S08): <c>Auth:Email:Mode=Smtp</c> habla el protocolo por TCP con un servidor falso en proceso (<see cref="FakeSmtpServer"/>, sumidero tipo Mailpit) y los
/// flujos completos registro→confirmar y olvidé→restablecer→entrar se hacen con los enlaces que llegaron AL SUMIDERO. También: fallos del SMTP, logs sin PII, modo Log y arranque en Production.
/// </summary>
[Collection(AuthRecoveryCollection.Name)]
public sealed class AuthRecoverySmtpTests : IAsyncLifetime
{
    private const string SmtpUser = "mailer";
    private const string SmtpPassword = "clave-smtp-solo-de-entorno-9f3";

    private readonly AuthApiFixture _fixture;
    private readonly List<RecoveryHost> _hosts = [];
    private readonly List<FakeSmtpServer> _servers = [];
    private readonly List<string> _directories = [];
    private string _connectionString = string.Empty;

    public AuthRecoverySmtpTests(AuthApiFixture fixture)
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

        foreach (var server in _servers)
        {
            await server.DisposeAsync();
        }

        foreach (var directory in _directories.Where(Directory.Exists))
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private FakeSmtpServer StartSmtp(bool requireAuth = true, bool rejectRecipients = false)
    {
        var server = new FakeSmtpServer(requireAuth, rejectRecipients).Start();
        _servers.Add(server);
        return server;
    }

    private static Dictionary<string, string?> SmtpSettings(int port) => new()
    {
        ["Auth:Email:Mode"] = "Smtp",
        ["Auth:Email:FromAddress"] = "no-reply@vectorify.test",
        ["Auth:Email:FromName"] = "Vectorify",
        ["Auth:Email:Smtp:Host"] = "127.0.0.1",
        ["Auth:Email:Smtp:Port"] = port.ToString(System.Globalization.CultureInfo.InvariantCulture),
        ["Auth:Email:Smtp:Security"] = "None", // sumidero local sin TLS: solo permitido en entornos de desarrollo
        ["Auth:Email:Smtp:UserName"] = SmtpUser,
        ["Auth:Email:Smtp:Password"] = SmtpPassword,
        ["Auth:Email:Smtp:Timeout"] = "00:00:05",
    };

    private RecoveryHost CreateSmtpHost(int port, Microsoft.Extensions.Logging.ILoggerProvider? logs = null, Action<IDictionary<string, string?>>? tweak = null)
    {
        var settings = SmtpSettings(port);
        tweak?.Invoke(settings);
        var host = RecoveryHost.Create(_fixture, _connectionString, settings, captureEmail: false, logProvider: logs);
        _hosts.Add(host);
        return host;
    }

    private static int FreePort()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
    }

    // ------------------------------------------------------------------------------------------- flujos completos por SMTP real

    [Fact]
    public async Task Register_Then_ConfirmEmail_UsingTheLinkThatReachedTheSink()
    {
        var smtp = StartSmtp();
        var host = CreateSmtpHost(smtp.Port);

        var email = await host.RegisterAsync();
        var mails = await smtp.WaitForMailsAsync(1);

        var mail = Assert.Single(mails);
        Assert.Equal("no-reply@vectorify.test", mail.From);
        Assert.Equal([email], mail.Recipients);
        Assert.Equal("Confirmá tu correo en Vectorify", mail.Subject);
        Assert.Contains("multipart/alternative", mail.Raw, StringComparison.OrdinalIgnoreCase); // texto plano + HTML
        Assert.NotNull(mail.TextBody);
        Assert.NotNull(mail.HtmlBody);
        Assert.Contains("Gracias por crear tu cuenta", mail.TextBody, StringComparison.Ordinal);
        Assert.Equal((SmtpUser, SmtpPassword), Assert.Single(smtp.Logins.Distinct())); // las credenciales SMTP viajaron por el protocolo

        var textLink = Regex.Match(mail.TextBody!, @"https?://\S+").Value;
        var htmlLink = System.Net.WebUtility.HtmlDecode(Regex.Match(mail.HtmlBody!, "href=\"([^\"]+)\"").Groups[1].Value);
        Assert.Equal(textLink, htmlLink); // el HTML enlaza exactamente a lo mismo
        Assert.StartsWith($"{RecoveryHost.PublicBaseUrl}/?view=confirm-email#userId=", textLink, StringComparison.Ordinal);
        Assert.DoesNotContain("<img", mail.HtmlBody, StringComparison.OrdinalIgnoreCase);

        var fragment = RecoveryHost.FragmentOf(textLink);
        var confirm = await host.PostAsync(AuthRecoveryEndpoints.ConfirmEmailPath, new ConfirmEmailRequest(fragment["userId"], null, fragment["token"]));
        Assert.Equal(HttpStatusCode.NoContent, confirm.StatusCode);
        Assert.True(await host.EmailConfirmedAsync(email));
    }

    [Fact]
    public async Task Forgot_Then_Reset_Then_Login_UsingTheLinkThatReachedTheSink()
    {
        var smtp = StartSmtp();
        var host = CreateSmtpHost(smtp.Port);
        var email = await host.RegisterAsync();
        await smtp.WaitForMailsAsync(1);

        var forgot = await host.PostAsync(AuthRecoveryEndpoints.ForgotPasswordPath, new ForgotPasswordRequest(email));
        var mails = await smtp.WaitForMailsAsync(2);

        Assert.Equal(HttpStatusCode.Accepted, forgot.StatusCode);
        var mail = mails[1];
        Assert.Equal("Restablecé tu contraseña de Vectorify", mail.Subject);
        Assert.Contains("1 hora", mail.TextBody, StringComparison.Ordinal);
        Assert.Contains("ignorá este mensaje", mail.TextBody, StringComparison.Ordinal);
        var link = Regex.Match(mail.TextBody!, @"https?://\S+").Value;
        Assert.StartsWith($"{RecoveryHost.PublicBaseUrl}/?view=reset-password#email=", link, StringComparison.Ordinal);
        var fragment = RecoveryHost.FragmentOf(link);
        Assert.Equal(email, fragment["email"]);

        var reset = await host.PostAsync(AuthRecoveryEndpoints.ResetPasswordPath, new ResetPasswordRequest(fragment["email"], fragment["token"], RecoveryHost.NewPassword));
        Assert.Equal(HttpStatusCode.NoContent, reset.StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await host.LoginAsync(email, RecoveryHost.NewPassword)).StatusCode);

        var again = await host.PostAsync(AuthRecoveryEndpoints.ResetPasswordPath, new ResetPasswordRequest(fragment["email"], fragment["token"], "una-tercera-contrasena-3"));
        Assert.Equal(HttpStatusCode.BadRequest, again.StatusCode); // el enlace del correo sirve una sola vez
    }

    [Fact]
    public async Task ForgotPassword_ForAnUnknownEmail_SendsNothingToTheSink()
    {
        var smtp = StartSmtp();
        var host = CreateSmtpHost(smtp.Port);

        var response = await host.PostAsync(AuthRecoveryEndpoints.ForgotPasswordPath, new ForgotPasswordRequest(RecoveryHost.NewEmail()));
        await host.SettleAsync();

        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        Assert.Empty(smtp.Mails);
    }

    // ------------------------------------------------------------------------------------------------ fallos del SMTP y logs

    [Fact]
    public async Task WhenTheSmtpServerIsDown_RegistrationAndForgotStillSucceed_AndTheFailureIsLoggedWithoutPersonalData()
    {
        var logs = new CapturingLoggerProvider();
        var host = CreateSmtpHost(FreePort(), logs); // nadie escucha en ese puerto

        var email = await host.RegisterAsync();
        var forgot = await host.PostAsync(AuthRecoveryEndpoints.ForgotPasswordPath, new ForgotPasswordRequest(email));
        await host.SettleAsync();

        Assert.Equal(HttpStatusCode.Accepted, forgot.StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await host.LoginAsync(email)).StatusCode); // la cuenta se creó
        var failures = logs.Entries.Where(e => e.Contains("no se pudo enviar", StringComparison.Ordinal)).ToList();
        Assert.Equal(2, failures.Count);
        AssertNoSecrets(logs, email, SmtpPassword, RecoveryHost.Password);
    }

    [Fact]
    public async Task WhenTheSmtpServerRejectsTheRecipient_ForgotStill202_AndTheLogsCarryNoAddress()
    {
        var logs = new CapturingLoggerProvider();
        var smtp = StartSmtp(rejectRecipients: true);
        var host = CreateSmtpHost(smtp.Port, logs);
        var email = await host.RegisterAsync();

        var forgot = await host.PostAsync(AuthRecoveryEndpoints.ForgotPasswordPath, new ForgotPasswordRequest(email));
        await host.SettleAsync();

        Assert.Equal(HttpStatusCode.Accepted, forgot.StatusCode);
        Assert.Empty(smtp.Mails);
        Assert.Contains(logs.Entries, e => e.Contains("no se pudo enviar", StringComparison.Ordinal) && e.Contains("SMTP 550", StringComparison.Ordinal));
        AssertNoSecrets(logs, email, SmtpPassword, RecoveryHost.Password);
    }

    [Fact]
    public async Task NoLogEntry_AcrossTheWholeRecoveryFlow_ContainsTheEmailTheTokensOrAnyPassword()
    {
        var logs = new CapturingLoggerProvider();
        var smtp = StartSmtp();
        var host = CreateSmtpHost(smtp.Port, logs);
        var email = await host.RegisterAsync();
        var confirmation = (await smtp.WaitForMailsAsync(1))[0];
        await host.PostAsync(AuthRecoveryEndpoints.ForgotPasswordPath, new ForgotPasswordRequest(email));
        var reset = (await smtp.WaitForMailsAsync(2))[1];
        var tokens = new[] { RecoveryHost.FragmentOf(Link(confirmation))["token"], RecoveryHost.FragmentOf(Link(reset))["token"] };
        var fragment = RecoveryHost.FragmentOf(Link(reset));

        await host.PostAsync(AuthRecoveryEndpoints.ResetPasswordPath, new ResetPasswordRequest(email, tokens[1], RecoveryHost.NewPassword));
        await host.PostAsync(AuthRecoveryEndpoints.ResetPasswordPath, new ResetPasswordRequest(email, tokens[1], RecoveryHost.NewPassword)); // reuso
        await host.PostAsync(AuthRecoveryEndpoints.ResetPasswordPath, new ResetPasswordRequest(email, "token-basura", "otra-mas-larga-123")); // basura
        await host.PostAsync(AuthRecoveryEndpoints.ConfirmEmailPath, new ConfirmEmailRequest(RecoveryHost.FragmentOf(Link(confirmation))["userId"], null, tokens[0]));
        await host.PostAsync(AuthRecoveryEndpoints.ForgotPasswordPath, new ForgotPasswordRequest(RecoveryHost.NewEmail()));
        var cookie = await host.LoginCookieAsync(email, RecoveryHost.NewPassword);
        await host.PostAsync(AuthRecoveryEndpoints.ChangePasswordPath, new ChangePasswordRequest(RecoveryHost.NewPassword, "contrasena-final-larga-7"), cookie);
        await host.PostAsync(AuthRecoveryEndpoints.ChangePasswordPath, new ChangePasswordRequest("equivocada-larga-123", "contrasena-final-larga-8"), cookie);
        await host.SettleAsync();

        Assert.NotEmpty(logs.Entries);
        AssertNoSecrets(
            logs,
            email, tokens[0], tokens[1], fragment["email"], Uri.EscapeDataString(tokens[1]),
            RecoveryHost.Password, RecoveryHost.NewPassword, "contrasena-final-larga-7", "contrasena-final-larga-8", "equivocada-larga-123", "otra-mas-larga-123",
            SmtpPassword);
    }

    private static string Link(ReceivedMail mail) => Regex.Match(mail.TextBody!, @"https?://\S+").Value;

    private static void AssertNoSecrets(CapturingLoggerProvider logs, params string[] secrets)
    {
        foreach (var secret in secrets.Where(s => !string.IsNullOrEmpty(s)))
        {
            var leaks = logs.Entries.Where(e => e.Contains(secret, StringComparison.OrdinalIgnoreCase)).ToList();
            Assert.True(leaks.Count == 0, $"El log contiene un dato sensible ({secret.Length} caracteres): {leaks.FirstOrDefault()}");
        }
    }

    // ------------------------------------------------------------------------------------------------------- modo Log y Production

    [Fact]
    public async Task LogMode_WritesTheMessageWithItsLinkToTheLog_OnPurposeAndOnlyInDevelopment()
    {
        var logs = new CapturingLoggerProvider();
        var host = RecoveryHost.Create(_fixture, _connectionString, captureEmail: false, logProvider: logs); // Mode=Log + Development
        _hosts.Add(host);
        var email = await host.RegisterAsync();
        await host.SettleAsync();

        await host.PostAsync(AuthRecoveryEndpoints.ForgotPasswordPath, new ForgotPasswordRequest(email));
        await host.SettleAsync();

        var entry = Assert.Single(logs.Entries, e => e.Contains("view=reset-password", StringComparison.Ordinal));
        Assert.Contains("SOLO DESARROLLO", entry, StringComparison.Ordinal);
        Assert.Contains(email, entry, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Host_InProduction_WithLogMode_FailsToStart_AndWithSmtpStarts()
    {
        var keys = Path.Combine(Path.GetTempPath(), "vectorify-keys-" + Guid.NewGuid().ToString("N"));
        _directories.Add(keys);
        var common = new Dictionary<string, string?>
        {
            ["Auth:DataProtection:KeysPath"] = keys,
            ["Auth:Cookie:Name"] = "__Host-vectorify.session",
            ["Auth:Cookie:SecurePolicy"] = "Always",
            ["Cors:AllowedOrigins"] = "https://app.vectorify.test",
            ["Auth:Email:PublicBaseUrl"] = "https://app.vectorify.test",
        };

        var logMode = RecoveryHost.Create(
            _fixture, _connectionString, new Dictionary<string, string?>(common) { ["Auth:Email:Mode"] = "Log" }, environment: "Production");
        _hosts.Add(logMode);
        var failure = await Record.ExceptionAsync(() => logMode.Client.GetAsync("/health"));
        var validation = FindInChain<OptionsValidationException>(failure!);
        Assert.NotNull(validation);
        Assert.Contains("Auth:Email:Mode=Log", validation!.Message, StringComparison.Ordinal);

        var smtpMode = RecoveryHost.Create(
            _fixture,
            _connectionString,
            new Dictionary<string, string?>(common)
            {
                ["Auth:Email:Mode"] = "Smtp",
                ["Auth:Email:FromAddress"] = "no-reply@vectorify.test",
                ["Auth:Email:Smtp:Host"] = "smtp.proveedor.test",
            },
            environment: "Production");
        _hosts.Add(smtpMode);
        Assert.True((await smtpMode.Client.GetAsync("/health")).IsSuccessStatusCode);
    }

    [Fact]
    public async Task Host_WithAPublicBaseUrlOutsideCors_FailsToStart()
    {
        var host = RecoveryHost.Create(
            _fixture, _connectionString, new Dictionary<string, string?> { ["Auth:Email:PublicBaseUrl"] = "http://localhost:9999" });
        _hosts.Add(host);

        var failure = await Record.ExceptionAsync(() => host.Client.GetAsync("/health"));

        var validation = FindInChain<OptionsValidationException>(failure!);
        Assert.NotNull(validation);
        Assert.Contains("Cors:AllowedOrigins", validation!.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task DevelopmentMode_ChangePasswordIsStillProtected_AndTheExistingFlowIsUnchanged()
    {
        // Auth:Mode=Development (sin login): las rutas anónimas nuevas existen, change-password exige una sesión que ese modo no tiene (401).
        await using var factory = new FactoryHolder(_fixture, _connectionString);
        var client = factory.Client;

        var forgot = await client.PostAsJsonAsync(AuthRecoveryEndpoints.ForgotPasswordPath, new ForgotPasswordRequest(RecoveryHost.NewEmail()));
        var change = await client.PostAsJsonAsync(AuthRecoveryEndpoints.ChangePasswordPath, new ChangePasswordRequest("x", "y"));
        var me = await client.GetAsync(AuthEndpoints.MePath);

        Assert.Equal(HttpStatusCode.Accepted, forgot.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, change.StatusCode);
        Assert.Equal(HttpStatusCode.OK, me.StatusCode);
        var options = factory.Services.GetRequiredService<IOptions<AuthOptions>>().Value;
        Assert.Equal(AuthMode.Development, options.Mode);
        Assert.Equal(AuthEmailMode.Disabled, options.Email.Mode); // Development no cambia: el correo está apagado salvo que se configure
    }

    private sealed class FactoryHolder : IAsyncDisposable
    {
        private readonly Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactory<Program> _factory;

        public FactoryHolder(AuthApiFixture fixture, string connectionString)
        {
            _factory = fixture.CreateFactory(connectionString, authenticated: false);
            Client = _factory.CreateClient();
        }

        public HttpClient Client { get; }

        public IServiceProvider Services => _factory.Services;

        public async ValueTask DisposeAsync()
        {
            Client.Dispose();
            await _factory.DisposeAsync();
        }
    }

    private static T? FindInChain<T>(Exception exception)
        where T : Exception
    {
        for (Exception? current = exception; current is not null; current = current.InnerException)
        {
            if (current is T match)
            {
                return match;
            }
        }

        return null;
    }
}

using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;
using Vectorify.Api.Contracts;
using Vectorify.Api.Email;
using Vectorify.Api.Endpoints;

namespace Vectorify.Api.Tests.TestSupport;

/// <summary>Sustituye al <see cref="IEmailSender"/> real: guarda los mensajes (sin tocar la red) y puede bloquearse o fallar a demanda.</summary>
public sealed class CapturingEmailSender : IEmailSender
{
    private readonly ConcurrentQueue<EmailMessage> _messages = new();

    /// <summary>Si no es null, el envío espera a que se complete (prueba que el envío no está en la ruta de respuesta).</summary>
    public Task? Gate { get; set; }

    /// <summary>Si no es null, el envío lanza esta excepción (SMTP caído).</summary>
    public Exception? Failure { get; set; }

    public IReadOnlyList<EmailMessage> Messages => _messages.ToArray();

    public async Task SendAsync(EmailMessage message, CancellationToken cancellationToken)
    {
        if (Gate is not null)
        {
            await Gate;
        }

        if (Failure is not null)
        {
            throw Failure;
        }

        _messages.Enqueue(message);
    }

    public async Task<IReadOnlyList<EmailMessage>> WaitForAsync(int count, TimeSpan? timeout = null)
    {
        var deadline = DateTime.UtcNow + (timeout ?? TimeSpan.FromSeconds(20));
        while (_messages.Count < count && DateTime.UtcNow < deadline)
        {
            await Task.Delay(20);
        }

        return Messages;
    }
}

/// <summary>
/// Web API real en modo Authenticated sobre PostgreSQL real (Testcontainers) para los tests de recuperación de M3.1-S08. Cliente SIN cookie jar (cada test pasa la cookie que quiere
/// a mano), con las cabeceras anti-CSRF del frontend. Por defecto el correo se captura en memoria (<see cref="Email"/>); los tests SMTP lo apagan y apuntan al servidor falso.
/// </summary>
public sealed class RecoveryHost : IAsyncDisposable
{
    public const string Password = "una-contrasena-larga-1";
    public const string NewPassword = "otra-contrasena-larga-2";
    public const string PublicBaseUrl = "http://localhost:5173";
    public const string CookieName = "vectorify.session"; // appsettings.Development.json

    private static readonly WebApplicationFactoryClientOptions NoCookieJar = new() { HandleCookies = false };

    private HttpClient? _client;

    private RecoveryHost(WebApplicationFactory<Program> factory, CapturingEmailSender email, string connectionString, AuthApiFixture fixture)
    {
        Factory = factory;
        Email = email;
        ConnectionString = connectionString;
        Fixture = fixture;
    }

    public WebApplicationFactory<Program> Factory { get; }

    public CapturingEmailSender Email { get; }

    public string ConnectionString { get; }

    public AuthApiFixture Fixture { get; }

    public HttpClient Client => _client ??= Factory.CreateClient(NoCookieJar).WithCsrf();

    public AuthEmailQueue Queue => Factory.Services.GetRequiredService<AuthEmailQueue>();

    /// <param name="settings">Opciones adicionales (<c>Auth:...</c>); pisan los valores por defecto de esta clase.</param>
    /// <param name="captureEmail">true = <see cref="IEmailSender"/> en memoria; false = el sender real elegido por <c>Auth:Email:Mode</c>.</param>
    public static RecoveryHost Create(
        AuthApiFixture fixture,
        string connectionString,
        IDictionary<string, string?>? settings = null,
        bool captureEmail = true,
        ILoggerProvider? logProvider = null,
        Action<IServiceCollection>? configureServices = null,
        string? environment = null)
    {
        var values = new Dictionary<string, string?>
        {
            ["Auth:Session:RevalidationInterval"] = "00:00:00",
            ["Auth:Email:Mode"] = "Log",
            ["Auth:Email:PublicBaseUrl"] = PublicBaseUrl,
            ["Auth:RateLimit:IpPermitLimit"] = "1000",
            ["Auth:RateLimit:AddressSendPermitLimit"] = "1000",
            ["Auth:RateLimit:AddressVerifyPermitLimit"] = "1000",
        };
        foreach (var pair in settings ?? new Dictionary<string, string?>())
        {
            values[pair.Key] = pair.Value;
        }

        var email = new CapturingEmailSender();
        var factory = fixture.CreateFactory(
            connectionString,
            authenticated: true,
            logProvider: logProvider,
            configureServices: services =>
            {
                services.AddSingleton<IStartupFilter, TestRemoteIpStartupFilter>();
                if (captureEmail)
                {
                    services.RemoveAll<IEmailSender>();
                    services.AddSingleton<IEmailSender>(email);
                }

                configureServices?.Invoke(services);
            },
            settings: values);
        if (environment is not null)
        {
            factory = factory.WithWebHostBuilder(builder => builder.UseEnvironment(environment));
        }

        return new RecoveryHost(factory, email, connectionString, fixture);
    }

    public async ValueTask DisposeAsync()
    {
        _client?.Dispose();
        await Factory.DisposeAsync();
    }

    public static string NewEmail() => $"user-{Guid.NewGuid():N}@vectorify.test";

    public async Task<string> RegisterAsync(string? email = null, string password = Password)
    {
        email ??= NewEmail();
        var response = await Client.PostAsJsonAsync(AuthEndpoints.RegisterPath, new RegisterRequest(email, password));
        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        return email;
    }

    public Task<HttpResponseMessage> PostAsync(string path, object body, string? cookie = null, string? ip = null, Action<HttpRequestMessage>? configure = null)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, path) { Content = JsonContent.Create(body) };
        if (cookie is not null)
        {
            request.Headers.Add("Cookie", cookie);
        }

        if (ip is not null)
        {
            request.Headers.Add(TestRemoteIpMiddleware.HeaderName, ip);
        }

        configure?.Invoke(request);
        return Client.SendAsync(request);
    }

    public Task<HttpResponseMessage> LoginAsync(string email, string password = Password, bool? rememberMe = null) =>
        PostAsync(AuthEndpoints.LoginPath, new LoginRequest(email, password, rememberMe));

    public async Task<string> LoginCookieAsync(string email, string password = Password, bool? rememberMe = null)
    {
        var response = await LoginAsync(email, password, rememberMe);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return CookieOf(response);
    }

    public async Task<HttpStatusCode> MeStatusAsync(string cookie)
    {
        var request = new HttpRequestMessage(HttpMethod.Get, AuthEndpoints.MePath);
        request.Headers.Add("Cookie", cookie);
        return (await Client.SendAsync(request)).StatusCode;
    }

    public static IReadOnlyList<string> SessionSetCookies(HttpResponseMessage response) =>
        response.Headers.TryGetValues("Set-Cookie", out var values)
            ? values.Where(v => v.StartsWith(CookieName + "=", StringComparison.Ordinal)).ToList()
            : [];

    /// <summary>«nombre=valor» de la cookie de sesión emitida por la respuesta.</summary>
    public static string CookieOf(HttpResponseMessage response)
    {
        var header = Assert.Single(SessionSetCookies(response));
        return header[..header.IndexOf(';')];
    }

    // ---------------------------------------------------------------------------------------------- correo y tokens

    /// <summary>Espera el correo número <paramref name="count"/> y devuelve el último mensaje.</summary>
    public async Task<EmailMessage> NextEmailAsync(int count = 1)
    {
        var messages = await Email.WaitForAsync(count);
        Assert.True(messages.Count >= count, $"Se esperaban {count} correos y llegaron {messages.Count}.");
        return messages[count - 1];
    }

    /// <summary>Espera a que el trabajador de correo haya procesado todo lo encolado (para afirmar «no se envió nada»).</summary>
    public async Task SettleAsync() => Assert.True(await Queue.WhenIdleAsync(TimeSpan.FromSeconds(20)), "La cola de correo no se vació.");

    public static string LinkOf(EmailMessage message)
    {
        var match = Regex.Match(message.TextBody, @"https?://\S+");
        Assert.True(match.Success, "El correo no contiene ningún enlace.");
        return match.Value;
    }

    /// <summary>Valores del fragmento del enlace (decodificados como lo haría la SPA con URLSearchParams).</summary>
    public static Dictionary<string, string> FragmentOf(string link)
    {
        var fragment = new Uri(link).Fragment.TrimStart('#');
        return fragment.Split('&').Select(p => p.Split('=', 2)).ToDictionary(p => p[0], p => Uri.UnescapeDataString(p[1]));
    }

    public static string TokenOf(EmailMessage message) => FragmentOf(LinkOf(message))["token"];

    public async Task<string> ScalarStringAsync(string sql, params (string Name, object Value)[] parameters) =>
        await Fixture.ScalarAsync<string>(ConnectionString, sql, parameters);

    public Task<string> StampAsync(string email) =>
        ScalarStringAsync("SELECT \"SecurityStamp\" FROM auth.\"AspNetUsers\" WHERE \"NormalizedEmail\" = @e", ("e", email.ToUpperInvariant()));

    public Task<bool> EmailConfirmedAsync(string email) =>
        Fixture.ScalarAsync<bool>(ConnectionString, "SELECT \"EmailConfirmed\" FROM auth.\"AspNetUsers\" WHERE \"NormalizedEmail\" = @e", ("e", email.ToUpperInvariant()));
}

/// <summary>
/// Solo tests: TestServer no tiene IP remota, así que <c>X-Test-Remote-Ip</c> la fija para probar el límite por IP con direcciones distintas. Se inserta como filtro de
/// arranque ANTES del pipeline de la aplicación.
/// </summary>
public sealed class TestRemoteIpMiddleware
{
    public const string HeaderName = "X-Test-Remote-Ip";

    private readonly RequestDelegate _next;

    public TestRemoteIpMiddleware(RequestDelegate next)
    {
        _next = next;
    }

    public Task InvokeAsync(HttpContext context)
    {
        if (context.Request.Headers.TryGetValue(HeaderName, out var ip) && IPAddress.TryParse(ip.ToString(), out var address))
        {
            context.Connection.RemoteIpAddress = address;
        }

        return _next(context);
    }
}

public sealed class TestRemoteIpStartupFilter : IStartupFilter
{
    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
    {
        app.UseMiddleware<TestRemoteIpMiddleware>();
        next(app);
    };
}

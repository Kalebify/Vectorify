using System.Text.Json;
using System.Text.RegularExpressions;

namespace Vectorify.Api.Tests.Security;

/// <summary>
/// Vigilancia de la CONFIGURACIÓN de despliegue de M3.1-S09 (archivos del repositorio, sin levantar nada): defaults seguros de la imagen del backend, compose de desarrollo explícito y acotado
/// al loopback, CSP y cabeceras de nginx, y ausencia de secretos y de redirecciones abiertas. Lo que la API hace con esa configuración al arrancar lo prueban los tests de host.
/// </summary>
public sealed class DeploymentDefaultsTests
{
    private static readonly string Root = FindRepositoryRoot();

    private static string FindRepositoryRoot()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            if (File.Exists(Path.Combine(dir.FullName, "docker-compose.yml")) && Directory.Exists(Path.Combine(dir.FullName, "backend")))
            {
                return dir.FullName;
            }
        }

        throw new InvalidOperationException("No se encontró la raíz del repositorio (docker-compose.yml) subiendo desde " + AppContext.BaseDirectory);
    }

    private static string Read(params string[] relative) => File.ReadAllText(Path.Combine([Root, .. relative])).Replace("\r\n", "\n");

    private static IEnumerable<string> NonCommentLines(string text) =>
        text.Split('\n').Where(line => !line.TrimStart().StartsWith('#'));

    // ------------------------------------------------------------------------------------------------ imagen del backend

    [Fact]
    public void BackendImage_DefaultsToProductionAndAuthenticated_NotDevelopment()
    {
        var dockerfile = Read("backend", "Dockerfile");
        var env = string.Join("\n", NonCommentLines(dockerfile).Where(l => l.Contains("ASPNETCORE_") || l.Contains("Auth__") || l.TrimStart().StartsWith("ENV", StringComparison.Ordinal)));

        Assert.Contains("ASPNETCORE_ENVIRONMENT=Production", env);
        Assert.Contains("Auth__Mode=Authenticated", env);
        Assert.DoesNotContain("=Development", env);
        Assert.DoesNotContain("ASPNETCORE_ENVIRONMENT=Development", string.Join("\n", NonCommentLines(dockerfile)));
    }

    [Fact]
    public void BackendImage_CarriesNoSecrets()
    {
        var dockerfile = string.Join("\n", NonCommentLines(Read("backend", "Dockerfile")));

        Assert.DoesNotMatch(@"(?i)(password|secret|apikey|api_key|token)\s*=\s*\S", dockerfile);
        Assert.DoesNotContain("ConnectionString", dockerfile);
    }

    // ------------------------------------------------------------------------------------------------------------- compose

    [Fact]
    public void Compose_StatesTheDevelopmentModeExplicitly_SoOneCommandStillStartsTheStack()
    {
        var compose = Read("docker-compose.yml");

        Assert.Matches(@"ASPNETCORE_ENVIRONMENT:\s*\$\{ASPNETCORE_ENVIRONMENT:-Development\}", compose);
        Assert.Matches(@"Auth__Mode:\s*\$\{AUTH_MODE:-Development\}", compose);
    }

    [Fact]
    public void Compose_PublishesEveryPortOnTheLoopbackByDefault()
    {
        var ports = NonCommentLines(Read("docker-compose.yml")).Where(l => Regex.IsMatch(l, @"^\s*-\s*""[^""]*:[^""]*""\s*$") && l.Contains("_PORT")).ToList();

        Assert.NotEmpty(ports);
        foreach (var line in ports)
        {
            Assert.Contains("${BIND_ADDRESS:-127.0.0.1}:", line);
        }
    }

    [Fact]
    public void Compose_TheOnlySecretPublishedIsTheDocumentedDevelopmentPostgresPassword()
    {
        var compose = string.Join("\n", NonCommentLines(Read("docker-compose.yml")));

        // Cualquier valor por defecto de una variable sensible debe ser vacío, salvo POSTGRES_PASSWORD (contraseña de ejemplo conocida y rechazada fuera de desarrollo).
        var sensitiveDefaults = Regex.Matches(compose, @"\$\{([A-Z_]*(PASSWORD|SECRET|KEY|TOKEN)):-([^}]*)\}")
            .Select(m => (Name: m.Groups[1].Value, Default: m.Groups[3].Value))
            .Where(x => x.Default.Length > 0)
            .ToList();

        Assert.All(sensitiveDefaults, x => Assert.Equal("POSTGRES_PASSWORD", x.Name));
        Assert.Contains(sensitiveDefaults, x => x is { Name: "POSTGRES_PASSWORD", Default: "vectorify_dev_password" });
        Assert.DoesNotMatch(@"(?i)Password=(?!\$\{POSTGRES_PASSWORD)", compose);
    }

    [Fact]
    public void Compose_PassesTheApiOriginToNginx_ForTheCsp()
    {
        Assert.Matches(@"API_ORIGIN:\s*\$\{API_ORIGIN:-\$\{VITE_API_BASE_URL:-http://localhost:5080\}\}", Read("docker-compose.yml"));
    }

    // ----------------------------------------------------------------------------------------------------- nginx y la SPA

    private static string NginxCsp()
    {
        var match = Regex.Match(Read("frontend", "nginx.conf"), @"add_header\s+Content-Security-Policy\s+""([^""]+)""\s+always;");
        Assert.True(match.Success, "nginx.conf no declara Content-Security-Policy con «always».");
        return match.Groups[1].Value;
    }

    private static string Directive(string csp, string name) =>
        csp.Split(';', StringSplitOptions.TrimEntries).Single(d => d.StartsWith(name + " ", StringComparison.Ordinal) || d == name);

    [Fact]
    public void Nginx_Csp_IsStrict()
    {
        var csp = NginxCsp();

        Assert.Equal("default-src 'none'", Directive(csp, "default-src"));
        Assert.Equal("script-src 'self'", Directive(csp, "script-src")); // sin inline, sin eval, sin CDN
        Assert.Equal("style-src 'self'", Directive(csp, "style-src"));
        Assert.Equal("frame-ancestors 'none'", Directive(csp, "frame-ancestors"));
        Assert.Equal("base-uri 'self'", Directive(csp, "base-uri"));
        Assert.Equal("form-action 'self'", Directive(csp, "form-action"));
        Assert.Equal("object-src 'none'", Directive(csp, "object-src"));
        Assert.DoesNotContain("unsafe-eval", csp);
        Assert.DoesNotContain("unsafe-inline", csp);
        Assert.DoesNotContain("*", csp.Replace("${API_ORIGIN}", string.Empty));
        Assert.DoesNotContain("https:", csp); // ningún esquema entero permitido
    }

    [Fact]
    public void Nginx_Csp_AllowsTheConfigurableApiOriginOnlyWhereTheAppNeedsIt()
    {
        var csp = NginxCsp();

        Assert.Equal("connect-src 'self' ${API_ORIGIN}", Directive(csp, "connect-src"));
        Assert.Equal("img-src 'self' data: blob: ${API_ORIGIN}", Directive(csp, "img-src"));
        Assert.DoesNotContain("API_ORIGIN", Directive(csp, "script-src"));
        Assert.DoesNotContain("API_ORIGIN", Directive(csp, "default-src"));
    }

    [Fact]
    public void Nginx_SendsTheOtherSecurityHeaders_WithAlways_AndANonGlobalNoReferrer()
    {
        var conf = string.Join("\n", NonCommentLines(Read("frontend", "nginx.conf")));

        foreach (var header in new[] { "X-Content-Type-Options \"nosniff\"", "X-Frame-Options \"DENY\"", "Cross-Origin-Opener-Policy \"same-origin\"", "Permissions-Policy \"" })
        {
            Assert.Matches(@"add_header\s+" + Regex.Escape(header) + @"[^;]*always;", conf);
        }

        // S08/S09: Referrer-Policy: no-referrer haría que las peticiones del mismo origen salgan con «Origin: null» y el CsrfGuard respondería 403.
        Assert.Matches(@"add_header\s+Referrer-Policy\s+""strict-origin-when-cross-origin""\s+always;", conf);
        Assert.DoesNotContain("no-referrer", conf);
        Assert.Contains("server_tokens off;", conf);
        Assert.DoesNotMatch(@"location[^{]*\{[^}]*add_header", conf); // los add_header de una location anulan los heredados del server
    }

    [Fact]
    public void FrontendImage_ProcessesNginxConfAsATemplate_WithAnApiOriginDefault()
    {
        var dockerfile = Read("frontend", "Dockerfile");

        Assert.Contains("COPY nginx.conf /etc/nginx/templates/default.conf.template", dockerfile);
        Assert.Matches(@"ENV API_ORIGIN=http://localhost:5080", dockerfile);
    }

    [Fact]
    public void IndexHtml_HasNoInlineScriptsNorAGlobalReferrerMeta()
    {
        var html = Read("frontend", "index.html");

        Assert.DoesNotMatch(@"<meta[^>]+name\s*=\s*[""']referrer[""']", html);
        Assert.DoesNotMatch(@"<script(?![^>]*\bsrc=)[^>]*>", html); // todo <script> lleva src (la CSP no permite inline)
        Assert.DoesNotMatch(@"(?i)\bon[a-z]+\s*=", html);
        Assert.DoesNotMatch(@"<link[^>]+href\s*=\s*[""']https?://", html); // sin recursos de terceros
    }

    // ----------------------------------------------------------------------------------------- secretos y redirecciones en el código

    [Fact]
    public void AppSettings_CarryNoSecretValues()
    {
        var dir = Path.Combine(Root, "backend", "Vectorify.Api");
        foreach (var file in Directory.GetFiles(dir, "appsettings*.json"))
        {
            using var document = JsonDocument.Parse(File.ReadAllText(file));
            foreach (var (path, value) in Strings(document.RootElement, string.Empty))
            {
                var sensitiveName = Regex.IsMatch(path, @"(?i)(password|secret|apikey|api_key|token|connectionstring|privatekey|clientsecret)");
                if (sensitiveName)
                {
                    Assert.True(string.IsNullOrEmpty(value), $"{Path.GetFileName(file)}: «{path}» tiene un valor; los secretos van por variable de entorno.");
                }

                Assert.DoesNotMatch(@"(?i)(password|pwd)\s*=\s*[^;\s]+", value);
                Assert.DoesNotMatch(@"-----BEGIN [A-Z ]*PRIVATE KEY-----", value);
            }
        }
    }

    private static IEnumerable<(string Path, string Value)> Strings(JsonElement element, string path)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                foreach (var property in element.EnumerateObject())
                {
                    foreach (var child in Strings(property.Value, path.Length == 0 ? property.Name : path + ":" + property.Name))
                    {
                        yield return child;
                    }
                }

                break;
            case JsonValueKind.String:
                yield return (path, element.GetString() ?? string.Empty);
                break;
        }
    }

    [Fact]
    public void TheApi_HasNoRedirectResults_SoThereIsNoOpenRedirectSurface()
    {
        var offenders = Directory.EnumerateFiles(Path.Combine(Root, "backend", "Vectorify.Api"), "*.cs", SearchOption.AllDirectories)
            .Where(f => !f.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}") && !f.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}"))
            .Where(f => Regex.IsMatch(File.ReadAllText(f), @"Results\.(Local)?Redirect|\bRedirectToRoute\b|\bRedirectPermanent\b|Response\.Redirect\(|\bLocalRedirect\("))
            .Select(f => Path.GetRelativePath(Root, f))
            .ToList();

        Assert.Empty(offenders);
    }

    [Fact]
    public void GitAndDockerIgnores_ExcludeEnvFilesKeysAndCertificates()
    {
        var gitignore = Read(".gitignore");
        var backendDockerignore = Read("backend", ".dockerignore");
        var frontendDockerignore = Read("frontend", ".dockerignore");

        foreach (var pattern in new[] { ".env", ".env.*", "!.env.example", "*.pem", "*.key", "*.pfx", "*.p12", "dataprotection-keys/" })
        {
            Assert.Contains(pattern, gitignore.Split('\n').Select(l => l.Trim()));
        }

        foreach (var dockerignore in new[] { backendDockerignore, frontendDockerignore })
        {
            var lines = dockerignore.Split('\n').Select(l => l.Trim()).ToList();
            Assert.Contains(lines, l => l is ".env" or "**/.env");
            Assert.Contains(lines, l => l is ".env.*" or "**/.env.*");
        }

        Assert.Contains("**/*.pem", backendDockerignore.Split('\n').Select(l => l.Trim()));
        Assert.Contains("**/dataprotection-keys", backendDockerignore.Split('\n').Select(l => l.Trim()));
    }
}

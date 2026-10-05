using System.Reflection;
using System.Text.RegularExpressions;
using Vectorify.Api.Contracts;
using Vectorify.Api.Users;

namespace Vectorify.Api.Tests.Users;

/// <summary>
/// Reglas de arquitectura de M2.2-S09: la aplicación depende SOLO de <see cref="IUserContext"/>
/// (cambiar DevelopmentUserContext por un AuthenticatedUserContext en MVP 3.1 no toca
/// Project/Asset/VectorDocument) y los requests nunca llevan un owner enviado por el cliente.
/// </summary>
public sealed class UserContextArchitectureTests
{
    private static readonly string[] ConcreteUserTypes = [nameof(DevelopmentUserContext), nameof(DevelopmentUserSeeder)];

    private const BindingFlags AllMembers =
        BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly;

    [Fact]
    public void NoTypeOutsideTheUsersNamespace_ReferencesTheDevelopmentImplementationInItsSignatures()
    {
        var offenders = new List<string>();
        var concreteTypes = new[] { typeof(DevelopmentUserContext), typeof(DevelopmentUserSeeder) };

        foreach (var type in typeof(Program).Assembly.GetTypes())
        {
            if (type.Namespace == typeof(IUserContext).Namespace || type.Name.StartsWith('<') || type.Name == nameof(Program))
            {
                continue;
            }

            foreach (var referenced in ReferencedTypes(type))
            {
                if (concreteTypes.Contains(referenced))
                {
                    offenders.Add($"{type.FullName} -> {referenced.Name}");
                }
            }
        }

        Assert.Empty(offenders);
    }

    [Fact]
    public void NoSourceFileOutsideUsersAndProgram_MentionsTheDevelopmentImplementationInCode()
    {
        var apiDirectory = FindApiProjectDirectory();
        var offenders = new List<string>();

        foreach (var file in Directory.EnumerateFiles(apiDirectory, "*.cs", SearchOption.AllDirectories))
        {
            var relative = Path.GetRelativePath(apiDirectory, file).Replace('\\', '/');
            if (relative.StartsWith("obj/") || relative.StartsWith("bin/") || relative.StartsWith("Users/") || relative == "Program.cs")
            {
                continue;
            }

            var lineNumber = 0;
            foreach (var line in File.ReadLines(file))
            {
                lineNumber++;
                // Los comentarios de documentación pueden nombrar la implementación; el código no.
                if (line.TrimStart().StartsWith("//", StringComparison.Ordinal))
                {
                    continue;
                }

                if (ConcreteUserTypes.Any(name => Regex.IsMatch(line, $@"\b{name}\b")))
                {
                    offenders.Add($"{relative}:{lineNumber}: {line.Trim()}");
                }
            }
        }

        Assert.Empty(offenders);
    }

    [Fact]
    public void RequestContracts_NeverCarryAnOwnerOrUserIdentifier()
    {
        var requestTypes = typeof(CreateProjectRequest).Assembly.GetTypes()
            .Where(t => t.Namespace == typeof(CreateProjectRequest).Namespace && t.Name.Contains("Request", StringComparison.Ordinal))
            .ToList();

        // Sanity: los DTOs de la superficie v2 forman parte de lo auditado.
        Assert.Contains(typeof(CreateProjectRequest), requestTypes);
        Assert.Contains(typeof(UpdateProjectRequest), requestTypes);
        Assert.Contains(typeof(VectorDocumentSaveRequest), requestTypes);
        Assert.Contains(typeof(UpdateLayerRequest), requestTypes);

        var offenders = requestTypes
            .SelectMany(t => t.GetProperties().Select(p => $"{t.Name}.{p.Name}"))
            .Where(name => Regex.IsMatch(name, "owner|user", RegexOptions.IgnoreCase))
            .ToList();

        Assert.Empty(offenders);
    }

    private static IEnumerable<Type> ReferencedTypes(Type type)
    {
        foreach (var member in type.GetMembers(AllMembers))
        {
            switch (member)
            {
                case FieldInfo field:
                    yield return field.FieldType;
                    break;
                case PropertyInfo property:
                    yield return property.PropertyType;
                    break;
                case MethodBase method:
                    foreach (var parameter in method.GetParameters())
                    {
                        yield return parameter.ParameterType;
                    }

                    if (method is MethodInfo methodInfo)
                    {
                        yield return methodInfo.ReturnType;
                    }

                    break;
            }
        }

        if (type.BaseType is not null)
        {
            yield return type.BaseType;
        }

        foreach (var implemented in type.GetInterfaces())
        {
            yield return implemented;
        }
    }

    private static string FindApiProjectDirectory()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            var candidate = Path.Combine(directory.FullName, "Vectorify.Api", "Vectorify.Api.csproj");
            if (File.Exists(candidate))
            {
                return Path.GetDirectoryName(candidate)!;
            }

            directory = directory.Parent;
        }

        throw new DirectoryNotFoundException("No se encontró el directorio fuente de Vectorify.Api subiendo desde el directorio de salida de los tests.");
    }
}

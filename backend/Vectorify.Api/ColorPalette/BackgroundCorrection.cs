using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace Vectorify.Api.ColorPalette;

/// <summary>
/// Zona que la persona marcó como «esto NO es fondo» al revisar el fondo de una paleta por familias: polígono en
/// coordenadas de imagen (0..ancho, 0..alto, sobre las esquinas de los píxeles), con vértices [x, y]. Los píxeles de
/// fondo cuyo centro cae dentro pasan a su familia por su propio color (un blanco del dibujo que se funde con el fondo
/// sin borde distinguible). Nunca se aplica en silencio: forma parte de los parámetros efectivos, de la clave de caché
/// y de lo persistido.
/// </summary>
public sealed record BackgroundCorrection(IReadOnlyList<IReadOnlyList<double>> Points)
{
    public const int MaxRegions = 32;
    public const int MinPoints = 3;
    public const int MaxPoints = 500;
    public const double MaxAbsCoordinate = 100_000;

    /// <summary>Motivo por el que una lista de zonas no es válida, o null si lo es.</summary>
    public static string? Validate(IReadOnlyList<BackgroundCorrection>? corrections)
    {
        if (corrections is null)
        {
            return null;
        }

        if (corrections.Count > MaxRegions)
        {
            return $"backgroundCorrections admite como máximo {MaxRegions} zonas.";
        }

        foreach (var region in corrections)
        {
            if (region?.Points is null || region.Points.Count < MinPoints || region.Points.Count > MaxPoints)
            {
                return $"Cada zona de backgroundCorrections necesita entre {MinPoints} y {MaxPoints} vértices.";
            }

            foreach (var point in region.Points)
            {
                if (point is null || point.Count != 2
                    || !double.IsFinite(point[0]) || !double.IsFinite(point[1])
                    || Math.Abs(point[0]) > MaxAbsCoordinate || Math.Abs(point[1]) > MaxAbsCoordinate)
                {
                    return "Cada vértice de backgroundCorrections debe ser [x, y] con números finitos.";
                }
            }
        }

        return null;
    }

    /// <summary>Lista normalizada: null si no hay zonas (así «ninguna» siempre produce la misma clave de caché).</summary>
    public static IReadOnlyList<BackgroundCorrection>? Normalize(IReadOnlyList<BackgroundCorrection>? corrections) =>
        corrections is null || corrections.Count == 0 ? null : corrections;

    /// <summary>Huella estable (orden y coordenadas, 3 decimales) para la clave de caché; «none» si no hay zonas.</summary>
    public static string Fingerprint(IReadOnlyList<BackgroundCorrection>? corrections)
    {
        if (corrections is null || corrections.Count == 0)
        {
            return "none";
        }

        var canonical = new StringBuilder();
        foreach (var region in corrections)
        {
            canonical.Append(string.Join(
                ';', region.Points.Select(p => $"{p[0].ToString("F3", CultureInfo.InvariantCulture)},{p[1].ToString("F3", CultureInfo.InvariantCulture)}")));
            canonical.Append('|');
        }

        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(canonical.ToString()));
        return $"{corrections.Count}:{Convert.ToHexString(hash, 0, 8)}";
    }
}

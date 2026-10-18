namespace Vectorify.Api.Users;

/// <summary>
/// Reglas del nombre para mostrar del perfil (M3.1-S07): recortado, de 1 a <see cref="MaxLength"/> caracteres (unidades UTF-16 de
/// <see cref="string.Length"/>, la misma medida que usa el cliente) y sin caracteres de control (U+0000–U+001F y U+007F–U+009F,
/// <see cref="char.IsControl(char)"/>). Los mensajes están en español y se devuelven tal cual al cliente.
/// </summary>
public static class DisplayNameRules
{
    public const int MaxLength = 80;

    /// <summary>Código estable del 400 de validación del nombre.</summary>
    public const string InvalidCode = "invalid_display_name";

    public const string LengthMessage = "El nombre para mostrar debe tener entre 1 y 80 caracteres.";

    public const string ControlCharactersMessage =
        "El nombre para mostrar no puede tener tabulaciones, saltos de línea ni otros caracteres de control.";

    /// <summary>Valida y normaliza. Devuelve true con el nombre recortado, o false con el mensaje de error en español.</summary>
    public static bool TryNormalize(string? raw, out string normalized, out string error)
    {
        normalized = (raw ?? string.Empty).Trim();
        error = string.Empty;

        if (normalized.Length is 0 or > MaxLength)
        {
            error = LengthMessage;
            return false;
        }

        if (normalized.Any(char.IsControl))
        {
            error = ControlCharactersMessage;
            return false;
        }

        return true;
    }
}

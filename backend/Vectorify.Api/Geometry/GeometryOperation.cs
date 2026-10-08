namespace Vectorify.Api.Geometry;

/// <summary>Operación booleana del servicio de geometría (M3-S04). El nombre en el cable es el del enum en minúsculas.</summary>
public enum GeometryOperation
{
    Union,
    Difference,
    Intersection,
    Xor,
    Normalize,
}

public static class GeometryOperationNames
{
    public static string ToWireName(this GeometryOperation operation) => operation switch
    {
        GeometryOperation.Union => "union",
        GeometryOperation.Difference => "difference",
        GeometryOperation.Intersection => "intersection",
        GeometryOperation.Xor => "xor",
        GeometryOperation.Normalize => "normalize",
        _ => throw new ArgumentOutOfRangeException(nameof(operation), operation, null),
    };

    public static bool TryParse(string? value, out GeometryOperation operation)
    {
        switch (value?.Trim().ToLowerInvariant())
        {
            case "union": operation = GeometryOperation.Union; return true;
            case "difference": operation = GeometryOperation.Difference; return true;
            case "intersection": operation = GeometryOperation.Intersection; return true;
            case "xor": operation = GeometryOperation.Xor; return true;
            case "normalize": operation = GeometryOperation.Normalize; return true;
            default: operation = default; return false;
        }
    }
}

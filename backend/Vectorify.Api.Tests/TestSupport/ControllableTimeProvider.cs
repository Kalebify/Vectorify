namespace Vectorify.Api.Tests.TestSupport;

/// <summary>
/// Reloj controlable (M3.1-S04): se inyecta como <see cref="TimeProvider"/> del host para probar expiración deslizante, tope absoluto y
/// revalidación del SecurityStamp SIN dormir. Solo cambia lo que el host lee de <see cref="TimeProvider"/> (ticket de la cookie,
/// validador del SecurityStamp, login); el reloj real sigue gobernando Postgres y Data Protection. Puede retroceder (para simular
/// desfase de reloj entre instancias).
/// </summary>
public sealed class ControllableTimeProvider : TimeProvider
{
    private readonly object _gate = new();
    private DateTimeOffset _now;

    public ControllableTimeProvider(DateTimeOffset? start = null)
    {
        var initial = start ?? DateTimeOffset.UtcNow;
        _now = new DateTimeOffset(initial.Year, initial.Month, initial.Day, initial.Hour, initial.Minute, initial.Second, TimeSpan.Zero);
    }

    public DateTimeOffset Now
    {
        get
        {
            lock (_gate)
            {
                return _now;
            }
        }
    }

    public void Advance(TimeSpan by)
    {
        lock (_gate)
        {
            _now += by;
        }
    }

    public void Set(DateTimeOffset value)
    {
        lock (_gate)
        {
            _now = value;
        }
    }

    public override DateTimeOffset GetUtcNow() => Now;
}

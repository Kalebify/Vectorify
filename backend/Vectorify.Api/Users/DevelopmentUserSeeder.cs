using Microsoft.EntityFrameworkCore;
using Vectorify.Api.Data;
using Vectorify.Api.Options;

namespace Vectorify.Api.Users;

/// <summary>
/// Siembra, al ARRANCAR la API (ver Program.cs, mismo punto donde se aplican las
/// migraciones), el <see cref="User"/> de desarrollo que <see cref="DevelopmentUserContext"/>
/// devuelve siempre (Id/Email/DisplayName de <see cref="DevelopmentUserOptions"/>) -- así la FK
/// <c>Project.OwnerId -&gt; Users.Id</c> nunca falla al crear el primer proyecto de una sesión
/// de desarrollo nueva. Idempotente y conservador: si la fila ya existe NO la modifica
/// (reinicios sucesivos contra la misma base, o un usuario editado a mano).
/// </summary>
public static class DevelopmentUserSeeder
{
    public static async Task EnsureSeededAsync(
        VectorizationDbContext dbContext, DevelopmentUserOptions options, CancellationToken cancellationToken = default)
    {
        var exists = await dbContext.Users.AnyAsync(u => u.Id == options.UserId, cancellationToken);

        if (exists)
        {
            return;
        }

        dbContext.Users.Add(new User
        {
            Id = options.UserId,
            Email = options.Email,
            DisplayName = options.DisplayName,
            CreatedAt = DateTimeOffset.UtcNow,
        });

        await dbContext.SaveChangesAsync(cancellationToken);
    }
}

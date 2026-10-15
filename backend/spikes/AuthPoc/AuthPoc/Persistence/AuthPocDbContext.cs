using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;

namespace AuthPoc.Persistence;

/// <summary>
/// DbContext del SPIKE: tablas de ASP.NET Core Identity (fuente B) y de <see cref="UserIdentity"/>, todas en el esquema
/// <c>poc_auth</c> de la MISMA base del producto. El <c>VectorizationDbContext</c> del producto no se toca.
/// </summary>
public sealed class AuthPocDbContext : IdentityDbContext<IdentityUser<Guid>, IdentityRole<Guid>, Guid>
{
    public const string Schema = "poc_auth";

    public AuthPocDbContext(DbContextOptions<AuthPocDbContext> options)
        : base(options)
    {
    }

    public DbSet<UserIdentity> UserIdentities => Set<UserIdentity>();

    protected override void OnModelCreating(ModelBuilder builder)
    {
        base.OnModelCreating(builder);
        builder.HasDefaultSchema(Schema);

        builder.Entity<UserIdentity>(entity =>
        {
            entity.ToTable("user_identities");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.Provider).IsRequired().HasMaxLength(512);
            entity.Property(e => e.Subject).IsRequired().HasMaxLength(255);

            // El invariante que hace idempotente el mapeo: UNA persona del proveedor X = UN User.
            entity.HasIndex(e => new { e.Provider, e.Subject }).IsUnique();
            entity.HasIndex(e => e.UserId);
        });
    }
}

using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Vectorify.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddProjectClassicTriple : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<Guid>(
                name: "ClassicImageId",
                table: "projects",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "ClassicPaletteId",
                table: "projects",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "ClassicProjectId",
                table: "projects",
                type: "uuid",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "ClassicImageId",
                table: "projects");

            migrationBuilder.DropColumn(
                name: "ClassicPaletteId",
                table: "projects");

            migrationBuilder.DropColumn(
                name: "ClassicProjectId",
                table: "projects");
        }
    }
}

using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Vectorify.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddDocumentVersionIdempotencyKey : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "IdempotencyKey",
                table: "document_versions",
                type: "text",
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_document_versions_IdempotencyKey",
                table: "document_versions",
                column: "IdempotencyKey",
                unique: true,
                filter: "\"IdempotencyKey\" IS NOT NULL");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_document_versions_IdempotencyKey",
                table: "document_versions");

            migrationBuilder.DropColumn(
                name: "IdempotencyKey",
                table: "document_versions");
        }
    }
}

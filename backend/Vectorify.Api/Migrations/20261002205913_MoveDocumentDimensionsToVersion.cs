using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Vectorify.Api.Migrations
{
    /// <inheritdoc />
    public partial class MoveDocumentDimensionsToVersion : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // Fix round 1 (QA post-merge): la versión original de esta migración hacía
            // DropColumn de vector_documents ANTES de copiar nada a document_versions (perdía
            // WidthMm/HeightMm/ViewBox/SchemaVersion de cualquier proyecto ya guardado por
            // M2.2-S05) y agregaba Layer.GroupId con Guid.Empty para TODAS las filas existentes
            // antes del índice único (VersionId, GroupId) -- dos filas Guid.Empty en la MISMA
            // versión (documento multicolor, 2+ layers) hacían fallar el CreateIndex. Orden
            // nuevo: agregar columnas -> backfill real vía SQL -> índice único -> recién ahí
            // borrar las columnas viejas.

            // 1. Columnas nuevas en document_versions con un default TEMPORAL cualquiera -- se
            // sobreescribe en el paso 3, antes de que nada lea este valor placeholder.
            migrationBuilder.AddColumn<double>(
                name: "HeightMm",
                table: "document_versions",
                type: "double precision",
                nullable: false,
                defaultValue: 0.0);

            migrationBuilder.AddColumn<int>(
                name: "SchemaVersion",
                table: "document_versions",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<string>(
                name: "ViewBox",
                table: "document_versions",
                type: "text",
                nullable: false,
                defaultValue: "");

            migrationBuilder.AddColumn<double>(
                name: "WidthMm",
                table: "document_versions",
                type: "double precision",
                nullable: false,
                defaultValue: 0.0);

            // 2. Layer.GroupId, SIN índice único todavía -- el backfill del paso 4 necesita poder
            // escribir valores potencialmente repetidos a través de FILAS DISTINTAS antes de que
            // la constraint exista (en la práctica nunca se repiten, ver el comentario del paso
            // 4, pero el orden importa igual: nunca crear una constraint única antes de terminar
            // de backfillear los valores que debe validar).
            migrationBuilder.AddColumn<Guid>(
                name: "GroupId",
                table: "layers",
                type: "uuid",
                nullable: false,
                defaultValue: new Guid("00000000-0000-0000-0000-000000000000"));

            // 3. Backfill real: copia WidthMm/HeightMm/ViewBox/SchemaVersion de vector_documents a
            // CADA DocumentVersion que le pertenece -- preserva lo que haya guardado cualquier
            // proyecto real de M2.2-S05 (antes de esta tarjeta, esas 4 columnas vivían sin
            // versionar en vector_documents, un valor único por documento, así que todas sus
            // DocumentVersion existentes heredan el mismo valor -- no hay forma de recuperar
            // valores por-versión que nunca se guardaron por separado, pero tampoco hace falta:
            // sin esta tarjeta ya eran todos iguales).
            migrationBuilder.Sql(
                """
                UPDATE "document_versions" dv
                SET "WidthMm" = vd."WidthMm",
                    "HeightMm" = vd."HeightMm",
                    "ViewBox" = vd."ViewBox",
                    "SchemaVersion" = vd."SchemaVersion"
                FROM "vector_documents" vd
                WHERE dv."VectorDocumentId" = vd."Id";
                """);

            // 4. Backfill de GroupId = Id para TODAS las filas existentes -- antes de esta
            // migración, Layer.Id SÍ era el groupId clásico reutilizado VERBATIM (M2.2-S05:
            // SaveAsync hacía upsert-por-Id, nunca insertaba una fila nueva para el mismo
            // groupId), así que Id es el valor correcto de GroupId para cualquier fila
            // pre-existente. Sin colisión posible con el índice único (VersionId, GroupId) del
            // paso 5: "layers"."Id" ya es la PK de la tabla completa (única GLOBALMENTE, no solo
            // por versión) desde antes de esta migración -- si GroupId = Id es único en TODA la
            // tabla, automáticamente es único dentro de cualquier subconjunto agrupado por
            // VersionId, sin importar cuántas filas (layers multicolor, 2+ por versión) tenga esa
            // versión.
            migrationBuilder.Sql(
                """
                UPDATE "layers" SET "GroupId" = "Id";
                """);

            // 5. Recién acá el índice único -- los pasos 3/4 ya dejaron todos los valores reales
            // escritos, nunca se valida contra los defaults placeholder del paso 1/2.
            migrationBuilder.CreateIndex(
                name: "IX_layers_VersionId_GroupId",
                table: "layers",
                columns: new[] { "VersionId", "GroupId" },
                unique: true);

            // 6. Borra las columnas viejas de vector_documents -- recién ahora que sus valores ya
            // están copiados a cada DocumentVersion (paso 3).
            migrationBuilder.DropColumn(
                name: "HeightMm",
                table: "vector_documents");

            migrationBuilder.DropColumn(
                name: "SchemaVersion",
                table: "vector_documents");

            migrationBuilder.DropColumn(
                name: "ViewBox",
                table: "vector_documents");

            migrationBuilder.DropColumn(
                name: "WidthMm",
                table: "vector_documents");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // Espejo del Up, en el mismo espíritu (backfill ANTES de borrar la fuente) -- aunque
            // acá la reconstrucción es necesariamente con pérdida: vector_documents solo puede
            // tener UN valor de WidthMm/HeightMm/ViewBox/SchemaVersion por documento, pero
            // document_versions puede tener varios (uno por versión) para cuando este Down
            // corre. Se usa deliberadamente el de la DocumentVersion ACTUAL de cada Project
            // (Project.CurrentVersionId) -- es el único criterio sin ambigüedad ("lo que el
            // documento muestra hoy"), análogo a lo que ya se perdía antes de M2.2-S06 (esas 4
            // columnas nunca estuvieron versionadas). Un rollback real de este alcance ya implica
            // perder historial por versión de todas formas (es political/operacionalmente
            // esperable en un Down real), así que no se intenta preservar más que eso.
            migrationBuilder.AddColumn<double>(
                name: "HeightMm",
                table: "vector_documents",
                type: "double precision",
                nullable: false,
                defaultValue: 0.0);

            migrationBuilder.AddColumn<int>(
                name: "SchemaVersion",
                table: "vector_documents",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<string>(
                name: "ViewBox",
                table: "vector_documents",
                type: "text",
                nullable: false,
                defaultValue: "");

            migrationBuilder.AddColumn<double>(
                name: "WidthMm",
                table: "vector_documents",
                type: "double precision",
                nullable: false,
                defaultValue: 0.0);

            migrationBuilder.Sql(
                """
                UPDATE "vector_documents" vd
                SET "WidthMm" = dv."WidthMm",
                    "HeightMm" = dv."HeightMm",
                    "ViewBox" = dv."ViewBox",
                    "SchemaVersion" = dv."SchemaVersion"
                FROM "projects" p
                JOIN "document_versions" dv ON dv."Id" = p."CurrentVersionId"
                WHERE p."Id" = vd."ProjectId";
                """);

            migrationBuilder.DropIndex(
                name: "IX_layers_VersionId_GroupId",
                table: "layers");

            migrationBuilder.DropColumn(
                name: "GroupId",
                table: "layers");

            migrationBuilder.DropColumn(
                name: "HeightMm",
                table: "document_versions");

            migrationBuilder.DropColumn(
                name: "SchemaVersion",
                table: "document_versions");

            migrationBuilder.DropColumn(
                name: "ViewBox",
                table: "document_versions");

            migrationBuilder.DropColumn(
                name: "WidthMm",
                table: "document_versions");
        }
    }
}

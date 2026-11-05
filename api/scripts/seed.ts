import "../src/env.js";
import { createHash } from "node:crypto";
import { Pool } from "pg";
import metadata from "../ConnectorMetadata.json" with { type: "json" };

const namespace = "442fa2a4-c95e-5de8-9df4-5268e093dad9";
const connectorLabels: Record<string, string> = {
  sftp: "SFTP",
  sharepoint: "SharePoint",
  s3: "Amazon S3",
  azure_blob: "Azure Blob or ADLS",
  rest_api: "REST API",
};
const masterListCodes: Record<string, Record<string, string>> = {
  sftp: { auth_type: "SFTP_AUTH_TYPE" },
  sharepoint: { auth_type: "SHAREPOINT_AUTH_TYPE", graph_api_version: "SHAREPOINT_GRAPH_VERSION" },
  s3: { region: "S3_REGION", auth_type: "S3_AUTH_TYPE", encryption_type: "S3_ENCRYPTION" },
  azure_blob: { endpoint_type: "AZURE_ENDPOINT_TYPE", auth_type: "AZURE_AUTH_TYPE" },
  rest_api: { auth_type: "REST_AUTH_TYPE" },
};

function stableUuid(value: string) {
  const bytes = createHash("sha1").update(namespace).update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function seed() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const schema = metadata.connection_metadata_schema;
    for (const [code, connector] of Object.entries(schema)) {
      if (code === "db2") continue;
      const connectorId = stableUuid(`connector:${code}`);
      await client.query(
        `INSERT INTO connector_type (connector_key, connector_name, runtime_type, auth_field_key)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (connector_key) DO UPDATE
         SET connector_name = EXCLUDED.connector_name,
             runtime_type = EXCLUDED.runtime_type,
             auth_field_key = EXCLUDED.auth_field_key`,
        [connectorId, connectorLabels[code], connector.type.value, "auth_type" in connector.fields ? "auth_type" : ""],
      );
      const fields = Object.entries(connector.fields);
      for (const [index, [fieldCode, field]] of fields.entries()) {
        const validation = field.validation ?? null;
        const defaultValue = field.default === undefined ? null : typeof field.default === "object"
          ? JSON.stringify(field.default)
          : String(field.default);
        await client.query(
          `INSERT INTO connector_field
            (connector_key, connector_field_key, label, storage, data_type, ui_hint,
             mandatory, default_value, placeholder, help_text, max_length, validation,
             master_list_code, depends_on_field, depends_on_value, mask_on_edit, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16, $17)
           ON CONFLICT (connector_field_key) DO UPDATE SET
             label = EXCLUDED.label, storage = EXCLUDED.storage, data_type = EXCLUDED.data_type,
             ui_hint = EXCLUDED.ui_hint, mandatory = EXCLUDED.mandatory, default_value = EXCLUDED.default_value,
             placeholder = EXCLUDED.placeholder, help_text = EXCLUDED.help_text, max_length = EXCLUDED.max_length,
             validation = EXCLUDED.validation, master_list_code = EXCLUDED.master_list_code,
             depends_on_field = EXCLUDED.depends_on_field, depends_on_value = EXCLUDED.depends_on_value,
             mask_on_edit = EXCLUDED.mask_on_edit, sort_order = EXCLUDED.sort_order`,
          [
            connectorId,
            stableUuid(`field:${code}:${fieldCode}`),
            field.label,
            field.storage,
            field.data_type,
            field.ui_hint,
            field.mandatory,
            defaultValue,
            field.placeholder ?? null,
            field.help ?? null,
            field.max_length ?? null,
            JSON.stringify(validation),
            masterListCodes[code]?.[fieldCode] ?? null,
            field.depends_on?.field ?? null,
            field.depends_on ? String(field.depends_on.value) : null,
            field.mask_on_edit ?? false,
            index + 1,
          ],
        );
      }
    }
    await client.query("COMMIT");
    console.log("Connector catalog seeded (DB2 excluded).");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch((error: unknown) => {
  console.error("Connector catalog seed failed:", error);
  process.exitCode = 1;
});

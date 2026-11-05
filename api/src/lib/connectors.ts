import { createHash } from "node:crypto";
import metadata from "../../ConnectorMetadata.json" with { type: "json" };

export const CONNECTOR_LABELS: Record<string, string> = {
  sftp: "SFTP",
  sharepoint: "SharePoint",
  s3: "Amazon S3",
  azure_blob: "Azure Blob or ADLS",
  rest_api: "REST API",
};

export const CONNECTOR_ICONS: Record<string, string> = {
  sftp: "⇧",
  sharepoint: "▦",
  s3: "☁",
  azure_blob: "▤",
  rest_api: "↗",
};

export const CONNECTOR_COLORS: Record<string, string> = {
  sftp: "#40b883",
  sharepoint: "#f17b37",
  s3: "#2c9ba7",
  azure_blob: "#3974d0",
  rest_api: "#9670cf",
};

export type ConnectorCode = keyof typeof CONNECTOR_LABELS;
export type ConnectorCatalogSource = "config" | "postgres";
export type FieldDefinition = {
  label: string;
  mandatory: boolean;
  storage: "db" | "keyvault";
  data_type: "string" | "integer" | "boolean" | "enum" | "object";
  ui_hint: string;
  default?: string | number | boolean | Record<string, unknown>;
  validation?: Record<string, unknown> | null;
  placeholder?: string | null;
  help?: string;
  max_length?: number;
  allowed_values?: string[];
  depends_on?: { field: string; value: string | boolean; operator?: string } | null;
  mask_on_edit?: boolean;
};

export type ConnectorDefinition = {
  type: { value: string; storage: string; editable: boolean };
  fields: Record<string, FieldDefinition>;
};

const schema = metadata.connection_metadata_schema as Record<string, ConnectorDefinition>;

export const CONNECTORS = Object.keys(CONNECTOR_LABELS).map((code) => ({
  code: code as ConnectorCode,
  name: CONNECTOR_LABELS[code],
  runtimeType: schema[code].type.value,
  fields: schema[code].fields,
}));

export function resolveConnectorCatalogSource(
  nodeEnv = process.env.NODE_ENV,
  configuredSource = process.env.CONNECTOR_CATALOG_SOURCE,
): ConnectorCatalogSource | undefined {
  if (nodeEnv === "production") return "postgres";
  const source = configuredSource?.trim().toLowerCase() || "auto";
  if (source === "auto" || source === "config") return "config";
  if (source === "postgres") return "postgres";
  return undefined;
}

export function getConnector(code: string) {
  if (!(code in CONNECTOR_LABELS)) return undefined;
  return CONNECTORS.find((connector) => connector.code === code);
}

export function getFieldId(connectorCode: string, fieldCode: string) {
  const namespace = "442fa2a4-c95e-5de8-9df4-5268e093dad9";
  const bytes = createHash("sha1")
    .update(namespace)
    .update(`field:${connectorCode}:${fieldCode}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function getConnectorId(connectorCode: string) {
  const namespace = "442fa2a4-c95e-5de8-9df4-5268e093dad9";
  const bytes = createHash("sha1")
    .update(namespace)
    .update(`connector:${connectorCode}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function getConnectionAuth(code: string, values: Record<string, unknown>) {
  const connector = getConnector(code);
  if (!connector) return "—";
  const authKey = "auth_type" in connector.fields ? "auth_type" : "auth_mode";
  const authValue = values[authKey];
  if (typeof authValue === "string") return authValue;
  return connector.fields[authKey]?.default?.toString() ?? "—";
}

export function validateConnectorFields(
  connector: NonNullable<ReturnType<typeof getConnector>>,
  input: Record<string, unknown>,
  existingSecretKeys: Set<string> = new Set(),
) {
  const errors: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const secretValues: Record<string, string> = {};

  for (const [key, field] of Object.entries(connector.fields)) {
    const dependency = field.depends_on;
    if (dependency && input[dependency.field] !== dependency.value) continue;

    const raw = input[key];
    const value = raw === undefined || raw === null ? field.default : raw;
    if ((value === undefined || value === null || value === "") && field.mandatory) {
      if (!(field.storage === "keyvault" && existingSecretKeys.has(key))) {
        errors[key] = `${field.label} is required.`;
      }
      continue;
    }
    if (value === undefined || value === null || value === "") continue;

    if (field.storage === "keyvault" && (typeof value !== "string" || value.length === 0)) {
      errors[key] = `${field.label} must be text.`;
      continue;
    }
    if (field.data_type === "integer" && (!Number.isInteger(value) || typeof value !== "number")) {
      errors[key] = `${field.label} must be a whole number.`;
      continue;
    }
    if (field.data_type === "boolean" && typeof value !== "boolean") {
      errors[key] = `${field.label} must be true or false.`;
      continue;
    }
    if (field.data_type === "enum" && !field.allowed_values?.includes(String(value))) {
      errors[key] = `${field.label} is not an allowed option.`;
      continue;
    }
    if (field.data_type === "object" && (typeof value !== "object" || Array.isArray(value))) {
      errors[key] = `${field.label} must be a JSON object.`;
      continue;
    }
    if (typeof value === "string" && field.max_length && value.length > field.max_length) {
      errors[key] = `${field.label} must be no longer than ${field.max_length} characters.`;
      continue;
    }
    if (field.data_type === "string" && key.endsWith("_url")) {
      try {
        const parsed = new URL(String(value));
        const containsQuery = ["site_url", "base_url", "token_url"].includes(key) && parsed.search.length > 0;
        if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash || containsQuery) {
          errors[key] = `${field.label} must use HTTPS and cannot include credentials, query parameters, or a fragment.`;
        }
      } catch {
        errors[key] = `${field.label} must be a valid HTTPS URL.`;
      }
      if (errors[key]) continue;
    }
    if (connector.code === "rest_api" && key === "extra_headers" && typeof value === "object" && value !== null) {
      const sensitiveHeader = Object.keys(value).find((header) =>
        /^(authorization|proxy-authorization|cookie|set-cookie)$/i.test(header) ||
        /(token|secret|password|credential|api[-_]?key)/i.test(header),
      );
      if (sensitiveHeader) {
        errors[key] = "Authentication material must use the dedicated credential fields, not additional headers.";
        continue;
      }
    }
    if (connector.code === "rest_api" && key === "ssl_verify" && value === false) {
      errors[key] = "TLS certificate verification is required by security policy.";
      continue;
    }

    const rules = field.validation;
    if (rules) {
      const stringValue = typeof value === "string" ? value : String(value);
      if (typeof rules.min === "number" && Number(value) < rules.min) {
        errors[key] = `${field.label} must be at least ${rules.min}.`;
      } else if (typeof rules.max === "number" && Number(value) > rules.max) {
        errors[key] = `${field.label} must be at most ${rules.max}.`;
      } else if (typeof rules.min_length === "number" && stringValue.length < rules.min_length) {
        errors[key] = String(rules.message ?? `${field.label} is too short.`);
      } else if (typeof rules.starts_with === "string" && !stringValue.startsWith(rules.starts_with)) {
        errors[key] = String(rules.message ?? `${field.label} has an invalid format.`);
      } else if (typeof rules.pattern === "string" && !new RegExp(rules.pattern).test(stringValue)) {
        errors[key] = String(rules.message ?? `${field.label} has an invalid format.`);
      } else if (rules.valid_json === true && typeof value === "string") {
        try {
          const parsed: unknown = JSON.parse(value);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            errors[key] = String(rules.message ?? `${field.label} must be a JSON object.`);
          }
        } catch {
          errors[key] = String(rules.message ?? `${field.label} must be valid JSON.`);
        }
      }
    }
    if (errors[key]) continue;
    if (field.storage === "keyvault") secretValues[key] = value as string;
    else values[key] = value;
  }

  for (const inputKey of Object.keys(input)) {
    if (!(inputKey in connector.fields)) errors[inputKey] = "Unknown connection field.";
  }
  return { errors, values, secretValues };
}

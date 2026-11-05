"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { UserSession } from "@/lib/types";

type Field = {
  key: string;
  label: string;
  storage: "db" | "keyvault";
  data_type: "string" | "integer" | "boolean" | "enum" | "object";
  ui_hint: string;
  mandatory: boolean;
  default?: string | number | boolean | Record<string, unknown>;
  placeholder?: string | null;
  help?: string;
  max_length?: number;
  allowed_values?: string[];
  validation?: Record<string, unknown> | null;
  depends_on?: { field: string; value: string | boolean; operator?: string } | null;
  mask_on_edit?: boolean;
};

type Connector = {
  code: string;
  name: string;
  runtimeType: string;
  connectorId: string;
  fields: Field[];
};

type Connection = {
  id: string;
  name: string;
  connectorCode: string;
  connectorName: string;
  runtimeType: string;
  auth: string;
  status: "untested" | "connected" | "warning" | "failed";
  lastTestedAt: string | null;
  isTested: boolean;
  lastTestMessage: string | null;
  datasetCount: number | null;
  config: Record<string, unknown>;
  secretFields: string[];
};

type SortKey = "name" | "connectorName" | "auth" | "status" | "datasetCount";

const TYPE_MARKS: Record<string, string> = { sftp: "SFTP", sharepoint: "SP", s3: "S3", azure_blob: "AZ", rest_api: "API" };
// Rail labels and order follow Figma "Left rail · Super admin".
const RAIL_ITEMS = [
  { label: "Overview", icon: "icon-home" },
  { label: "Tenants", icon: "icon-admin" },
  { label: "Master setup", icon: "icon-document" },
  { label: "Audit trail", icon: "icon-history" },
  { label: "Settings", icon: "icon-settings" },
];
// Display labels for enum values from ConnectorMetadata.json; unlisted values show as stored.
const OPTION_LABELS: Record<string, string> = {
  server: "Server", server_encrypt: "Server encrypt",
  password: "Password", private_key: "Private key",
  oauth2_client_credentials: "OAuth 2.0 client credentials",
  access_key: "Access key", iam_role: "IAM role", instance_profile: "Instance profile",
  managed_identity: "Managed identity", service_principal: "Service principal", account_key: "Account key", sas_token: "SAS token",
  none: "None", basic: "Basic", bearer: "Bearer token", oauth2: "OAuth 2.0", api_key: "API key",
};
const optionLabel = (value: string) => OPTION_LABELS[value] ?? value;

type Toast = { message: string; tone: "pending" | "success" | "error" };
const STATUS_LABEL: Record<Connection["status"], string> = {
  untested: "Untested", connected: "Connected", warning: "Warning", failed: "Failed",
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store" });
  const result = (await response.json()) as T & { error?: string; details?: unknown };
  if (!response.ok) {
    const details =
      typeof result.details === "object" && result.details !== null
        ? Object.entries(result.details).map(([key, value]) => `${key}: ${String(value)}`).join(" ")
        : "";
    throw new Error([result.error ?? "Request failed.", details].filter(Boolean).join(" "));
  }
  return result;
}

function valuesForForm(connector: Connector, connection?: Connection) {
  const values: Record<string, unknown> = {};
  for (const field of connector.fields) {
    if (field.storage === "keyvault") {
      values[field.key] = "";
    } else if (connection && field.key in connection.config) {
      const current = connection.config[field.key];
      values[field.key] =
        field.data_type === "object" && typeof current === "object" && current !== null
          ? JSON.stringify(current, null, 2)
          : current;
    } else if (field.default !== undefined) {
      values[field.key] =
        field.data_type === "object" && typeof field.default === "object" && field.default !== null
          ? JSON.stringify(field.default, null, 2)
          : field.default;
    } else {
      values[field.key] = field.data_type === "boolean" ? false : "";
    }
  }
  return values;
}

function fieldIsVisible(field: Field, values: Record<string, unknown>) {
  if (!field.depends_on) return true;
  const actual = values[field.depends_on.field];
  return field.depends_on.operator === "not_equals"
    ? actual !== field.depends_on.value
    : actual === field.depends_on.value;
}

function getPayloadFields(connector: Connector, values: Record<string, unknown>) {
  const fields: Record<string, unknown> = {};
  for (const field of connector.fields) {
    if (!fieldIsVisible(field, values)) continue;
    let value = values[field.key];
    if (field.storage === "db" && field.data_type === "object" && typeof value === "string" && value.trim()) {
      try {
        value = JSON.parse(value) as unknown;
      } catch {
        throw new Error(`${field.label} must contain valid JSON.`);
      }
    }
    fields[field.key] = value;
  }
  return fields;
}

function clearSecretValues(connector: Connector, values: Record<string, unknown>) {
  const cleared = { ...values };
  for (const field of connector.fields) {
    if (field.storage === "keyvault") cleared[field.key] = "";
  }
  return cleared;
}

export default function ConnectionManager({ user }: { user: UserSession }) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [datasetUsageAvailable, setDatasetUsageAvailable] = useState(false);
  const [datasetUsageError, setDatasetUsageError] = useState("");
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState("");
  const [toast, setToast] = useState<Toast | null>(null);
  const [result, setResult] = useState<{ title: string; message: string } | null>(null);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [ascending, setAscending] = useState(true);
  const [railOpen, setRailOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [modal, setModal] = useState<"form" | "delete" | null>(null);
  const [selected, setSelected] = useState<Connection | null>(null);
  const [formValues, setFormValues] = useState<Record<string, unknown>>({});
  const [name, setName] = useState("");
  const [connectorCode, setConnectorCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const [testMessage, setTestMessage] = useState("");
  const [testState, setTestState] = useState<"idle" | "testing" | "success" | "error">("idle");

  const load = useCallback(async () => {
    setLoading(true);
    setPageError("");
    const [connectionResult, connectorResult] = await Promise.allSettled([
      api<{ connections: Connection[]; datasetUsageAvailable: boolean; datasetUsageError: string | null }>("/api/connections"),
      api<{ connectors: Connector[] }>("/api/connectors"),
    ]);
    const errors: string[] = [];

    if (connectionResult.status === "fulfilled") {
      setConnections(connectionResult.value.connections);
      setDatasetUsageAvailable(connectionResult.value.datasetUsageAvailable);
      setDatasetUsageError(connectionResult.value.datasetUsageError ?? "");
    } else {
      setConnections([]);
      errors.push(
        connectionResult.reason instanceof Error
          ? connectionResult.reason.message
          : "Could not load connections.",
      );
    }

    if (connectorResult.status === "fulfilled") {
      setConnectors(connectorResult.value.connectors);
    } else {
      setConnectors([]);
      errors.push(
        connectorResult.reason instanceof Error
          ? connectorResult.reason.message
          : "Could not load connector types.",
      );
    }

    setPageError(errors.join(" "));
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Result dialogs and success toasts dismiss themselves; error toasts stay until closed.
  useEffect(() => {
    if (!result) return;
    const timer = window.setTimeout(() => setResult(null), 2500);
    return () => window.clearTimeout(timer);
  }, [result]);
  useEffect(() => {
    if (toast?.tone !== "success") return;
    const timer = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const currentConnector = connectors.find((connector) => connector.code === connectorCode);
  const filteredConnections = useMemo(() => {
    const filtered = connections.filter((connection) => {
      const matchesQuery = `${connection.name} ${connection.connectorName} ${connection.auth}`
        .toLowerCase().includes(query.trim().toLowerCase());
      return matchesQuery &&
        (!typeFilter || connection.connectorCode === typeFilter) &&
        (!statusFilter || connection.status === statusFilter);
    });
    return filtered.sort((left, right) => {
      const a = left[sortKey] ?? "";
      const b = right[sortKey] ?? "";
      const result = typeof a === "number" && typeof b === "number"
        ? a - b
        : String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
      return ascending ? result : -result;
    });
  }, [connections, query, sortKey, ascending, typeFilter, statusFilter]);

  function resetTest() {
    setTestMessage("");
    setTestState("idle");
  }

  function startCreate() {
    setSelected(null);
    setName("");
    setConnectorCode("");
    setFormValues({});
    setFormError("");
    resetTest();
    setModal("form");
  }

  function startEdit(connection: Connection) {
    const connector = connectors.find((item) => item.code === connection.connectorCode);
    if (!connector) return;
    setSelected(connection);
    setName(connection.name);
    setConnectorCode(connection.connectorCode);
    setFormValues(valuesForForm(connector, connection));
    setFormError("");
    resetTest();
    setModal("form");
  }

  function changeConnector(code: string) {
    const connector = connectors.find((item) => item.code === code);
    setConnectorCode(code);
    setFormValues(connector ? valuesForForm(connector) : {});
    resetTest();
  }

  function setField(field: Field, value: unknown) {
    setFormValues((current) => ({ ...current, [field.key]: value }));
    setFormError("");
    resetTest();
  }

  function requestBody(connector: Connector) {
    return {
      name,
      connectorCode: connector.code,
      fields: getPayloadFields(connector, formValues),
      ...(selected ? { connectionId: selected.id } : {}),
    };
  }

  async function saveConnection(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!currentConnector) return;
    setBusy(true);
    setFormError("");
    try {
      const body = requestBody(currentConnector);
      await api(selected ? `/api/connections/${selected.id}` : "/api/connections", {
        method: selected ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      setModal(null);
      setResult({
        title: "Saved successfully",
        message: selected ? `Your changes to ${name} are saved.` : `${name} is saved and listed in Connection manager.`,
      });
      await load();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Could not save connection.");
    } finally {
      setFormValues((values) => clearSecretValues(currentConnector, values));
      setBusy(false);
    }
  }

  async function testConnection() {
    if (!currentConnector) return;
    setBusy(true);
    setFormError("");
    setTestMessage("");
    setTestState("testing");
    try {
      const response = await api<{ result: { status: "success" | "failed"; message: string } }>("/api/connections/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody(currentConnector)),
      });
      const passed = response.result.status === "success";
      setTestMessage(passed ? "" : response.result.message);
      setTestState(passed ? "success" : "error");
      if (selected) await load();
    } catch (error) {
      setTestMessage(error instanceof Error ? error.message : "Connection test failed.");
      setTestState("error");
    } finally {
      setFormValues((values) => clearSecretValues(currentConnector, values));
      setBusy(false);
    }
  }

  async function deleteConnection() {
    if (!selected) return;
    setBusy(true);
    setFormError("");
    try {
      const deleted = await api<{ cleanupWarnings: string[] }>(`/api/connections/${selected.id}`, {
        method: "DELETE",
      });
      setModal(null);
      setSelected(null);
      setResult({
        title: "Connection deleted",
        message: `${selected.name} has been deleted and its Key Vault secrets are revoked.`,
      });
      if (deleted.cleanupWarnings.length) setToast({ message: deleted.cleanupWarnings.join(" "), tone: "error" });
      await load();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Could not delete connection.");
    } finally {
      setBusy(false);
    }
  }

  async function testRow(connection: Connection) {
    setBusy(true);
    setToast({ message: `Testing ${connection.name}.`, tone: "pending" });
    try {
      const response = await api<{ result: { status: "success" | "failed" } }>("/api/connections/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connectionId: connection.id,
          name: connection.name,
          connectorCode: connection.connectorCode,
          fields: connection.config,
        }),
      });
      setToast(response.result.status === "success"
        ? { message: `${connection.name} connected. Test passed.`, tone: "success" }
        : { message: `${connection.name} test failed. Open Edit to review the result.`, tone: "error" });
      await load();
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : `${connection.name} test failed.`, tone: "error" });
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    await api("/api/auth/logout", { method: "POST" });
    window.location.assign("/login");
  }

  function sortBy(key: SortKey) {
    if (sortKey === key) setAscending((value) => !value);
    else { setSortKey(key); setAscending(true); }
  }

  function closeModal() {
    if (busy) return;
    if (currentConnector) {
      setFormValues((values) => clearSecretValues(currentConnector, values));
    }
    setModal(null);
    setFormError("");
  }

  return (
    <div className={`app-shell${railOpen ? " rail-open" : ""}`}>
      <aside className="left-rail" aria-label="Main navigation">
        <img className="rail-logo" src="/figma/logo-mark.svg" alt="Genpact" width={23} height={30} />
        <div className="rail-divider" />
        {RAIL_ITEMS.map((item) => (
          <a className="rail-item disabled" aria-disabled="true" aria-label={item.label} key={item.label}>
            <img src={`/figma/${item.icon}.svg`} alt="" width={24} height={24} />
            <span>{item.label}</span>
          </a>
        ))}
        <Link className="rail-item active" href="/" aria-label="Connection manager" aria-current="page">
          <img src="/figma/icon-connection.svg" alt="" width={24} height={24} />
          <span>Connection manager</span>
        </Link>
      </aside>

      <div className="main-area">
        <header className="topbar">
          <button className="menu-button" onClick={() => setRailOpen((value) => !value)} aria-label="Toggle navigation" aria-expanded={railOpen}>
            <img src="/figma/icon-menu.svg" alt="" width={17} height={17} />
          </button>
          <span className="product-name">Enterprise 360</span>
          <span className="topbar-spacer" />
          <button className="theme-button" title="Theme" aria-label="Theme">
            <img src="/figma/icon-theme.svg" alt="" width={24} height={24} />
          </button>
          <div className="user-menu-wrap">
            <button className="user-menu" onClick={() => setUserMenuOpen((value) => !value)} aria-haspopup="menu" aria-expanded={userMenuOpen} title={user.email ?? user.subject}>
              <span className="avatar">{initials(user.name ?? user.subject)}</span>
              <span>{user.name ?? user.subject} · {roleLabel(user.role)}</span>
              <img src="/figma/icon-chevron.svg" alt="" width={8} height={4} />
            </button>
            {userMenuOpen && (
              <div className="user-dropdown" role="menu">
                <button role="menuitem" onClick={() => void logout()}>Sign out</button>
              </div>
            )}
          </div>
        </header>

        <main className="page-content">
          <div className="page-header">
            <h1>Connection manager</h1>
            <button className="button button-primary" onClick={startCreate}>+ New connection</button>
          </div>

          {pageError && <div className="alert alert-error" role="alert"><span>!</span>{pageError}<button onClick={() => void load()}>Retry</button></div>}

          <section className="table-card">
            <div className="card-head">
              <div className="card-title"><h2>Connections</h2><span>{connections.length} connection{connections.length === 1 ? "" : "s"}</span></div>
              <div className="table-actions">
                <select className="pill-select" aria-label="Filter by connector" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}>
                  <option value="">All types</option>
                  {connectors.map((connector) => <option key={connector.code} value={connector.code}>{connector.name}</option>)}
                </select>
                <select className="pill-select" aria-label="Filter by status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
                  <option value="">All statuses</option>
                  {Object.entries(STATUS_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
                <label className="search-field">
                  <img src="/figma/icon-search.svg" alt="" width={24} height={24} />
                  <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search connections" aria-label="Search connections" />
                </label>
              </div>
            </div>
            <div className="table-scroll">
              <table className="connection-table">
                <thead><tr>
                  <th><button onClick={() => sortBy("name")}>Connection <SortMark active={sortKey === "name"} ascending={ascending} /></button></th>
                  <th><button onClick={() => sortBy("connectorName")}>Type <SortMark active={sortKey === "connectorName"} ascending={ascending} /></button></th>
                  <th><button onClick={() => sortBy("auth")}>Authentication <SortMark active={sortKey === "auth"} ascending={ascending} /></button></th>
                  <th><button onClick={() => sortBy("status")}>Status <SortMark active={sortKey === "status"} ascending={ascending} /></button></th>
                  <th><button onClick={() => sortBy("datasetCount")}>Integrations <SortMark active={sortKey === "datasetCount"} ascending={ascending} /></button></th>
                  <th>Actions</th>
                </tr></thead>
                <tbody>
                  {loading ? (
                    <tr><td colSpan={6} className="table-message"><span className="spinner" /> Loading connections…</td></tr>
                  ) : filteredConnections.length === 0 ? (
                    <tr><td colSpan={6} className="table-message">
                      {connections.length ? "No connections match your filters." : <>No connections yet. Select <strong>New connection</strong> to add your first source.</>}
                    </td></tr>
                  ) : filteredConnections.map((connection) => (
                    <tr key={connection.id}>
                      <td className="cell-connection">
                        <div className="connection-name-cell">
                          <span className="type-mark">{TYPE_MARKS[connection.connectorCode] ?? connection.connectorCode.slice(0, 3).toUpperCase()}</span>
                          <span><strong>{connection.name}</strong><small>{connection.runtimeType}</small></span>
                        </div>
                      </td>
                      <td>{connection.connectorName}</td>
                      <td>{optionLabel(connection.auth)}</td>
                      <td className="cell-status"><StatusTag status={connection.status} /></td>
                      <td>
                        {connection.datasetCount === null
                          ? <span title={datasetUsageError || "Usage is not yet available from the Dataset module"}>—</span>
                          : `${connection.datasetCount} dataset${connection.datasetCount === 1 ? "" : "s"}`}
                      </td>
                      <td className="cell-actions">
                        <div className="row-actions">
                          <button className="row-action" onClick={() => void testRow(connection)} disabled={busy} aria-label={`Test ${connection.name}`}>
                            <img src="/figma/icon-test.svg" alt="" width={18} height={18} />Test
                          </button>
                          <button className="row-action" onClick={() => startEdit(connection)} aria-label={`Edit ${connection.name}`}>
                            <img src="/figma/icon-edit.svg" alt="" width={18} height={18} />Edit
                          </button>
                          <button className="row-action row-action-danger" onClick={() => { setSelected(connection); setFormError(""); setModal("delete"); }} aria-label={`Delete ${connection.name}`}>
                            <img src="/figma/icon-delete.svg" alt="" width={18} height={18} />Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!loading && connections.length > 0 && !datasetUsageAvailable && (
              <p className="table-note">{datasetUsageError || "Dataset counts are unavailable until the Dataset module is connected."}</p>
            )}
          </section>
        </main>
      </div>

      {modal === "form" && (
        <div className="overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) closeModal(); }}>
          <section className="modal connection-modal" role="dialog" aria-modal="true" aria-labelledby="connection-modal-title">
            <header className="modal-header">
              <h2 id="connection-modal-title">{selected ? "Edit connection" : "New connection"}</h2>
              <button className="icon-button" onClick={closeModal} aria-label="Close">
                <img src="/figma/icon-close.svg" alt="" width={18} height={18} />
              </button>
            </header>
            <form onSubmit={saveConnection}>
              <div className="modal-body">
                <div className="form-grid">
                  <label className="field">
                    <span>Connection name<b>*</b></span>
                    <input required maxLength={50} value={name} onChange={(event) => { setName(event.target.value); resetTest(); }} placeholder="For example, Prod DB2 · Finance" />
                  </label>
                  <label className="field">
                    <span>Connector type<b>*</b></span>
                    <select required value={connectorCode} disabled={Boolean(selected)} className={connectorCode ? "" : "is-placeholder"} onChange={(event) => changeConnector(event.target.value)}>
                      <option value="">Select a connector type</option>
                      {connectors.map((connector) => <option key={connector.code} value={connector.code}>{connector.name}</option>)}
                    </select>
                  </label>
                </div>
                {!currentConnector && (
                  <div className="empty-state">
                    <strong>Choose a connector type</strong>
                    <span>The fields this connection needs appear here once you pick a type.</span>
                  </div>
                )}
                {currentConnector && (
                  <>
                    <div className="section-title">Connection details · {currentConnector.name}</div>
                    <div className="form-grid connector-fields">
                      {currentConnector.fields.map((field) => {
                        if (!fieldIsVisible(field, formValues)) return null;
                        const currentValue = formValues[field.key] ?? "";
                        const storedSecret = selected?.secretFields.includes(field.key) ?? false;
                        const controlId = `field-${field.key}`;
                        const savedPlaceholder = storedSecret ? "Saved value hidden" : field.placeholder ?? "";
                        const helpers = [
                          field.help ?? (field.key === "ssl_verify" ? "TLS certificate verification is enforced by security policy." : null),
                          field.storage === "keyvault"
                            ? storedSecret ? "Stored in Azure Key Vault. Leave blank to keep the saved value." : "Stored in Azure Key Vault"
                            : null,
                        ].filter(Boolean);
                        return (
                          <label className={`field${field.ui_hint === "textarea" || field.ui_hint === "json_editor" ? " field-full" : ""}`} key={field.key} htmlFor={controlId}>
                            <span>{field.label}{field.mandatory && <b>*</b>}</span>
                            {field.ui_hint === "toggle" ? (
                              <span className="toggle-row">
                                <input id={controlId} className="toggle-input" type="checkbox" checked={currentValue === true} disabled={field.key === "ssl_verify"} onChange={(event) => setField(field, event.target.checked)} />
                                <span>{currentValue === true ? "On" : "Off"}</span>
                              </span>
                            ) : field.ui_hint === "dropdown" ? (
                              <select id={controlId} value={String(currentValue)} className={currentValue === "" ? "is-placeholder" : ""} onChange={(event) => setField(field, event.target.value)}>
                                <option value="">Select an option</option>
                                {(field.allowed_values ?? []).map((option) => <option key={option} value={option}>{optionLabel(option)}</option>)}
                              </select>
                            ) : field.ui_hint === "readonly" ? (
                              <input id={controlId} value={String(currentValue)} readOnly />
                            ) : field.ui_hint === "textarea" || field.ui_hint === "json_editor" ? (
                              <textarea
                                id={controlId}
                                rows={field.ui_hint === "json_editor" ? 4 : 3}
                                className={field.ui_hint === "json_editor" ? "mono-input" : ""}
                                maxLength={field.max_length}
                                value={String(currentValue)}
                                onChange={(event) => setField(field, event.target.value)}
                                placeholder={savedPlaceholder}
                              />
                            ) : (
                              <input
                                id={controlId}
                                type={field.ui_hint === "password" ? "password" : field.ui_hint === "number" ? "number" : "text"}
                                min={typeof field.validation?.min === "number" ? field.validation.min : undefined}
                                max={typeof field.validation?.max === "number" ? field.validation.max : undefined}
                                maxLength={field.max_length}
                                value={String(currentValue)}
                                onChange={(event) => setField(field, field.data_type === "integer" && event.target.value !== "" ? Number(event.target.value) : event.target.value)}
                                placeholder={savedPlaceholder}
                                autoComplete="off"
                              />
                            )}
                            {helpers.map((text) => <small key={text}>{text}</small>)}
                          </label>
                        );
                      })}
                    </div>
                  </>
                )}
                {formError && <div className="alert alert-error" role="alert"><span>!</span>{formError}</div>}
                {testState === "error" && testMessage && <div className="alert alert-error" role="alert"><span>!</span>{testMessage}</div>}
              </div>
              <footer className="modal-footer">
                <button type="button" className="button button-secondary" onClick={closeModal} disabled={busy}>Cancel</button>
                <div className="modal-footer-actions">
                  {testState === "testing" && (
                    <span className="test-status" role="status"><img className="spin" src="/figma/spinner.svg" alt="" width={12} height={12} />Testing connection</span>
                  )}
                  {testState === "success" && (
                    <span className="test-status test-passed" role="status"><img src="/figma/icon-check.svg" alt="" width={16} height={16} />Connection successful</span>
                  )}
                  <button type="button" className="button button-secondary" onClick={() => void testConnection()} disabled={busy || !currentConnector}>
                    {testState === "testing" ? "Testing" : "Test connection"}
                  </button>
                  <button type="submit" className="button button-primary" disabled={busy || !currentConnector}>
                    {selected ? "Save changes" : "Save connection"}
                  </button>
                </div>
              </footer>
            </form>
          </section>
        </div>
      )}

      {modal === "delete" && selected && (
        <div className="overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) closeModal(); }}>
          <section className="modal dialog-modal" role="dialog" aria-modal="true" aria-labelledby="delete-title">
            <div className="dialog-body">
              <div className="dialog-icon dialog-icon-danger"><img src="/figma/icon-delete-lg.svg" alt="" width={24} height={24} /></div>
              <h2 id="delete-title">Delete connection?</h2>
              <p>Delete {selected.name}? Its Key Vault secrets are revoked. This cannot be undone.</p>
              {selected.datasetCount === null ? (
                <div className="alert alert-warning">Dataset usage cannot currently be verified. Deletion is blocked until the Dataset module is connected.</div>
              ) : selected.datasetCount > 0 && (
                <div className="alert alert-warning">This connection is used by {selected.datasetCount} dataset{selected.datasetCount === 1 ? "" : "s"} and cannot be deleted.</div>
              )}
              {formError && <div className="alert alert-error" role="alert">{formError}</div>}
            </div>
            <footer className="dialog-footer">
              <button className="button button-secondary" onClick={closeModal} disabled={busy}>Cancel</button>
              <button className="button button-danger" onClick={() => void deleteConnection()} disabled={busy || selected.datasetCount === null || selected.datasetCount > 0}>
                Delete connection
              </button>
            </footer>
          </section>
        </div>
      )}

      {result && (
        <div className="overlay" onMouseDown={() => setResult(null)}>
          <section className="modal dialog-modal" role="status" aria-live="polite">
            <div className="dialog-body">
              <div className="dialog-icon dialog-icon-success"><img src="/figma/icon-check-done.svg" alt="" width={24} height={24} /></div>
              <h2>{result.title}</h2>
              <p>{result.message}</p>
            </div>
          </section>
        </div>
      )}

      {toast && (
        <div className={`toast toast-${toast.tone}`} role={toast.tone === "error" ? "alert" : "status"}>
          {toast.tone === "error"
            ? <i aria-hidden="true" />
            : <img src={toast.tone === "success" ? "/figma/toast-success.svg" : "/figma/toast-pending.svg"} alt="" width={8} height={8} />}
          <span>{toast.message}</span>
          {toast.tone === "error" && <button onClick={() => setToast(null)} aria-label="Dismiss">×</button>}
        </div>
      )}
    </div>
  );
}

function SortMark({ active, ascending }: { active: boolean; ascending: boolean }) {
  return <span className={`sort-mark${active ? " sort-active" : ""}`}>{active ? ascending ? "↑" : "↓" : "↕"}</span>;
}

// Each status has its own marker shape as well as its colour (Figma "Status tag").
function StatusTag({ status }: { status: Connection["status"] }) {
  const marker = status === "connected" ? "/figma/marker-connected.svg" : status === "warning" ? "/figma/marker-warning.svg" : null;
  return (
    <span className={`status-tag status-${status}`}>
      {marker ? <img src={marker} alt="" width={10} height={10} /> : <i aria-hidden="true" />}
      {STATUS_LABEL[status]}
    </span>
  );
}

function initials(name: string) {
  const parts = name.trim().split(/[\s._@-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

function roleLabel(role: string) {
  const text = role.replace(/[_-]+/g, " ").trim();
  return text ? text[0].toUpperCase() + text.slice(1).toLowerCase() : "User";
}

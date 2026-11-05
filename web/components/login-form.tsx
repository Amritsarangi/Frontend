"use client";

import { useEffect, useState } from "react";

type Provider = { id: string; protocol: "oidc" | "oauth2" | "saml"; label: string };
type ProviderResult = { tenantName: string | null; providers: Provider[]; localLoginEnabled: boolean };

const DEFAULT_TENANT = process.env.NEXT_PUBLIC_DEFAULT_TENANT_ID ?? "";

export default function LoginForm() {
  const [tenantId, setTenantId] = useState(DEFAULT_TENANT);
  const [login, setLogin] = useState<ProviderResult>({
    tenantName: null,
    providers: [],
    localLoginEnabled: false,
  });
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    if (!/^[0-9a-f-]{36}$/i.test(tenantId)) {
      setLogin({ tenantName: null, providers: [], localLoginEnabled: false });
      return () => controller.abort();
    }
    fetch(`/api/auth/providers?tenantId=${encodeURIComponent(tenantId)}`, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load sign-in options.");
        return (await response.json()) as ProviderResult;
      })
      .then(setLogin)
      .catch((reason: unknown) => {
        if (reason instanceof Error && reason.name !== "AbortError") {
          setLogin({ tenantName: null, providers: [], localLoginEnabled: false });
        }
      });
    return () => controller.abort();
  }, [tenantId]);

  async function submitLocal(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const response = await fetch("/api/auth/local", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password, tenantId }),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Sign-in failed.");
      window.location.assign("/");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Sign-in failed.");
      setBusy(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-panel">
        <div className="login-brand">
          <img className="brand-mark" src="/figma/logo-mark.svg" alt="Genpact" width={23} height={30} />
          <div><strong>Enterprise 360</strong><span>GCC Tenant · Connection manager</span></div>
        </div>
        <div className="login-content">
          <span className="eyebrow">CLIENT ADMIN</span>
          <h1>Welcome back</h1>
          <p className="login-subtitle">Sign in to manage your data connections.</p>

          <label className="form-label" htmlFor="tenantId">Tenant ID</label>
          <input
            id="tenantId"
            className="text-input"
            autoComplete="organization"
            value={tenantId}
            onChange={(event) => setTenantId(event.target.value.trim())}
            placeholder="Your tenant UUID"
          />
          {login.tenantName && <p className="field-hint">Signing in to {login.tenantName}</p>}

          {login.providers.length > 0 && (
            <div className="sso-options">
              {login.providers.map((provider) => (
                <a
                  className="button button-primary full-width"
                  key={provider.id}
                  href={`/api/auth/${provider.protocol}/start/${encodeURIComponent(tenantId)}/${encodeURIComponent(provider.id)}`}
                >
                  <span className="sso-symbol">{provider.protocol === "saml" ? "S" : provider.protocol === "oidc" ? "O" : "↗"}</span>
                  Continue with {provider.label}
                </a>
              ))}
            </div>
          )}

          {login.providers.length > 0 && login.localLoginEnabled && <div className="login-divider"><span>OR</span></div>}

          {login.localLoginEnabled && (
            <form className="login-form" onSubmit={submitLocal}>
              <label className="form-label" htmlFor="username">Username</label>
              <input
                id="username"
                className="text-input"
                autoComplete="username"
                required
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
              <label className="form-label" htmlFor="password">Password</label>
              <input
                id="password"
                className="text-input"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              {error && <p className="alert alert-error" role="alert">{error}</p>}
              <button className="button button-primary full-width" disabled={busy}>
                {busy ? "Signing in…" : "Sign in"}
              </button>
              <p className="dev-notice">Development sign-in is enabled. It is unavailable in production.</p>
            </form>
          )}

          {!login.localLoginEnabled && login.providers.length === 0 && (
            <p className="alert alert-info">No sign-in providers are configured for this tenant.</p>
          )}
        </div>
        <p className="login-footer">Secure access for your organization</p>
      </section>
      <aside className="login-art">
        <div className="art-orbit orbit-one" />
        <div className="art-orbit orbit-two" />
        <div className="art-content">
          <div className="art-icon"><img src="/figma/icon-connection.svg" alt="" width={28} height={28} /></div>
          <span className="eyebrow">GCC TENANT · DATA SETUP</span>
          <h2>Every source,<br />securely connected.</h2>
          <p>Manage trusted data connections across your organization from one secure workspace.</p>
          <div className="art-line" />
          <span className="art-caption">ENTERPRISE DATA OPERATIONS</span>
        </div>
      </aside>
    </main>
  );
}

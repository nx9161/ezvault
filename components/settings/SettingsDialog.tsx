// SPDX-License-Identifier: MIT
// Project settings dialog: name, default template, duplicate policy,
// notes export format. Design §1.1 (project menu).

"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { startTour } from "@/lib/tour/launcher";
import { useUiStore } from "@/lib/store/ui";
import { useProject, useTemplates, key } from "@/lib/api/hooks";
import { patch, del, get, post, api } from "@/lib/api/client";
import { mutate } from "swr";
import { useRouter } from "next/navigation";
import { Dialog, ConfirmDialog } from "@/components/ui/Dialog";
import { DeleteEverythingDialog } from "@/components/settings/DeleteEverythingDialog";
import { ErrorCard } from "@/components/ui/Feedback";

export default function SettingsDialog({ projectId }: { projectId: string }) {
  const t = useTranslations("settings");
  const ta = useTranslations("app");
  const ti = useTranslations("import");
  const ts = useTranslations("shortcuts");
  const open = useUiStore((s) => s.settingsOpen);
  const setOpen = useUiStore((s) => s.setSettingsOpen);
  const pushToast = useUiStore((s) => s.pushToast);
  const router = useRouter();
  const { data: project, error, mutate: mutateProject } = useProject(projectId);
  const { data: templates } = useTemplates(projectId);

  const [name, setName] = useState("");
  const [defaultTemplate, setDefaultTemplate] = useState("");
  const [duplicatePolicy, setDuplicatePolicy] = useState("skip");
  const [notesFormat, setNotesFormat] = useState("html");
  const [defaultDensity, setDefaultDensity] = useState("300");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteEverythingOpen, setDeleteEverythingOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  // Wave D (row 25): Omeka S connection (credential encrypted server-side).
  const [omekaBaseUrl, setOmekaBaseUrl] = useState("");
  const [omekaIdentity, setOmekaIdentity] = useState("");
  const [omekaCredential, setOmekaCredential] = useState("");
  const [omekaStatus, setOmekaStatus] = useState<"ok" | "not_configured">("not_configured");
  const [omekaBusy, setOmekaBusy] = useState(false);
  const [omekaPushResult, setOmekaPushResult] = useState("");
  // Wave D (row 36): developer API tokens (secret shown once at creation).
  interface TokenView { id: string; name: string; prefix: string; scopes: string[]; last_used_at: string | null; revoked_at: string | null }
  const [tokens, setTokens] = useState<TokenView[]>([]);
  const [tokenName, setTokenName] = useState("");
  const [tokenRead, setTokenRead] = useState(true);
  const [tokenWrite, setTokenWrite] = useState(false);
  const [tokenSecret, setTokenSecret] = useState("");

  useEffect(() => {
    if (!open) return;
    void (async () => {
      try {
        const view = await get<{ base_url: string | null; key_identity: string | null; status: "ok" | "not_configured" }>(`/api/projects/${projectId}/omeka/settings`);
        setOmekaBaseUrl(view.base_url ?? "");
        setOmekaIdentity(view.key_identity ?? "");
        setOmekaStatus(view.status);
      } catch { /* the section renders its not-configured state */ }
      try {
        const list = await get<{ items: TokenView[] }>("/api/api-tokens");
        setTokens(list.items ?? []);
      } catch { /* token list stays empty */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open ]);

  async function saveOmeka() {
    setOmekaBusy(true);
    try {
      const view = await api<{ status: "ok" | "not_configured" }>(`/api/projects/${projectId}/omeka/settings`, {
        method: "PUT",
        body: { base_url: omekaBaseUrl.trim(), key_identity: omekaIdentity.trim(), ...(omekaCredential ? { key_credential: omekaCredential } : {}) },
      });
      setOmekaStatus(view.status);
      setOmekaCredential("");
      pushToast({ message: t("saved") });
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : "save failed", kind: "error" });
    } finally {
      setOmekaBusy(false);
    }
  }

  async function pushProjectToOmeka() {
    setOmekaBusy(true);
    setOmekaPushResult("");
    try {
      const res = await post<{ pushed: number; failed: number }>(`/api/projects/${projectId}/omeka/push-project`, {});
      setOmekaPushResult(t("omekaPushDone", { pushed: res.pushed, failed: res.failed }));
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : "push failed", kind: "error" });
    } finally {
      setOmekaBusy(false);
    }
  }

  async function createToken() {
    const scopes = [...(tokenRead ? ["read"] : []), ...(tokenWrite ? ["notes:write"] : [])];
    if (!tokenName.trim() || scopes.length === 0) return;
    try {
      const res = await post<{ token: TokenView; secret: string }>("/api/api-tokens", { name: tokenName.trim(), scopes });
      setTokenSecret(res.secret);
      setTokens((prev) => [res.token, ...prev]);
      setTokenName("");
      pushToast({ message: t("tokenCreated") });
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : "create failed", kind: "error" });
    }
  }

  async function revokeToken(id: string) {
    try {
      await del(`/api/api-tokens/${id}`);
      setTokens((prev) => prev.map((tk) => (tk.id === id ? { ...tk, revoked_at: new Date().toISOString() } : tk)));
      pushToast({ message: t("tokenRevoked") });
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : "revoke failed", kind: "error" });
    }
  }

  useEffect(() => {
    if (project) {
      setName(project.name);
      setDefaultTemplate(project.default_template_id ?? "");
      setDuplicatePolicy(project.duplicate_policy);
      setNotesFormat(project.notes_export_format);
      setDefaultDensity(String(project.default_density ?? 300));
    }
  }, [project]);

  if (!open) return null;

  async function save() {
    setSaving(true);
    try {
      await patch(`/api/projects/${projectId}`, {
        name: name.trim(),
        default_template_id: defaultTemplate || null,
        duplicate_policy: duplicatePolicy,
        notes_export_format: notesFormat,
        default_density: Math.min(1200, Math.max(36, Math.round(Number(defaultDensity) || 300))),
      });
      await mutateProject();
      pushToast({ message: t("saved") });
      setOpen(false);
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : "save failed", kind: "error" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      title={t("title")}
      onClose={() => setOpen(false)}
      footer={
        <>
          <button type="button" className="ez-btn ez-btn--danger" onClick={() => setConfirmDelete(true)}>
            {t("deleteProject")}
          </button>
          <span style={{ flex: 1 }} />
          <button type="button" className="ez-btn" onClick={() => setOpen(false)}>
            {ta("cancel")}
          </button>
          <button type="button" className="ez-btn ez-btn--primary" disabled={saving || !name.trim()} onClick={save}>
            {t("save")}
          </button>
        </>
      }
    >
      {error ? (
        <ErrorCard what={t("title")} onRetry={() => mutateProject()} />
      ) : !project ? (
        <p>{ta("loading")}</p>
      ) : (
        <>
          <div className="ez-field">
            <label htmlFor="ez-settings-name">{t("name")}</label>
            <input
              id="ez-settings-name"
              className="ez-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="ez-field">
            <label htmlFor="ez-settings-template">{t("defaultTemplate")}</label>
            <select
              id="ez-settings-template"
              className="ez-select"
              value={defaultTemplate}
              onChange={(e) => setDefaultTemplate(e.target.value)}
            >
              <option value="">—</option>
              {(templates ?? []).map((tp) => (
                <option key={tp.id} value={tp.id}>
                  {tp.name}
                </option>
              ))}
            </select>
          </div>
          <div className="ez-field">
            <label htmlFor="ez-settings-dupe">{t("duplicatePolicy")}</label>
            <select
              id="ez-settings-dupe"
              className="ez-select"
              value={duplicatePolicy}
              onChange={(e) => setDuplicatePolicy(e.target.value)}
            >
              <option value="skip">{ti("policySkip")}</option>
              <option value="keep_both">{ti("policyKeepBoth")}</option>
              <option value="ask">{ti("policyAsk")}</option>
            </select>
          </div>
          <div className="ez-field">
            <label htmlFor="ez-settings-notes">{t("notesFormat")}</label>
            <select
              id="ez-settings-notes"
              className="ez-select"
              value={notesFormat}
              onChange={(e) => setNotesFormat(e.target.value)}
            >
              <option value="html">{t("notesHtml")}</option>
              <option value="markdown">{t("notesMarkdown")}</option>
            </select>
          </div>
          <div className="ez-field">
            <label htmlFor="ez-settings-density">{t("defaultDensity")}</label>
            <input
              id="ez-settings-density"
              className="ez-input"
              type="number"
              min={36}
              max={1200}
              step={1}
              value={defaultDensity}
              onChange={(e) => setDefaultDensity(e.target.value)}
            />
            <p className="ez-notice">{t("defaultDensityHint")}</p>
          </div>
          <div className="ez-field">
            <span className="ez-field-label">{t("omekaTitle")}</span>
            <p className="ez-notice">{t("omekaNote")}</p>
            <label htmlFor="ez-settings-omeka-url">{t("omekaBaseUrl")}</label>
            <input
              id="ez-settings-omeka-url"
              className="ez-input"
              value={omekaBaseUrl}
              onChange={(e) => setOmekaBaseUrl(e.target.value)}
              placeholder="https://example.org/omeka-s"
            />
            <label htmlFor="ez-settings-omeka-id">{t("omekaKeyIdentity")}</label>
            <input
              id="ez-settings-omeka-id"
              className="ez-input"
              value={omekaIdentity}
              onChange={(e) => setOmekaIdentity(e.target.value)}
            />
            <label htmlFor="ez-settings-omeka-cred">{t("omekaKeyCredential")}</label>
            <input
              id="ez-settings-omeka-cred"
              className="ez-input"
              type="password"
              value={omekaCredential}
              onChange={(e) => setOmekaCredential(e.target.value)}
              autoComplete="off"
            />
            <p className="ez-notice">{t("omekaKeyCredentialHint")}</p>
            <p className="ez-notice">{omekaStatus === "ok" ? t("omekaConfigured") : t("omekaNotConfigured")}</p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" className="ez-btn ez-btn--sm" disabled={omekaBusy || !omekaBaseUrl.trim() || !omekaIdentity.trim()} onClick={saveOmeka}>
                {t("omekaSave")}
              </button>
              <button type="button" className="ez-btn ez-btn--sm" disabled={omekaBusy || omekaStatus !== "ok"} onClick={pushProjectToOmeka}>
                {omekaBusy ? t("omekaPushing") : t("omekaPushProject")}
              </button>
            </div>
            {omekaPushResult ? <p className="ez-notice">{omekaPushResult}</p> : null}
          </div>
          <div className="ez-field">
            <span className="ez-field-label">{t("tokensTitle")}</span>
            <p className="ez-notice">{t("tokensNote")}</p>
            <label htmlFor="ez-settings-token-name">{t("tokenName")}</label>
            <input
              id="ez-settings-token-name"
              className="ez-input"
              value={tokenName}
              onChange={(e) => setTokenName(e.target.value)}
            />
            <label style={{ fontSize: 12, display: "block" }}>
              <input type="checkbox" checked={tokenRead} onChange={(e) => setTokenRead(e.target.checked)} style={{ marginRight: 4 }} />
              {t("tokenScopeRead")}
            </label>
            <label style={{ fontSize: 12, display: "block" }}>
              <input type="checkbox" checked={tokenWrite} onChange={(e) => setTokenWrite(e.target.checked)} style={{ marginRight: 4 }} />
              {t("tokenScopeWrite")}
            </label>
            <button type="button" className="ez-btn ez-btn--sm" disabled={!tokenName.trim() || (!tokenRead && !tokenWrite)} onClick={createToken}>
              {t("tokenCreate")}
            </button>
            {tokenSecret ? (
              <div style={{ marginTop: 8 }}>
                <p className="ez-notice">{t("tokenSecretOnce")}</p>
                <input className="ez-input" readOnly value={tokenSecret} onFocus={(e) => e.target.select()} style={{ fontFamily: "var(--font-mono)", fontSize: 11 }} />
              </div>
            ) : null}
            {tokens.length === 0 ? (
              <p className="ez-notice">{t("tokensEmpty")}</p>
            ) : (
              <div style={{ marginTop: 8 }}>
                {tokens.map((tk) => (
                  <div key={tk.id} className="ez-file-row">
                    <span className="ez-name">{tk.name}</span>
                    <span style={{ fontSize: 11, fontFamily: "var(--font-mono)" }}>{tk.prefix}…</span>
                    <span style={{ fontSize: 11, color: "var(--ink-3)" }}>{tk.scopes.join(", ")}</span>
                    <span style={{ fontSize: 11, color: "var(--ink-3)" }}>
                      {tk.revoked_at ? t("tokenRevoked") : tk.last_used_at ? t("tokenLastUsed", { date: new Date(tk.last_used_at).toLocaleDateString() }) : t("tokenNeverUsed")}
                    </span>
                    {!tk.revoked_at ? (
                      <button type="button" className="ez-btn ez-btn--sm ez-btn--danger" onClick={() => revokeToken(tk.id)}>
                        {t("tokenRevoke")}
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="ez-field">
            <span className="ez-field-label">{t("help")}</span>
            <button
              type="button"
              className="ez-btn ez-btn--sm"
              onClick={() => {
                setOpen(false);
                startTour();
              }}
            >
              {ts("takeTour")}
            </button>
          </div>
          <div className="ez-field">
            <span className="ez-field-label">{t("dangerZone")}</span>
            <button
              type="button"
              className="ez-btn ez-btn--danger ez-btn--sm"
              onClick={() => setDeleteEverythingOpen(true)}
            >
              {t("deleteEverything")}
            </button>
          </div>
        </>
      )}
      {confirmDelete ? (
        <ConfirmDialog
          title={t("deleteProject")}
          body={t("deleteConfirm", { name: project?.name ?? "" })}
          confirmLabel={t("deleteProject")}
          danger
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => {
            setConfirmDelete(false);
            await del(`/api/projects/${projectId}`);
            await mutate(key.projects);
            setOpen(false);
            router.push("/");
          }}
        />
      ) : null}
      {deleteEverythingOpen ? (
        <DeleteEverythingDialog onClose={() => setDeleteEverythingOpen(false)} />
      ) : null}
    </Dialog>
  );
}

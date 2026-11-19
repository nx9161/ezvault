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
import { Button } from "@astryxdesign/core/Button";
import { TextInput } from "@astryxdesign/core/TextInput";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { Selector } from "@astryxdesign/core/Selector";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
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
  // Wave E part 2: extension (plugin) registry state for this project.
  interface PluginView { id: string; version: string; kind: string; i18n_base: string; enabled: boolean }
  const [plugins, setPlugins] = useState<PluginView[]>([]);
  const tp = useTranslations("plugins");

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
      try {
        const list = await get<{ items: PluginView[] }>(`/api/projects/${projectId}/plugins`);
        setPlugins(list.items ?? []);
      } catch { /* extensions list stays empty */ }
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

  async function togglePlugin(pluginId: string, enabled: boolean) {
    try {
      const res = await patch<{ items: PluginView[] }>(`/api/projects/${projectId}/plugins`, {
        plugin_id: pluginId,
        enabled,
      });
      setPlugins(res.items ?? []);
      pushToast({ message: t("saved") });
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : "save failed", kind: "error" });
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
          <Button label={t("deleteProject")} variant="destructive" onClick={() => setConfirmDelete(true)} />
          <span style={{ flex: 1 }} />
          <Button label={ta("cancel")} onClick={() => setOpen(false)} />
          <Button label={t("save")} variant="primary" isDisabled={saving || !name.trim()} isLoading={saving} onClick={save} />
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
            <TextInput label={t("name")} value={name} onChange={(v) => setName(v)} />
          </div>
          <div className="ez-field">
            <Selector
              label={t("defaultTemplate")}
              value={defaultTemplate}
              onChange={(v) => setDefaultTemplate(v)}
              options={[
                { value: "", label: "—" },
                ...(templates ?? []).map((tp) => ({ value: tp.id, label: tp.name })),
              ]}
            />
          </div>
          <div className="ez-field">
            <Selector
              label={t("duplicatePolicy")}
              value={duplicatePolicy}
              onChange={(v) => setDuplicatePolicy(v)}
              options={[
                { value: "skip", label: ti("policySkip") },
                { value: "keep_both", label: ti("policyKeepBoth") },
                { value: "ask", label: ti("policyAsk") },
              ]}
            />
          </div>
          <div className="ez-field">
            <Selector
              label={t("notesFormat")}
              value={notesFormat}
              onChange={(v) => setNotesFormat(v)}
              options={[
                { value: "html", label: t("notesHtml") },
                { value: "markdown", label: t("notesMarkdown") },
              ]}
            />
          </div>
          <div className="ez-field">
            <NumberInput
              label={t("defaultDensity")}
              description={t("defaultDensityHint")}
              min={36}
              max={1200}
              step={1}
              hasClear
              value={defaultDensity === "" ? null : Number(defaultDensity)}
              onChange={(v) => setDefaultDensity(v == null ? "" : String(v))}
            />
          </div>
          <div className="ez-field">
            <span className="ez-field-label">{t("omekaTitle")}</span>
            <p className="ez-notice">{t("omekaNote")}</p>
            <TextInput label={t("omekaBaseUrl")} value={omekaBaseUrl} onChange={(v) => setOmekaBaseUrl(v)} placeholder="https://example.org/omeka-s" />
            <TextInput label={t("omekaKeyIdentity")} value={omekaIdentity} onChange={(v) => setOmekaIdentity(v)} />
            <TextInput label={t("omekaKeyCredential")} type="password" value={omekaCredential} onChange={(v) => setOmekaCredential(v)} description={t("omekaKeyCredentialHint")} />
            <p className="ez-notice">{omekaStatus === "ok" ? t("omekaConfigured") : t("omekaNotConfigured")}</p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Button label={t("omekaSave")} size="sm" isDisabled={omekaBusy || !omekaBaseUrl.trim() || !omekaIdentity.trim()} onClick={saveOmeka} />
              <Button label={omekaBusy ? t("omekaPushing") : t("omekaPushProject")} size="sm" isDisabled={omekaBusy || omekaStatus !== "ok"} isLoading={omekaBusy} onClick={pushProjectToOmeka} />
            </div>
            {omekaPushResult ? <p className="ez-notice">{omekaPushResult}</p> : null}
          </div>
          <div className="ez-field">
            <span className="ez-field-label">{t("tokensTitle")}</span>
            <p className="ez-notice">{t("tokensNote")}</p>
            <TextInput label={t("tokenName")} value={tokenName} onChange={(v) => setTokenName(v)} />
            <CheckboxInput label={t("tokenScopeRead")} value={tokenRead} onChange={(checked) => setTokenRead(checked === true)} />
            <CheckboxInput label={t("tokenScopeWrite")} value={tokenWrite} onChange={(checked) => setTokenWrite(checked === true)} />
            <Button label={t("tokenCreate")} size="sm" isDisabled={!tokenName.trim() || (!tokenRead && !tokenWrite)} onClick={createToken} />
            {tokenSecret ? (
              <div style={{ marginTop: 8 }}>
                <p className="ez-notice">{t("tokenSecretOnce")}</p>
                <TextInput label={t("tokenName")} isLabelHidden isReadOnly value={tokenSecret} onChange={() => {}} />
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
                      <Button label={t("tokenRevoke")} size="sm" variant="destructive" onClick={() => revokeToken(tk.id)} />
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="ez-field">
            <span className="ez-field-label">{t("pluginsTitle")}</span>
            <p className="ez-notice">{t("pluginsNote")}</p>
            {plugins.map((p) => (
              <div key={p.id} className="ez-file-row">
                <span className="ez-name">{tp(`${p.i18n_base}.name` as never)}</span>
                <span style={{ fontSize: 11, color: "var(--ink-3)" }}>
                  {tp(`kind${p.kind[0].toUpperCase()}${p.kind.slice(1)}` as never)} · {tp("version", { version: p.version })}
                </span>
                <span style={{ fontSize: 11, color: "var(--ink-3)", flex: 1 }}>
                  {tp(`${p.i18n_base}.description` as never)}
                </span>
                {/* QA D3: the accessible name must be the plugin name
                    (as on main, aria-label={plugin name}) — labelling
                    every toggle "Enabled" made all 9 indistinguishable
                    to assistive tech. The visible Enabled/Disabled state
                    text rides beside the checkbox instead. */}
                <span style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <CheckboxInput
                    label={tp(`${p.i18n_base}.name` as never)}
                    isLabelHidden
                    value={p.enabled}
                    onChange={(checked) => void togglePlugin(p.id, checked === true)}
                  />
                  {p.enabled ? tp("enabled") : tp("disabled")}
                </span>
              </div>
            ))}
          </div>
          <div className="ez-field">
            <span className="ez-field-label">{t("help")}</span>
            <Button
              label={ts("takeTour")}
              size="sm"
              onClick={() => {
                setOpen(false);
                startTour();
              }}
            />
          </div>
          <div className="ez-field">
            <span className="ez-field-label">{t("dangerZone")}</span>
            <Button label={t("deleteEverything")} size="sm" variant="destructive" onClick={() => setDeleteEverythingOpen(true)} />
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

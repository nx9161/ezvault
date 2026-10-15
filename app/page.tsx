// SPDX-License-Identifier: MIT
// Project home: list projects, create, open. Client component so the
// browser's auth session (Vercel Authentication gate) carries the API calls.

"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useProjects } from "@/lib/api/hooks";
import { post } from "@/lib/api/client";
import { useUiStore } from "@/lib/store/ui";
import { Dialog } from "@/components/ui/Dialog";
import { ErrorCard, SkeletonRows } from "@/components/ui/Feedback";
import { Toasts } from "@/components/ui/Toasts";
import type { Project } from "@/lib/api/types";

function asList(data: { items: Project[]; total: number } | Project[] | undefined): Project[] {
  if (!data) return [];
  return Array.isArray(data) ? data : (data.items ?? []);
}

export default function Home() {
  const t = useTranslations("projectHome");
  const tc = useTranslations("app");
  const { data, error, isLoading, mutate } = useProjects();
  const pushToast = useUiStore((s) => s.pushToast);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  async function createProject() {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      await post("/api/projects", { name: trimmed });
      setCreating(false);
      setName("");
      await mutate();
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : t("loadError"), kind: "error" });
    }
  }

  return (
    <main className="ez-home">
      <h1>{t("title")}</h1>
      {isLoading ? (
        <SkeletonRows rows={4} />
      ) : error ? (
        <ErrorCard what={t("title")} onRetry={() => mutate()} />
      ) : asList(data).length === 0 ? (
        <div className="ez-state" style={{ height: "auto", padding: "32px 0" }}>
          <p>{t("empty")}</p>
          <button type="button" className="ez-btn ez-btn--primary" onClick={() => setCreating(true)}>
            {t("new")}
          </button>
        </div>
      ) : (
        <>
          {asList(data).map((p) => (
            <div key={p.id} className="ez-project-row">
              <strong>{p.name}</strong>
              <Link className="ez-btn ez-btn--primary" href={`/${p.id}`}>
                {t("open")}
              </Link>
            </div>
          ))}
          <button type="button" className="ez-btn" onClick={() => setCreating(true)}>
            {t("new")}
          </button>
        </>
      )}
      {creating ? (
        <Dialog
          title={t("new")}
          onClose={() => setCreating(false)}
          footer={
            <>
              <button type="button" className="ez-btn" onClick={() => setCreating(false)}>
                {tc("cancel")}
              </button>
              <button type="button" className="ez-btn ez-btn--primary" onClick={createProject} disabled={!name.trim()}>
                {tc("save")}
              </button>
            </>
          }
        >
          <div className="ez-field">
            <label htmlFor="ez-new-project-name">{t("nameLabel")}</label>
            <input
              id="ez-new-project-name"
              className="ez-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("namePlaceholder")}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") createProject();
              }}
            />
          </div>
        </Dialog>
      ) : null}
      <Toasts />
    </main>
  );
}

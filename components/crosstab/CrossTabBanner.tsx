// SPDX-License-Identifier: MIT
// Cross-tab sync UX (architecture §9): non-blocking "Updated in another tab"
// banner with a dirty-state guard. Wiring:
// - every mutation broadcasts {projectId, rev, tabId, scopes} (see ops.ts)
// - this component subscribes, ignores own tabId, compares rev
// - visibilitychange → visible triggers a cheap rev resume check (no polling)

"use client";

import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { useDomainStore } from "@/lib/store/domain";
import { onRemoteMutation } from "@/lib/sync";
import { get } from "@/lib/api/client";
import { mutate } from "swr";
import { key } from "@/lib/api/hooks";

export default function CrossTabBanner({ projectId }: { projectId: string }) {
  const t = useTranslations("crosstab");
  const ta = useTranslations("app");
  const tabId = useDomainStore((s) => s.tabId);
  const rev = useDomainStore((s) => s.rev);
  const setRev = useDomainStore((s) => s.setRev);
  const dirty = useDomainStore((s) => s.dirty);
  const remoteUpdate = useDomainStore((s) => s.remoteUpdate);
  const setRemoteUpdate = useDomainStore((s) => s.setRemoteUpdate);

  useEffect(() => {
    // Seed the rev counter.
    get<{ rev: number }>(key.rev(projectId))
      .then((r) => setRev(r.rev ?? 0))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    const off = onRemoteMutation((msg) => {
      if (msg.projectId !== projectId || msg.tabId === tabId) return;
      if (msg.rev > useDomainStore.getState().rev) {
        setRev(msg.rev);
        setRemoteUpdate(true);
      } else {
        // rev unknown or not newer — still surface the notice once.
        setRemoteUpdate(true);
      }
    });
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      get<{ rev: number }>(key.rev(projectId))
        .then((r) => {
          const cur = useDomainStore.getState().rev;
          if ((r.rev ?? 0) > cur) {
            setRev(r.rev);
            setRemoteUpdate(true);
          }
        })
        .catch(() => {});
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      off();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [projectId, tabId, setRev, setRemoteUpdate]);

  if (!remoteUpdate) return null;

  async function refreshView() {
    if (dirty) {
      const ok = window.confirm(t("dirtyWarn"));
      if (!ok) return;
    }
    // Revalidate every project-scoped key.
    await mutate((k) => typeof k === "string" && k.includes(`/api/projects/${projectId}`));
    await mutate((k) => k === "/api/storage/meter" || k === "/api/health");
    setRemoteUpdate(false);
  }

  return (
    <div className="ez-banner" data-kind="info" role="status">
      <span>{t("updated")}</span>
      <span className="ez-spacer" />
      <button type="button" className="ez-btn ez-btn--sm ez-btn--primary" onClick={refreshView}>
        {t("refresh")}
      </button>
      <button type="button" className="ez-btn ez-btn--sm" onClick={() => setRemoteUpdate(false)}>
        {ta("dismiss")}
      </button>
    </div>
  );
}

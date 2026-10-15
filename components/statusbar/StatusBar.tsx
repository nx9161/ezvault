// SPDX-License-Identifier: MIT
// Status bar: counts, last action + undo/redo, connectivity chips,
// GC disclaimer link. Design §1.5 — the single-user trust surface.

"use client";

import { useTranslations } from "next-intl";
import { useUiStore } from "@/lib/store/ui";
import { useDomainStore } from "@/lib/store/domain";
import { useStats, useHealth } from "@/lib/api/hooks";
import { commandBus, useCommandBus } from "@/lib/commands/bus";
import { undoLast, redoLast, type OpContext } from "@/lib/commands/ops";
import { useOpContext } from "@/components/sidebar/Sidebar";
import { Dialog } from "@/components/ui/Dialog";
import { UndoIcon, RedoIcon } from "@/components/ui/icons";

function ConnChip({ label, state }: { label: string; state: "ok" | "warn" | "bad" }) {
  return (
    <span className="ez-conn-chip" data-state={state === "ok" ? undefined : state}>
      <span className="ez-dot" aria-hidden="true" />
      {label}
    </span>
  );
}

export default function StatusBar({ projectId }: { projectId: string }) {
  const t = useTranslations("statusbar");
  const ta = useTranslations("app");
  const ctx: OpContext = useOpContext(projectId);
  const { data: stats } = useStats(projectId);
  const { data: health } = useHealth();
  const lastAction = useDomainStore((s) => s.lastAction);
  const aboutOpen = useUiStore((s) => s.aboutOpen);
  const setAboutOpen = useUiStore((s) => s.setAboutOpen);
  const bus = useCommandBus();

  const degraded = health && (health.neon !== "ok" || health.r2 !== "ok");

  return (
    <>
      <footer className="ez-statusbar" aria-label="status">
        <span>
          {t("items", { count: stats?.item_count ?? 0 })} · {t("photos", { count: stats?.photo_count ?? 0 })} ·{" "}
          {t("selections", { count: stats?.selection_count ?? 0 })} · {t("notes", { count: stats?.note_count ?? 0 })}
        </span>
        <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
          <button
            type="button"
            className="ez-icon-btn"
            style={{ width: 24, height: 24 }}
            disabled={!bus.undoDepth}
            onClick={() => void undoLast(ctx, [])}
            aria-label={bus.undoLabel ? `${t("undo")}: ${bus.undoLabel}` : t("nothingToUndo")}
            title={t("undo")}
          >
            <UndoIcon size={15} />
          </button>
          <button
            type="button"
            className="ez-icon-btn"
            style={{ width: 24, height: 24 }}
            disabled={!bus.redoDepth}
            onClick={() => void redoLast(ctx, [])}
            aria-label={bus.redoLabel ? `${t("redo")}: ${bus.redoLabel}` : t("nothingToRedo")}
            title={t("redo")}
          >
            <RedoIcon size={15} />
          </button>
          {lastAction ? <span>{t("lastAction", { label: lastAction })}</span> : null}
        </span>
        <span className="ez-spacer" />
        {health ? (
          <>
            <ConnChip label={t("db")} state={health.neon === "ok" ? "ok" : "bad"} />
            <ConnChip label={t("storage")} state={health.r2 === "ok" ? "ok" : "bad"} />
            <span>{degraded ? t("degraded") : t("ok")}</span>
          </>
        ) : null}
        <span className="ez-footer-note">
          <button
            type="button"
            onClick={() => setAboutOpen(true)}
            style={{ background: "none", border: 0, padding: 0, cursor: "pointer", font: "inherit", color: "inherit", textDecoration: "underline" }}
          >
            {ta("about")}
          </button>
        </span>
      </footer>
      {aboutOpen ? (
        <Dialog title={ta("about")} onClose={() => setAboutOpen(false)}>
          <p style={{ fontSize: 13, lineHeight: 1.6 }}>{ta("disclaimerShort")}</p>
          <p style={{ fontSize: 12, color: "var(--ink-2)" }}>{ta("tagline")}</p>
        </Dialog>
      ) : null}
    </>
  );
}

// Re-exported for tree-shaking clarity in WorkspaceClient.
export { commandBus };

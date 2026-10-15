// SPDX-License-Identifier: MIT
// WorkspaceClient — the ONE client root below app/[projectId]/page.tsx
// (architecture §9 RSC boundary). Wires top bar, three panes, inspector,
// status bar, dialogs, shortcuts, cross-tab, meter/CPU banners, global
// drag-and-drop import, and the mobile companion nav.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { LibraryIcon, ListsIcon, TagsIcon, SearchIcon, MoreIcon } from "@/components/ui/icons";
import { useUiStore } from "@/lib/store/ui";
import { useMeter, useCpuBudget } from "@/lib/api/hooks";
import { ACCEPT_ATTR, detectKind } from "@/lib/import/files";
import TopBar from "@/components/topbar/TopBar";
import Sidebar from "@/components/sidebar/Sidebar";
import CenterPanel from "@/components/center/CenterPanel";
import Inspector from "@/components/inspector/Inspector";
import StatusBar from "@/components/statusbar/StatusBar";
import CrossTabBanner from "@/components/crosstab/CrossTabBanner";
import ShortcutsOverlay from "@/components/shortcuts/ShortcutsOverlay";
import { RegisteredHotkeys } from "@/components/shortcuts/useRegisteredHotkeys";
import { PaletteLauncher } from "@/components/palette/PaletteLauncher";
import { TourLauncher } from "@/components/tour/TourLauncher";
import { Toasts } from "@/components/ui/Toasts";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/Menu";
import ImportDialog from "@/components/importer/ImportDialog";
import TpyWizard from "@/components/tpy/TpyWizard";
import StorageDialog from "@/components/meter/StorageDialog";
import SettingsDialog from "@/components/settings/SettingsDialog";
import TemplatesDialog from "@/components/templates/TemplatesDialog";
import { useOpContext } from "@/components/sidebar/Sidebar";

function Splitter({ onResize, label }: { onResize: (dx: number) => void; label: string }) {
  const startX = useRef(0);
  const dragging = useRef(false);
  return (
    <div
      className="ez-splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      onPointerDown={(e) => {
        dragging.current = true;
        startX.current = e.clientX;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!dragging.current) return;
        onResize(e.clientX - startX.current);
        startX.current = e.clientX;
      }}
      onPointerUp={() => {
        dragging.current = false;
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") onResize(-8);
        else if (e.key === "ArrowRight") onResize(8);
      }}
    />
  );
}

function MeterBanners({ projectId }: { projectId: string }) {
  const t = useTranslations("meter");
  const { data: meter } = useMeter(projectId);
  const { data: cpu } = useCpuBudget();
  const setRetentionOpen = useUiStore((s) => s.setRetentionOpen);
  if (!meter && !cpu?.paused) return null;
  return (
    <>
      {meter && meter.policy === "warn" && meter.pct >= 80 ? (
        <div className="ez-banner" data-kind="warn" role="status">
          <span>
            {meter.pct >= 95
              ? t("warn95Body", { pct: Math.round(meter.pct) })
              : t("warn80", { pct: Math.round(meter.pct) })}
          </span>
          <span className="ez-spacer" />
          <button type="button" className="ez-btn ez-btn--sm" onClick={() => setRetentionOpen(true)}>
            {t("runRetention")}
          </button>
        </div>
      ) : null}
      {meter && meter.policy === "block" ? (
        <div className="ez-banner" data-kind="danger" role="alert">
          <span>
            <strong>{t("blockedTitle")}</strong> — {t("blockedBody")}
          </span>
          <span className="ez-spacer" />
          <button type="button" className="ez-btn ez-btn--sm" onClick={() => setRetentionOpen(true)}>
            {t("runRetention")}
          </button>
        </div>
      ) : null}
      {cpu?.paused ? (
        <div className="ez-banner" data-kind="warn" role="status">
          <span>{t("cpuPaused", { date: cpu.resumes ? new Date(cpu.resumes).toLocaleDateString() : "—" })}</span>
        </div>
      ) : null}
    </>
  );
}

function MobileNav({ projectId }: { projectId: string }) {
  const t = useTranslations("mobileNav");
  const mobileNav = useUiStore((s) => s.mobileNav);
  const setMobileNav = useUiStore((s) => s.setMobileNav);
  const setSidebarOpen = useUiStore((s) => s.setSidebarOpen);
  const setLibraryFilter = useUiStore((s) => s.setLibraryFilter);
  const setImportOpen = useUiStore((s) => s.setImportOpen);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const setTemplatesOpen = useUiStore((s) => s.setTemplatesOpen);
  const setTpyOpen = useUiStore((s) => s.setTpyOpen);
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  void projectId;

  const items = [
    {
      id: "library" as const, label: t("library"), icon: LibraryIcon,
      onTap: () => { setMobileNav("library"); setLibraryFilter("all"); },
    },
    {
      id: "lists" as const, label: t("lists"), icon: ListsIcon,
      onTap: () => { setMobileNav("lists"); setSidebarOpen(true); },
    },
    {
      id: "tags" as const, label: t("tags"), icon: TagsIcon,
      onTap: () => { setMobileNav("tags"); setSidebarOpen(true); },
    },
    {
      id: "search" as const, label: t("search"), icon: SearchIcon,
      onTap: () => {
        setMobileNav("search");
        setTimeout(() => document.getElementById("ez-global-search")?.focus(), 50);
      },
    },
  ];

  return (
    <>
      <nav className="ez-mobile-nav" aria-label="mobile">
        {items.map((it) => (
          <button
            key={it.id}
            type="button"
            aria-current={mobileNav === it.id}
            onClick={it.onTap}
          >
            <it.icon size={18} aria-hidden="true" />
            {it.label}
          </button>
        ))}
        <button
          type="button"
          aria-current={mobileNav === "more"}
          onClick={(e) => {
            setMobileNav("more");
            const r = e.currentTarget.getBoundingClientRect();
            setMenuAt({ x: r.left, y: r.top - 8 });
          }}
        >
          <MoreIcon size={18} aria-hidden="true" />
          {t("more")}
        </button>
      </nav>
      <div className="ez-mobile-note">
        Field-capture and review companion — bulk metadata work, multi-pane compare
        and precise selection drawing need the desktop layout.
      </div>
      {menuAt ? (
        <Menu anchor={menuAt} onClose={() => setMenuAt(null)} label="more">
          <MenuItem onSelect={() => setImportOpen(true)}>Import</MenuItem>
          <MenuItem onSelect={() => setTpyOpen(true)}>Import .tpy</MenuItem>
          <MenuSeparator />
          <MenuItem onSelect={() => setTemplatesOpen(true)}>Templates</MenuItem>
          <MenuItem onSelect={() => setSettingsOpen(true)}>Project settings</MenuItem>
          <MenuSeparator />
          <MenuItem onSelect={() => setTheme(theme === "light" ? "dark" : "light")}>
            Toggle theme
          </MenuItem>
        </Menu>
      ) : null}
    </>
  );
}

function GlobalDropZone() {
  const t = useTranslations("import");
  const setPendingFiles = useUiStore((s) => s.setPendingFiles);
  const setImportOpen = useUiStore((s) => s.setImportOpen);
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  const accepts = useCallback((dt: DataTransfer) => {
    if (!dt.types.includes("Files")) return false;
    // .tpy drops belong to the wizard's own zone — let them through.
    if (dt.files && dt.files.length > 0) {
      return Array.from(dt.files).some((f) => detectKind(f) !== "unknown");
    }
    return true;
  }, []);

  useEffect(() => {
    const onDragEnter = (e: DragEvent) => {
      if (!e.dataTransfer || !accepts(e.dataTransfer)) return;
      e.preventDefault();
      depth.current += 1;
      setDragging(true);
    };
    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer || !accepts(e.dataTransfer)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    };
    const onDragLeave = (e: DragEvent) => {
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!e.dataTransfer || !accepts(e.dataTransfer)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      const files = Array.from(e.dataTransfer.files).filter((f) => detectKind(f) !== "unknown");
      if (files.length > 0) {
        setPendingFiles(files);
        setImportOpen(true);
      }
    };
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [accepts, setPendingFiles, setImportOpen]);

  if (!dragging) return null;
  return (
    <div className="ez-drop-overlay" aria-hidden="true">
      <div className="ez-drop-card">{t("dropHint")}</div>
    </div>
  );
}

export default function WorkspaceClient({ projectId }: { projectId: string }) {
  const ctx = useOpContext(projectId);
  // D-INTc: global bindings live in lib/shortcuts/registry.ts, bound by
  // <RegisteredHotkeys/> rendered below (replaces useGlobalShortcuts).
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const setSidebarWidth = useUiStore((s) => s.setSidebarWidth);
  const inspectorWidth = useUiStore((s) => s.inspectorWidth);
  const setInspectorWidth = useUiStore((s) => s.setInspectorWidth);
  void ACCEPT_ATTR;

  return (
    <div className="ez-app">
      <RegisteredHotkeys projectId={projectId} ctx={ctx} />
      <PaletteLauncher projectId={projectId} opCtx={ctx} />
      <TourLauncher />
      <TopBar projectId={projectId} />
      <CrossTabBanner projectId={projectId} />
      <MeterBanners projectId={projectId} />
      <div className="ez-workspace">
        <Sidebar projectId={projectId} />
        <Splitter onResize={(dx) => setSidebarWidth(sidebarWidth + dx)} label="sidebar" />
        <CenterPanel projectId={projectId} />
        <Splitter onResize={(dx) => setInspectorWidth(inspectorWidth - dx)} label="inspector" />
        <Inspector projectId={projectId} />
      </div>
      <StatusBar projectId={projectId} />
      <MobileNav projectId={projectId} />
      <GlobalDropZone />
      <ImportDialog projectId={projectId} />
      <TpyWizard projectId={projectId} />
      <StorageDialog projectId={projectId} />
      <SettingsDialog projectId={projectId} />
      <TemplatesDialog projectId={projectId} />
      <ShortcutsOverlay />
      <Toasts />
    </div>
  );
}

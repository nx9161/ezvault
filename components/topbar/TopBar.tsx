// SPDX-License-Identifier: MIT
// Top bar: brand, global search (Ctrl/Cmd+K), Import, view toggles,
// storage meter chip, theme toggle, project menu. Design §1.1.

"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useUiStore } from "@/lib/store/ui";
import { useMeter, useProject } from "@/lib/api/hooks";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "@/components/ui/Menu";
import { startTour } from "@/lib/tour/launcher";
import LocaleSwitcher from "@/components/topbar/LocaleSwitcher";
import { GridIcon, TableIcon, ThemeIcon, ChevronDownIcon } from "@/components/ui/icons";

import { VaultMark } from "@/components/ui/icons";

function formatBytes(n: number): string {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(2)} GB`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  return `${Math.max(0, Math.round(n / 1024))} KB`;
}

function SearchBox() {
  const t = useTranslations("topbar");
  const searchBox = useUiStore((s) => s.searchBox);
  const setSearchBox = useUiStore((s) => s.setSearchBox);
  const submitSearch = useUiStore((s) => s.submitSearch);
  const clearSearch = useUiStore((s) => s.clearSearch);
  const searchActive = useUiStore((s) => s.searchActive);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (el) el.id = "ez-global-search";
  }, []);

  return (
    <div className="ez-search-wrap">
      <input
        ref={inputRef}
        className="ez-input"
        type="search"
        role="searchbox"
        aria-label={t("searchLabel")}
        placeholder={t("searchPlaceholder")}
        data-tour="global-search"
        value={searchBox}
        onChange={(e) => setSearchBox(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submitSearch();
          if (e.key === "Escape" && searchActive) clearSearch();
        }}
      />
      <span className="ez-search-kbd" aria-hidden="true">
        {t("searchHint")}
      </span>
    </div>
  );
}

function MeterChip({ projectId, onOpen }: { projectId: string; onOpen: () => void }) {
  const t = useTranslations("meter");
  const { data } = useMeter(projectId);
  if (!data) return null;
  const policy = data.policy;
  return (
    <button
      type="button"
      className="ez-meter-chip"
      data-policy={policy}
      onClick={onOpen}
      aria-label={`${t("storage")}: ${t("ofLimit", {
        used: formatBytes(data.bytes_used),
        limit: formatBytes(data.bytes_limit),
      })}`}
      title={t("ofLimit", {
        used: formatBytes(data.bytes_used),
        limit: formatBytes(data.bytes_limit),
      })}
    >
      <span className="ez-meter-bar" aria-hidden="true">
        <span style={{ width: `${Math.min(100, data.pct)}%` }} />
      </span>
      {Math.round(data.pct)}%
    </button>
  );
}

export default function TopBar({ projectId }: { projectId: string }) {
  const t = useTranslations("topbar");
  const ts = useTranslations("shortcuts");
  const view = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  const setPaletteOpen = useUiStore((s) => s.setPaletteOpen);
  const setImportOpen = useUiStore((s) => s.setImportOpen);
  const setTpyOpen = useUiStore((s) => s.setTpyOpen);
  const setRetentionOpen = useUiStore((s) => s.setRetentionOpen);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const setTemplatesOpen = useUiStore((s) => s.setTemplatesOpen);
  const setCsvImportOpen = useUiStore((s) => s.setCsvImportOpen);
  const { data: project } = useProject(projectId);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const router = useRouter();

  return (
    <header className="ez-topbar">
      <div className="ez-brand">
        <VaultMark />
        <span>EZVault</span>
      </div>
      <SearchBox />
      <div className="ez-topbar-actions">
        <button
          type="button"
          className="ez-btn ez-btn--primary"
          onClick={() => setImportOpen(true)}
          title={t("importHint")}
        >
          {t("import")}
        </button>
        <div
          className="ez-segmented"
          role="group"
          aria-label={t("viewGroupLabel")}
        >
          <button
            type="button"
            aria-pressed={view === "grid"}
            onClick={() => setView("grid")}
            title={`${t("viewGrid")} (${t("viewHint")})`}
          >
            <GridIcon size={15} /> {t("viewGrid")}
          </button>
          <button
            type="button"
            aria-pressed={view === "table"}
            onClick={() => setView("table")}
            title={`${t("viewTable")} (${t("viewHint")})`}
          >
            <TableIcon size={15} /> {t("viewTable")}
          </button>
        </div>
        <MeterChip projectId={projectId} onOpen={() => setRetentionOpen(true)} />
        <LocaleSwitcher />
        <button
          type="button"
          className="ez-icon-btn"
          onClick={() => setPaletteOpen(true)}
          aria-label={ts("palette")}
          title={`${ts("palette")} (Ctrl/⌘ K)`}
          data-tour="palette-button"
        >
          <span className="ez-kbd" aria-hidden="true">⌘K</span>
        </button>
        <button
          type="button"
          className="ez-icon-btn"
          onClick={() => setTheme(theme === "light" ? "dark" : "light")}
          aria-label={t("themeToggle")}
          title={t("themeToggle")}
        >
          <ThemeIcon
            size={15}
            style={theme === "light" ? undefined : { transform: "rotate(180deg)" }}
          />
        </button>
        <button
          type="button"
          className="ez-btn"
          aria-haspopup="menu"
          aria-expanded={menuAt !== null}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenuAt({ x: r.left, y: r.bottom + 6 });
          }}
        >
          {project?.name ?? "…"} <ChevronDownIcon size={13} />
        </button>
        {menuAt ? (
          <Menu anchor={menuAt} onClose={() => setMenuAt(null)} label={t("projectMenu")}>
            <MenuLabel>{project?.name}</MenuLabel>
            <MenuItem onSelect={() => router.push("/")}>
              {t("switchProject")}
            </MenuItem>
            <MenuItem onSelect={() => setSettingsOpen(true)}>
              {t("projectSettings")}
            </MenuItem>
            <MenuSeparator />
            <MenuItem onSelect={() => setTpyOpen(true)}>{t("importTpy")}</MenuItem>
            <MenuItem onSelect={() => setCsvImportOpen(true)}>{t("importCsv")}</MenuItem>
            <MenuItem onSelect={() => setTemplatesOpen(true)}>
              {t("templateManager")}
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              onSelect={() => {
                window.location.href = `/api/projects/${projectId}/export/jsonld?all=1`;
              }}
            >
              {t("exportJsonLd")}
            </MenuItem>
            <MenuItem
              onSelect={() => {
                window.location.href = `/api/projects/${projectId}/export/csv`;
              }}
            >
              {t("exportCsv")}
            </MenuItem>
            <MenuItem
              onSelect={() => {
                window.location.href = `/api/projects/${projectId}/export/zip`;
              }}
            >
              {t("exportZip")}
            </MenuItem>
            <MenuSeparator />
            <MenuItem onSelect={() => startTour()}>{ts("takeTour")}</MenuItem>
          </Menu>
        ) : null}
      </div>
    </header>
  );
}

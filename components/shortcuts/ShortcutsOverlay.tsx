// SPDX-License-Identifier: MIT
// `?` shortcuts overlay — renders the single-source-of-truth hotkey
// registry (lib/shortcuts/registry.ts), grouped under the three
// shortcuts.groups headings.

"use client";

import { useTranslations } from "next-intl";
import { useUiStore } from "@/lib/store/ui";
import { Dialog } from "@/components/ui/Dialog";
import { HOTKEY_REGISTRY, type HotkeyGroup } from "@/lib/shortcuts/registry";

const GROUPS: HotkeyGroup[] = ["general", "organize", "viewer"];

export default function ShortcutsOverlay() {
  const t = useTranslations("shortcuts");
  const open = useUiStore((s) => s.shortcutsOpen);
  const setOpen = useUiStore((s) => s.setShortcutsOpen);
  if (!open) return null;

  return (
    <Dialog title={t("title")} onClose={() => setOpen(false)} wide>
      {GROUPS.map((group) => {
        const rows = HOTKEY_REGISTRY.filter((e) => e.group === group);
        if (rows.length === 0) return null;
        return (
          <section key={group} style={{ marginBottom: 16 }}>
            <h3
              style={{
                fontSize: 11,
                textTransform: "uppercase",
                letterSpacing: ".06em",
                color: "var(--ink-3)",
                margin: "0 0 4px",
              }}
            >
              {t(`groups.${group}`)}
            </h3>
            <table className="ez-kbd-table">
              <tbody>
                {rows.map((entry) => (
                  <tr key={entry.id}>
                    <td>{t(entry.labelKey)}</td>
                    <td style={{ textAlign: "right" }}>
                      <span className="ez-kbd">{entry.hint}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        );
      })}
      <p style={{ fontSize: 12, color: "var(--ink-2)", marginTop: 12 }}>
        {t("hint")}
      </p>
    </Dialog>
  );
}

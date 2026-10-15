// SPDX-License-Identifier: MIT
// `?` shortcuts overlay — the full keyboard map (design §5).

"use client";

import { useTranslations } from "next-intl";
import { useUiStore } from "@/lib/store/ui";
import { Dialog } from "@/components/ui/Dialog";

export default function ShortcutsOverlay() {
  const t = useTranslations("shortcuts");
  const open = useUiStore((s) => s.shortcutsOpen);
  const setOpen = useUiStore((s) => s.setShortcutsOpen);
  if (!open) return null;

  const rows: [string, string][] = [
    [t("import"), "Ctrl/⌘ Shift I"],
    [t("newItem"), "Ctrl/⌘ Shift N"],
    [t("newList"), "Ctrl/⌘ Shift L"],
    [t("focusSearch"), "Ctrl/⌘ K"],
    [t("undo"), "Ctrl/⌘ Z"],
    [t("redo"), "Ctrl/⌘ Shift Z / Ctrl Y"],
    [t("merge"), "Ctrl/⌘ Shift M"],
    [t("toggleView"), "V"],
    [t("trash"), "Delete"],
    [t("rotate"), "R / Ctrl Space"],
    [t("fitWindow"), "0"],
    [t("actualPixels"), "1"],
    [t("drawSelection"), "S"],
    [t("pan"), "← ↑ ↓ →"],
    [t("shortcuts"), "?"],
  ];

  return (
    <Dialog title={t("title")} onClose={() => setOpen(false)} wide>
      <table className="ez-kbd-table">
        <tbody>
          {rows.map(([action, keys]) => (
            <tr key={action}>
              <td>{action}</td>
              <td style={{ textAlign: "right" }}>
                <span className="ez-kbd">{keys}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ fontSize: 12, color: "var(--ink-2)", marginTop: 12 }}>{t("hint")}</p>
    </Dialog>
  );
}

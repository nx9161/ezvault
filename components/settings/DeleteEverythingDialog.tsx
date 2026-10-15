// SPDX-License-Identifier: MIT
// F-F: in-app "Delete everything" with typed DELETE confirmation.
// Wires against POST /api/admin/delete-everything, whose contract is:
//   body MUST be exactly {confirm:"DELETE"} (else 400)
//   200 → { deleted:{objects,tables}, backups:{retained,retention_days,note} }
//   429 → rate-limited (3 attempts, ~1/hour refill)
// Backups are retained 365 days (disclosed in the response note and shown
// here); crypto-shredding stays manual per docs/RUNBOOK.md.

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Dialog } from "@/components/ui/Dialog";
import { post } from "@/lib/api/client";

interface DeleteResult {
  deleted: { objects: number; tables: number };
  backups: { retained: boolean; retention_days: number; note: string };
}

export function DeleteEverythingDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslations("settings");
  const ta = useTranslations("app");
  const router = useRouter();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DeleteResult | null>(null);

  const armed = typed === "DELETE";

  async function doDelete() {
    if (!armed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await post<DeleteResult>("/api/admin/delete-everything", {
        confirm: "DELETE",
      });
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("deleteEverythingFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title={t("deleteEverything")} onClose={onClose}>
      {result ? (
        <>
          <p>{t("deleteEverythingDone")}</p>
          <p className="ez-notice">
            {t("deleteEverythingCounts", {
              objects: result.deleted.objects,
              tables: result.deleted.tables,
            })}
          </p>
          <p className="ez-notice">{result.backups.note}</p>
          <div className="ez-dialog-foot" style={{ border: 0, padding: "12px 0 0" }}>
            <button
              type="button"
              className="ez-btn ez-btn--primary"
              onClick={() => router.push("/")}
            >
              {t("deleteEverythingHome")}
            </button>
          </div>
        </>
      ) : (
        <>
          <p>{t("deleteEverythingBody")}</p>
          <div className="ez-field">
            <label htmlFor="ez-delete-everything-confirm">
              {t("deleteEverythingConfirm")}
            </label>
            <input
              id="ez-delete-everything-confirm"
              className="ez-input"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="DELETE"
              autoComplete="off"
            />
          </div>
          {error ? (
            <p role="alert" style={{ color: "var(--danger)", fontSize: 13 }}>
              {error}
            </p>
          ) : null}
          <div className="ez-dialog-foot" style={{ border: 0, padding: "12px 0 0" }}>
            <button type="button" className="ez-btn" onClick={onClose}>
              {ta("cancel")}
            </button>
            <button
              type="button"
              className="ez-btn ez-btn--danger"
              disabled={!armed || busy}
              onClick={doDelete}
            >
              {t("deleteEverything")}
            </button>
          </div>
        </>
      )}
    </Dialog>
  );
}

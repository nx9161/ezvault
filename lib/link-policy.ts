// SPDX-License-Identifier: MIT
// B13 consolidation — the backend's `lib/notes/sanitize.ts` is the canonical
// link allowlist (http/https/mailto/tel, explicit scheme, control-char and
// length guards). This module re-exports it so components have one import
// site; never fork a second copy.

export {
  isAllowedLinkUrl as isAllowedUri,
  isAllowedLinkUrl,
  tiptapLinkOptions,
  sanitizeNoteHtml,
  sanitizeTiptapDoc,
} from "@/lib/notes/sanitize";

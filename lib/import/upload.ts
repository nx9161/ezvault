// SPDX-License-Identifier: MIT
// Upload pipeline client (architecture §2.11, shapes from lib/types.ts):
//   presign (batch) → PUT direct to R2 (XHR for progress) → /complete
//   → job polling. Size enforced server-side; checksums are
//   client-computed, server-verified (size + magic bytes, B18).
//
// HEIC/HEIF → browser-decoded JPEG artifacts ride along as extra grants;
// /complete links each artifact to its original via `conversions`.

import { post, newClientOpId } from "../api/client";
import type { PresignGrant, FolderSessionFile, FolderSessionResponse } from "@/lib/types";

export interface PresignFile {
  sha256: string;
  size: number;
  mimetype: string;
  filename: string;
}

export interface CompleteFile {
  /** Staged R2 key (from the presign grant). */
  key: string;
  sha256: string;
  size: number;
  mimetype: string;
  filename: string;
  /** For browser-decoded artifacts: the original file's staged key. */
  conversion_of?: string;
  relative_path?: string;
  /**
   * Folder-session grant's list_id: the server files the new photo into
   * this list in the SAME transaction (F2). Primary filing path — the
   * server only falls back to relativePath → dir_lists when listId is
   * absent on a folder job.
   */
  listId?: string | null;
}

export interface CompleteResult {
  job_id: string;
  accepted: { key: string; photo_subject_id: string; item_id: string; dedupe: string }[];
  rejected: { key: string; reason: string }[];
}

/** PUT a blob to a presigned URL with progress. XHR: fetch has no upload progress. */
export function putWithProgress(
  url: string,
  blob: Blob,
  contentType: string,
  onProgress: (loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", contentType);
    if (signal) {
      signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Upload failed (network)"));
    xhr.onabort = () => reject(new Error("Upload cancelled"));
    xhr.send(blob);
  });
}

export async function presignBatch(
  projectId: string,
  files: PresignFile[],
): Promise<{ job_id: string; grants: PresignGrant[] }> {
  return post<{ job_id: string; grants: PresignGrant[] }>("/api/import/presign", {
    project_id: projectId,
    files,
    clientOpId: newClientOpId(),
  });
}

export async function completeImport(
  projectId: string,
  jobId: string,
  files: CompleteFile[],
  opts: {
    duplicate_policy?: "skip" | "keep_both" | "ask";
    exif?: Record<string, Record<string, unknown>>;
  } = {},
): Promise<CompleteResult> {
  // The `files` form (key + 64-hex sha256 + filename) — the server verifies
  // the staged bytes against the claimed sha256 (B18). Per-file listId is
  // the primary filing path (F2); relative_path is stored as audit only.
  return post<CompleteResult>("/api/import/complete", {
    job_id: jobId,
    project_id: projectId,
    files: files.map((f) => ({
      key: f.key,
      sha256: f.sha256,
      filename: f.filename,
      ...(f.relative_path ? { relative_path: f.relative_path } : {}),
      ...(f.listId ? { listId: f.listId } : {}),
    })),
    conversions: files
      .filter((f) => f.conversion_of)
      .map((f) => ({ key: f.key, conversion_of: f.conversion_of! })),
    exif: opts.exif,
    duplicate_policy: opts.duplicate_policy,
    clientOpId: newClientOpId(),
  });
}

/**
 * Folder upload: register the hashed files so the server mirrors the
 * directory tree as nested lists and mints per-file presigned PUT grants.
 * Each grant carries the list_id its photo files into — the client sends
 * that back as per-file listId on /complete (F2 primary path).
 *
 * Called AFTER hashing: the server requires per-file sha256/size/mimetype.
 */
export async function folderSession(
  projectId: string,
  files: FolderSessionFile[],
): Promise<FolderSessionResponse> {
  return post<FolderSessionResponse>(
    "/api/import/folder-session",
    { project_id: projectId, files, clientOpId: newClientOpId() },
  );
}

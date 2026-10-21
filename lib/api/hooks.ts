// SPDX-License-Identifier: MIT
// SWR hooks = the ONLY server cache in the app (architecture §9).
// Zustand holds UI state only; form state stays component-local.
//
// Wire shapes come from the backend's canonical `lib/types.ts`; every hook
// maps responses through the `adapt*` view-model mappers in `./types`.

"use client";

import useSWR, { type SWRConfiguration } from "swr";
import { get } from "./client";
import type {
  CpuBudgetResponse,
  HealthResponse,
  ImportJob,
  ListNode,
  Project,
  SearchHit,
  StorageMeter,
  Tag,
  TrashEntry,
  ProjectStats,
} from "@/lib/types";
import {
  adaptItem,
  adaptMetadataValues,
  adaptPhoto,
  adaptSelection,
  adaptTemplate,
  thumbUrl as buildThumbUrl,
  originalUrl as buildOriginalUrl,
  type Item,
  type Photo,
  type Selection,
  type UiTemplate,
  type NoteDoc,
  type Transcription,
} from "./types";

const fetcher = <T,>(url: string) => get<T>(url);

const swrDefaults: SWRConfiguration = {
  revalidateOnFocus: false,
  dedupingInterval: 4000,
  shouldRetryOnError: (err) =>
    !(err && typeof err.status === "number" && err.status >= 400 && err.status < 500),
};

export const key = {
  projects: "/api/projects",
  project: (id: string) => `/api/projects/${id}`,
  rev: (id: string) => `/api/projects/${id}/rev`,
  stats: (id: string) => `/api/projects/${id}/stats`,
  items: (id: string, params: string) =>
    `/api/projects/${id}/items${params ? `?${params}` : ""}`,
  item: (id: string, itemId: string) => `/api/projects/${id}/items/${itemId}`,
  photos: (id: string, itemId: string) =>
    `/api/projects/${id}/items/${itemId}/photos`,
  photo: (id: string, photoId: string) => `/api/projects/${id}/photos/${photoId}`,
  selections: (id: string, photoId: string) =>
    `/api/projects/${id}/photos/${photoId}/selections`,
  photoNotes: (id: string, photoId: string) =>
    `/api/projects/${id}/photos/${photoId}/notes`,
  transcriptions: (id: string, photoId: string) =>
    `/api/projects/${id}/photos/${photoId}/transcriptions`,
  selectionNotes: (id: string, selId: string) =>
    `/api/projects/${id}/selections/${selId}/notes`,
  metadata: (id: string, subjectId: string) =>
    `/api/projects/${id}/subjects/${subjectId}/metadata`,
  tags: (id: string) => `/api/projects/${id}/tags`,
  lists: (id: string) => `/api/projects/${id}/lists`,
  templates: (id: string) => `/api/projects/${id}/templates`,
  search: (id: string, q: string, scope: string) =>
    `/api/projects/${id}/search?q=${encodeURIComponent(q)}&scope=${scope}`,
  trash: (id: string) => `/api/projects/${id}/trash`,
  job: (jobId: string) => `/api/jobs/${jobId}`,
  meter: (id: string) => `/api/projects/${id}/storage/meter`,
  cpu: "/api/cpu-budget",
  health: "/api/health",
};

export function useProjects() {
  return useSWR<{ items: Project[]; total: number } | Project[]>(
    key.projects,
    fetcher,
    swrDefaults,
  );
}

export function useProject(projectId: string | null) {
  return useSWR<Project>(
    projectId ? key.project(projectId) : null,
    fetcher,
    swrDefaults,
  );
}

export function useProjectRev(projectId: string | null) {
  return useSWR<{ rev: number }>(
    projectId ? key.rev(projectId) : null,
    fetcher,
    { ...swrDefaults, refreshInterval: 0 },
  );
}

/** Paginated item list; maps wire items → view-model. */
export async function fetchItems(url: string): Promise<{ items: Item[]; total: number }> {
  const raw = await get<{ items: unknown[]; total: number }>(url);
  return { items: (raw.items ?? []).map((i) => adaptItem(i as Parameters<typeof adaptItem>[0])), total: raw.total ?? 0 };
}

export function useItems(projectId: string | null, params: string) {
  return useSWR<{ items: Item[]; total: number }>(
    projectId ? key.items(projectId, params) : null,
    fetchItems,
    swrDefaults,
  );
}

export function useItem(projectId: string | null, itemId: string | null) {
  return useSWR<Item>(
    projectId && itemId ? key.item(projectId, itemId) : null,
    async (url: string) => adaptItem(await get(url)),
    swrDefaults,
  );
}

export function usePhotos(projectId: string | null, itemId: string | null) {
  return useSWR<{ items: Photo[]; total: number }>(
    projectId && itemId ? key.photos(projectId, itemId) : null,
    async (url: string) => {
      const raw = await get<{ items: unknown[]; total: number }>(url);
      return {
        items: (raw.items ?? []).map((p) => adaptPhoto(p as Parameters<typeof adaptPhoto>[0])),
        total: raw.total ?? 0,
      };
    },
    swrDefaults,
  );
}

export function usePhoto(projectId: string | null, photoId: string | null) {
  return useSWR<Photo>(
    projectId && photoId ? key.photo(projectId, photoId) : null,
    async (url: string) => adaptPhoto(await get(url)),
    swrDefaults,
  );
}

export function useSelections(projectId: string | null, photoId: string | null) {
  return useSWR<{ items: Selection[]; total: number }>(
    projectId && photoId ? key.selections(projectId, photoId) : null,
    async (url: string) => {
      const raw = await get<{ items: unknown[]; total: number }>(url);
      return {
        items: (raw.items ?? []).map((s) => adaptSelection(s as Parameters<typeof adaptSelection>[0])),
        total: raw.total ?? 0,
      };
    },
    swrDefaults,
  );
}

export type NoteSubjectKind = "photo" | "selection";

export function noteKey(
  projectId: string,
  subjectId: string,
  kind: NoteSubjectKind,
): string {
  return kind === "photo"
    ? key.photoNotes(projectId, subjectId)
    : key.selectionNotes(projectId, subjectId);
}

/** Notes attach to photos and selections (no item-level notes in v1). */
export function useNotes(
  projectId: string | null,
  subjectId: string | null,
  kind: NoteSubjectKind,
) {
  return useSWR<{ items: NoteDoc[]; total: number }>(
    projectId && subjectId ? noteKey(projectId, subjectId, kind) : null,
    fetcher,
    swrDefaults,
  );
}

export function useMetadata(projectId: string | null, subjectId: string | null) {
  return useSWR<Record<string, string>>(
    projectId && subjectId ? key.metadata(projectId, subjectId) : null,
    async (url: string) => {
      const raw = await get<{ values: { property_uri: string; text: string }[] }>(url);
      return adaptMetadataValues(raw.values);
    },
    swrDefaults,
  );
}

/** Full metadata rows (for mixed-value bulk display). */
export function useMetadataRows(projectId: string | null, subjectId: string | null) {
  return useSWR<{ property_uri: string; text: string; datatype: string; language: string | null }[]>(
    projectId && subjectId ? key.metadata(projectId, subjectId) : null,
    async (url: string) => {
      const raw = await get<{ values: { property_uri: string; text: string; datatype: string; language: string | null }[] }>(url);
      return raw.values ?? [];
    },
    swrDefaults,
  );
}

export function useTags(projectId: string | null) {
  return useSWR<{ items: Tag[]; total: number } | Tag[]>(
    projectId ? key.tags(projectId) : null,
    fetcher,
    swrDefaults,
  );
}

export function useLists(projectId: string | null) {
  return useSWR<ListNode[]>(
    projectId ? key.lists(projectId) : null,
    fetcher,
    swrDefaults,
  );
}

export function useTemplates(projectId: string | null) {
  return useSWR<UiTemplate[]>(
    projectId ? key.templates(projectId) : null,
    async (url: string) => {
      const raw = await get<{ items: unknown[]; total: number }>(url);
      return (raw.items ?? []).map((t) => adaptTemplate(t as Parameters<typeof adaptTemplate>[0]));
    },
    swrDefaults,
  );
}

export interface SearchResults {
  query: string;
  hits: SearchHit[];
  badges: Record<string, number>;
}

export function useSearch(
  projectId: string | null,
  query: string,
  scope: string,
) {
  const q = query.trim();
  return useSWR<SearchResults>(
    projectId && q ? key.search(projectId, q, scope) : null,
    fetcher,
    { ...swrDefaults, dedupingInterval: 800 },
  );
}

export function useTrash(projectId: string | null) {
  return useSWR<{ items: TrashEntry[]; total: number }>(
    projectId ? key.trash(projectId) : null,
    fetcher,
    swrDefaults,
  );
}

export function useStats(projectId: string | null) {
  return useSWR<ProjectStats>(
    projectId ? key.stats(projectId) : null,
    fetcher,
    swrDefaults,
  );
}

export function useJob(jobId: string | null, pollMs = 1500) {
  return useSWR<ImportJob>(jobId ? key.job(jobId) : null, fetcher, {
    ...swrDefaults,
    refreshInterval: (data) =>
      data && ["done", "failed", "cancelled"].includes(data.status) ? 0 : pollMs,
  });
}

export function useMeter(projectId: string | null) {
  return useSWR<StorageMeter>(projectId ? key.meter(projectId) : null, fetcher, {
    ...swrDefaults,
    refreshInterval: 60_000,
  });
}

export function useCpuBudget() {
  return useSWR<CpuBudgetResponse>(key.cpu, fetcher, {
    ...swrDefaults,
    refreshInterval: 60_000,
  });
}

export function useHealth() {
  return useSWR<HealthResponse>(key.health, fetcher, {
    ...swrDefaults,
    refreshInterval: 30_000,
  });
}

/** File URL helpers — always through the `file` route (302 → presigned R2). */
export function thumbUrl(projectId: string, photoId: string) {
  return buildThumbUrl(projectId, photoId);
}
export function originalUrl(projectId: string, photoId: string) {
  return buildOriginalUrl(projectId, photoId);
}

/** Wave C (row 13): transcriptions for a photo (wire shape is the view model). */
export function useTranscriptions(projectId: string | null, photoId: string | null) {
  return useSWR<{ items: Transcription[]; total: number }>(
    projectId && photoId ? key.transcriptions(projectId, photoId) : null,
    fetcher,
    swrDefaults,
  );
}

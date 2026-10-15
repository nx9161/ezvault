// SPDX-License-Identifier: MIT
// Frontend API view-models + adapters.
//
// The backend's canonical `lib/types.ts` is the single source of truth for
// wire shapes. This module re-exports those canonical types and adds:
//   - UI view-models (display titles, cover URLs, widget kinds) that the
//     server does not provide directly,
//   - `adapt*` mappers from wire JSON → view-model,
//   - file-URL builders (photos are served via the `file` route → 302 to a
//     5-min presigned R2 URL; never address R2 keys from the client).

import type {
  Item as BackendItem,
  Photo as BackendPhoto,
  Selection as BackendSelection,
  Note as BackendNote,
  Template as BackendTemplate,
  TemplateField as BackendTemplateField,
} from "@/lib/types";

export type {
  Project,
  Tag,
  ListNode,
  Template,
  TemplateField,
  MetadataValue,
  StorageMeter,
  ImportJob,
  SearchHit,
  TrashEntry,
  Note,
  DuplicatePolicy,
  NotesExportFormat,
  JobStatus,
  StoragePolicy,
} from "@/lib/types";

export type Id = string;

/** Non-destructive edit params — mirrors backend `PhotoJson.edits` (all required). */
export interface PhotoEdits {
  angle: number; // 0–360, 90° steps in UI
  mirror: boolean; // horizontal only (ADR-2.21)
  brightness: number; // -100..100
  contrast: number; // -100..100
  hue: number; // -180..180
  saturation: number; // -100..100
  negative: boolean;
  sharpen: number; // 0..100
}

export const DEFAULT_EDITS: PhotoEdits = {
  angle: 0,
  mirror: false,
  brightness: 0,
  contrast: 0,
  hue: 0,
  saturation: 0,
  negative: false,
  sharpen: 0,
};

export function editsDirty(e: PhotoEdits): boolean {
  return (
    e.angle !== 0 ||
    e.mirror ||
    e.brightness !== 0 ||
    e.contrast !== 0 ||
    e.hue !== 0 ||
    e.saturation !== 0 ||
    e.negative ||
    e.sharpen !== 0
  );
}

/** Normalize possibly-partial edit params (backend `EditParams` is all-optional). */
export function normalizeEdits(e: Partial<PhotoEdits> | null | undefined): PhotoEdits {
  return { ...DEFAULT_EDITS, ...(e ?? {}) };
}

// ---------------------------------------------------------------------------
// Item view-model. The wire `Item` carries no display title — titles live in
// metadata (template title field). Until the list endpoint enriches titles,
// the adapter falls back to a short-id label (never blank).
// ---------------------------------------------------------------------------

export interface Item {
  id: Id;
  project_id: Id;
  template_id: Id | null;
  /** Display label: enriched `title` when the server provides one, else short id. */
  title: string;
  cover_photo_id: Id | null;
  photo_count: number;
  selection_count: number;
  note_count: number;
  tags: string[];
  lists: Id[];
  created_at: string;
  updated_at: string;
}

type WireItem = BackendItem & {
  title?: string | null;
  tags?: string[];
  lists?: { list_id: string }[] | string[] | null;
};

export function adaptItem(raw: WireItem): Item {
  const lists = Array.isArray(raw.lists)
    ? raw.lists.map((l) => (typeof l === "string" ? l : l.list_id))
    : [];
  return {
    id: raw.subject_id,
    project_id: raw.project_id,
    template_id: raw.template_id,
    title: raw.title?.trim() || `Item ${raw.subject_id.slice(0, 8)}`,
    cover_photo_id: raw.cover_image_id ?? null,
    photo_count: raw.photo_count ?? 0,
    selection_count: raw.selection_count ?? 0,
    note_count: raw.note_count ?? 0,
    tags: raw.tags ?? [],
    lists,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Photo view-model.
// ---------------------------------------------------------------------------

export interface Photo {
  id: Id;
  project_id: Id;
  item_id: Id;
  filename: string;
  mimetype: string;
  sha256: string;
  size_bytes: number;
  width: number;
  height: number;
  edits: PhotoEdits;
  missing_original: boolean;
  exif: Record<string, unknown>;
  template_id: Id | null;
  position: number;
  created_at: string;
}

type WirePhoto = BackendPhoto & {
  edits?: Partial<PhotoEdits> | null;
};

export function adaptPhoto(raw: WirePhoto): Photo {
  return {
    id: raw.subject_id,
    project_id: raw.project_id,
    item_id: raw.item_id,
    filename: raw.original_filename,
    mimetype: raw.mimetype,
    sha256: raw.checksum_sha256,
    size_bytes: raw.size_bytes,
    width: raw.width,
    height: raw.height,
    edits: normalizeEdits(raw.edits),
    missing_original: raw.missing_original,
    exif: raw.exif ?? {},
    template_id: raw.template_id,
    position: raw.position,
    created_at: raw.created_at,
  };
}

// ---------------------------------------------------------------------------
// Selection view-model (wire uses x/y/width/height).
// ---------------------------------------------------------------------------

export interface Selection {
  id: Id;
  photo_id: Id;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  template_id: Id | null;
  position: number;
  note_count: number;
}

export function adaptSelection(raw: BackendSelection): Selection {
  return {
    id: raw.subject_id,
    photo_id: raw.photo_id,
    name: raw.name,
    x: raw.x,
    y: raw.y,
    w: raw.width,
    h: raw.height,
    template_id: raw.template_id,
    position: raw.position,
    note_count: raw.note_count ?? 0,
  };
}

/** Wire shape for creating/updating a selection. */
export function selectionWire(s: { name: string; x: number; y: number; w: number; h: number }) {
  return { name: s.name, x: s.x, y: s.y, width: s.w, height: s.h };
}

// ---------------------------------------------------------------------------
// Notes, templates, metadata.
// ---------------------------------------------------------------------------

export type NoteDoc = BackendNote;

export type FieldWidget = "text" | "textarea" | "date" | "number" | "uri" | "boolean";

const XSD = "http://www.w3.org/2001/XMLSchema#";
const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";

/** Map a template field's XSD datatype URI to an editing widget. */
export function datatypeToWidget(datatype?: string | null): FieldWidget {
  if (!datatype) return "text";
  const d = datatype.trim();
  const local = d.includes("#") ? d.split("#").pop()! : d;
  switch (local) {
    case "date":
    case "dateTime":
      return "date";
    case "integer":
    case "decimal":
    case "double":
    case "float":
    case "nonNegativeInteger":
    case "positiveInteger":
      return "number";
    case "anyURI":
      return "uri";
    case "boolean":
      return "boolean";
    case "HTML":
      return "textarea";
    default:
      break;
  }
  if (d === `${RDF}HTML` || d === `${RDF}XMLLiteral`) return "textarea";
  if (d === `${XSD}boolean`) return "boolean";
  return "text";
}

export interface UiTemplateField {
  /** Stable key: the property URI (wire fields carry no id). */
  id: string;
  property_uri: string;
  label: string;
  label_i18n?: Record<string, string>;
  widget: FieldWidget;
  required: boolean;
}

export function adaptTemplateField(f: BackendTemplateField): UiTemplateField {
  return {
    id: f.property_uri,
    property_uri: f.property_uri,
    label: f.label,
    label_i18n: f.label_i18n,
    widget: datatypeToWidget(f.datatype),
    required: f.required ?? false,
  };
}

export interface UiTemplate extends Omit<BackendTemplate, "fields"> {
  fields: UiTemplateField[];
}

export function adaptTemplate(t: BackendTemplate): UiTemplate {
  return { ...t, fields: (t.fields ?? []).map(adaptTemplateField) };
}

/** Wire metadata rows → property_uri → first text (bulk-edit mixed detection is separate). */
export function adaptMetadataValues(
  rows: { property_uri: string; text: string }[] | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows ?? []) {
    if (!(r.property_uri in out)) out[r.property_uri] = r.text ?? "";
  }
  return out;
}

/** UI values → wire `SetMetadataRequest` array form. */
export type MetadataValuesMap = Record<string, string>;

/** SHOULD-29: per-field languages (ISO 639-1). The metadata API accepts a
 * `language` per value; send it when the user set one, omit otherwise. */
export function metadataWire(
  values: Record<string, string>,
  datatypes?: Record<string, string>,
  languages?: Record<string, string | null>,
) {
  return Object.entries(values).map(([property_uri, text]) => ({
    property_uri,
    text,
    ...(datatypes?.[property_uri] ? { datatype: datatypes[property_uri] } : {}),
    ...(languages?.[property_uri] ? { language: languages[property_uri] } : {}),
  }));
}

// ---------------------------------------------------------------------------
// File URLs — always through the `file` route (302 → presigned R2).
// ---------------------------------------------------------------------------

export function thumbUrl(projectId: string, photoSubjectId: string): string {
  return `/api/projects/${projectId}/photos/${photoSubjectId}/file?kind=thumb`;
}

export function originalUrl(projectId: string, photoSubjectId: string): string {
  return `/api/projects/${projectId}/photos/${photoSubjectId}/file?kind=original`;
}

/** Cache-busting is unnecessary: thumbs are content-addressed server-side. */
export function thumbSrc(projectId: string, photoSubjectId: string): string {
  return thumbUrl(projectId, photoSubjectId);
}

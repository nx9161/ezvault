// SPDX-License-Identifier: MIT
/**
 * lib/types.ts — shared API request/response types for the /api/* surface.
 *
 * Mirrors phase2-architecture.md §2 (the contract between backend and
 * frontend). Neither builder changes a route's method, path, or
 * request/response shape without updating CONTRACT.md AND notifying the
 * other builder via the coordinator.
 *
 * Conventions: JSON in/out; mutating routes accept `clientOpId` (UUID,
 * server-deduped via command_log.op_id); list routes paginate
 * (`?cursor=&limit=`); `cursor` is an opaque offset token (integer offset
 * encoded as a string) in v1.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export type UUID = string;

export interface Paginated<T> {
  items: T[];
  /** Opaque cursor for the next page; absent when there is no next page. */
  nextCursor?: string;
  total: number;
}

export interface MutationMeta {
  /** Client-generated idempotency key echoed back. */
  clientOpId?: UUID;
  /** True when the op was already applied (idempotent replay). */
  replayed?: boolean;
  /** Bumped projects.rev — the cross-tab staleness counter. */
  rev: number;
}

export interface ApiError {
  error: string;
  /** Machine-readable code, e.g. "not_found", "validation", "rate_limited". */
  code: string;
  /** Extra detail (field errors, retry hints). Never includes secrets. */
  detail?: unknown;
}

// ---------------------------------------------------------------------------
// Projects (§2.1)
// ---------------------------------------------------------------------------

export type DuplicatePolicy = 'skip' | 'keep_both' | 'ask';
export type NotesExportFormat = 'html' | 'markdown';

export interface Project {
  id: UUID;
  name: string;
  rev: number;
  default_template_id: UUID | null;
  duplicate_policy: DuplicatePolicy;
  notes_export_format: NotesExportFormat;
  created_at: string;
  updated_at: string;
}

export interface CreateProjectRequest {
  name: string;
  duplicate_policy?: DuplicatePolicy;
  notes_export_format?: NotesExportFormat;
  clientOpId?: UUID;
}

export interface UpdateProjectRequest {
  name?: string;
  default_template_id?: UUID | null;
  duplicate_policy?: DuplicatePolicy;
  notes_export_format?: NotesExportFormat;
  clientOpId?: UUID;
}

export interface ProjectStats {
  project_id: UUID;
  item_count: number;
  photo_count: number;
  selection_count: number;
  note_count: number;
  tag_count: number;
  list_count: number;
  bytes_originals: number;
  bytes_thumbs: number;
  bytes_exports: number;
}

// ---------------------------------------------------------------------------
// Items & photos (§2.2)
// ---------------------------------------------------------------------------

export type SubjectKind = 'item' | 'photo' | 'selection';

export interface Item {
  subject_id: UUID;
  project_id: UUID;
  kind: 'item';
  template_id: UUID | null;
  cover_image_id: UUID | null;
  created_at: string;
  updated_at: string;
  /** Derived counts (read model; not stored). */
  photo_count: number;
  selection_count: number;
  note_count: number;
}

/** Non-destructive edit params — Tropy-exact columns (ADR-2.21). */
export interface EditParams {
  /** 0–360 CCW degrees (NUMERIC). */
  angle?: number;
  /** Horizontal flip ONLY (Tropy has no vertical mirror). */
  mirror?: boolean;
  /** -100..100 */
  brightness?: number;
  /** -100..100 */
  contrast?: number;
  /** -180..180 */
  hue?: number;
  /** -100..100 */
  saturation?: number;
  negative?: boolean;
  /** 0..100 */
  sharpen?: number;
}

export interface Photo {
  subject_id: UUID;
  project_id: UUID;
  kind: 'photo';
  item_id: UUID;
  image_id: UUID;
  position: number;
  r2_key: string | null;
  thumb_r2_key: string;
  missing_original: boolean;
  original_filename: string;
  mimetype: string;
  checksum_sha256: string;
  tpy_checksum_md5: string | null;
  size_bytes: number;
  width: number;
  height: number;
  exif: Record<string, unknown>;
  /** 0-based page index. */
  page: number;
  density: number | null;
  keep_original: boolean;
  template_id: UUID | null;
  edits: EditParams;
  created_at: string;
}

export interface CreateItemRequest {
  template_id?: UUID | null;
  list_id?: UUID | null;
  position?: number;
  clientOpId?: UUID;
}

export interface UpdateItemRequest {
  template_id?: UUID | null;
  cover_image_id?: UUID | null;
  clientOpId?: UUID;
}

export type BulkItemOp =
  | { op: 'add_tags'; tag_ids: UUID[] }
  | { op: 'remove_tags'; tag_ids: UUID[] }
  | { op: 'move_to_list'; list_id: UUID | null }
  | { op: 'apply_template'; template_id: UUID | null }
  | { op: 'trash'; reason?: 'user' | 'auto' | 'merge' };

export interface BulkItemsRequest {
  item_ids: UUID[];
  ops: BulkItemOp[];
  clientOpId?: UUID;
}

export interface RegisterPhotoRequest {
  /** Subject row for the parent item. */
  item_id: UUID;
  original_filename: string;
  mimetype: string;
  checksum_sha256: string;
  tpy_checksum_md5?: string | null;
  size_bytes: number;
  width: number;
  height: number;
  exif?: Record<string, unknown>;
  page?: number;
  density?: number | null;
  /** R2 key of the staged upload (uploads/{jobId}/…). */
  staged_key: string;
  thumb_r2_key: string;
  position?: number;
  template_id?: UUID | null;
  duplicate_policy?: DuplicatePolicy;
  clientOpId?: UUID;
}

export interface RegisterPhotoResponse extends MutationMeta {
  photo: Photo;
  /** 'created' | 'skipped_duplicate' | 'kept_both' */
  dedupe: string;
}

export interface UpdatePhotoRequest {
  template_id?: UUID | null;
  position?: number;
  keep_original?: boolean;
  clientOpId?: UUID;
}

export type FileKind = 'original' | 'thumb';
export type ExportFormat = 'png' | 'jpg';

// ---------------------------------------------------------------------------
// Selections (§2.3)
// ---------------------------------------------------------------------------

export interface Selection {
  subject_id: UUID;
  project_id: UUID;
  kind: 'selection';
  photo_id: UUID;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  position: number;
  template_id: UUID | null;
  created_at: string;
  /** Derived count (read model; not stored). */
  note_count: number;
}

export interface CreateSelectionRequest {
  name?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  position?: number;
  template_id?: UUID | null;
  clientOpId?: UUID;
}

export interface UpdateSelectionRequest {
  name?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  template_id?: UUID | null;
  clientOpId?: UUID;
}

// ---------------------------------------------------------------------------
// Notes (§2.4)
// ---------------------------------------------------------------------------

export interface Note {
  id: UUID;
  subject_id: UUID;
  project_id: UUID;
  /** Plain-text extraction (search/autosave display). */
  text: string;
  /** TipTap/ProseMirror document JSON. */
  state: Record<string, unknown>;
  language: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateNoteRequest {
  /** TipTap doc JSON. Sanitized server-side (B13) before storage. */
  state: Record<string, unknown>;
  text?: string;
  language?: string | null;
  clientOpId?: UUID;
}

export interface UpdateNoteRequest {
  state?: Record<string, unknown>;
  text?: string;
  language?: string | null;
  clientOpId?: UUID;
}

// ---------------------------------------------------------------------------
// Templates & vocabularies (§2.5)
// ---------------------------------------------------------------------------

export interface TemplateField {
  property_uri: string;
  label: string;
  label_i18n?: Record<string, string>;
  datatype?: string;
  required?: boolean;
  order?: number;
}

export interface Template {
  id: UUID;
  project_id: UUID;
  name: string;
  uri: string | null;
  label_i18n: Record<string, string>;
  fields: TemplateField[];
  created_at: string;
  updated_at: string;
}

export interface CreateTemplateRequest {
  name: string;
  uri?: string | null;
  label_i18n?: Record<string, string>;
  fields: TemplateField[];
  clientOpId?: UUID;
}

export interface UpdateTemplateRequest {
  name?: string;
  uri?: string | null;
  label_i18n?: Record<string, string>;
  fields?: TemplateField[];
  clientOpId?: UUID;
}

/** `.ttp` file shape (project-scoped template transport). */
export interface TtpDocument {
  name: string;
  uri?: string | null;
  label_i18n?: Record<string, string>;
  fields: TemplateField[];
}

export interface Vocabulary {
  prefix: string;
  uri: string;
  label: string;
}

export interface VocabImportRequest {
  /** Turtle/N3 source text (≤50k triples, B12). */
  source: string;
  format?: 'turtle' | 'n3';
  clientOpId?: UUID;
}

export interface VocabImportResponse extends MutationMeta {
  triples: number;
  properties: number;
}

// ---------------------------------------------------------------------------
// Metadata (§2.6)
// ---------------------------------------------------------------------------

export interface MetadataValue {
  value_id: UUID;
  property_uri: string;
  datatype: string;
  text: string;
  data: Record<string, unknown> | null;
  language: string | null;
  created_at: string;
}

export interface SetMetadataRequest {
  /** property_uri → new value. Each set creates a NEW metadata_values row (immutable semantics). */
  values: Array<{
    property_uri: string;
    datatype?: string;
    text: string;
    data?: Record<string, unknown> | null;
    language?: string | null;
  }>;
  /** When true, remove existing values for the listed property_uris first. */
  replace?: boolean;
  clientOpId?: UUID;
}

export interface BulkMetadataRequest {
  subject_ids: UUID[];
  values: SetMetadataRequest['values'];
  replace?: boolean;
  clientOpId?: UUID;
}

// ---------------------------------------------------------------------------
// Tags (§2.7)
// ---------------------------------------------------------------------------

export interface Tag {
  id: UUID;
  project_id: UUID;
  name: string;
  color: string;
}

export interface CreateTagRequest {
  name: string;
  color?: string;
  clientOpId?: UUID;
}

export interface UpdateTagRequest {
  name?: string;
  color?: string;
  clientOpId?: UUID;
}

// ---------------------------------------------------------------------------
// Lists (§2.8)
// ---------------------------------------------------------------------------

export interface ListNode {
  id: UUID;
  project_id: UUID;
  name: string;
  parent_list_id: UUID | null;
  position: number;
  color: string | null;
  children?: ListNode[];
  item_count?: number;
}

export interface CreateListRequest {
  name: string;
  parent_list_id?: UUID | null;
  position?: number;
  color?: string | null;
  clientOpId?: UUID;
}

export interface UpdateListRequest {
  name?: string;
  parent_list_id?: UUID | null;
  position?: number;
  color?: string | null;
  clientOpId?: UUID;
}

// ---------------------------------------------------------------------------
// Search (§2.9)
// ---------------------------------------------------------------------------

export type SearchScope = 'all' | 'metadata' | 'notes' | 'tags';

export interface SearchHit {
  subject_id: UUID;
  project_id: UUID;
  subject_kind: SubjectKind;
  rank: number;
  /** Safe HTML with <mark> highlights (server-escaped, B14). Render as-is. */
  snippet: string;
}

export interface SearchResponse {
  query: string;
  hits: SearchHit[];
  /** Hit counts per list/tag id for sidebar badges. */
  badges: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Trash (§2.10)
// ---------------------------------------------------------------------------

export type TrashReason = 'user' | 'auto' | 'merge';

export interface TrashEntry {
  subject_id: UUID;
  project_id: UUID;
  subject_kind: SubjectKind;
  reason: TrashReason;
  deleted_at: string;
  label: string;
}

// ---------------------------------------------------------------------------
// Import — photo pipeline (§2.11)
// ---------------------------------------------------------------------------

/** v1 upload allowlist (10 formats). */
export const UPLOAD_MIMETYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/tiff',
  'image/heic',
  'image/heif',
  'image/avif',
] as const;
export type UploadMimetype = (typeof UPLOAD_MIMETYPES)[number];

export interface PresignFile {
  /** Client-computed sha256 (advisory; server verifies size + magic bytes — B18). */
  sha256: string;
  size: number;
  mimetype: string;
  filename: string;
}

export interface PresignRequest {
  project_id: UUID;
  files: PresignFile[];
  /** Browser-decoded HEIC artifacts ride along as extra files; no special flag needed. */
  clientOpId?: UUID;
}

export interface PresignGrant {
  /** Server-chosen key: uploads/{jobId}/{uuid}.{ext} */
  key: string;
  /** Presigned PUT URL (15-min TTL). */
  url: string;
  expires_at: string;
  sha256: string;
  mimetype: string;
}

export interface PresignResponse {
  job_id: UUID;
  grants: PresignGrant[];
}

export interface ImportCompleteRequest {
  job_id: UUID;
  project_id: UUID;
  /**
   * Files the client PUT. Preferred shape: files[] with per-file sha256
   * (server-verified, B18). The legacy keys[] shape is accepted when sha256
   * was supplied at presign time and matches the staged key order — prefer
   * files[] for new clients.
   */
  files?: Array<{ key: string; sha256: string }>;
  keys?: string[];
  /**
   * Browser-decoded HEIC/HEIF/AVIF → JPEG conversion artifacts.
   * Each entry links the artifact's staged key to the original's staged key;
   * /process uses the artifact as the decode source (ADR-2.16).
   */
  conversions?: Array<{ key: string; conversion_of: string }>;
  /** Client-extracted EXIF for HEIC files, keyed by staged key. */
  exif?: Record<string, Record<string, unknown>>;
  duplicate_policy?: DuplicatePolicy;
  clientOpId?: UUID;
}

export interface ImportCompletePhoto {
  key: string;
  photo_subject_id: UUID;
  item_id: UUID;
  dedupe: 'created' | 'skipped_duplicate' | 'kept_both';
}

export interface ImportCompleteResponse extends MutationMeta {
  job_id: UUID;
  accepted: ImportCompletePhoto[];
  rejected: Array<{ key: string; reason: string }>;
}

export interface ImportProcessRequest {
  job_id: UUID;
  project_id: UUID;
  photo_subject_id: UUID;
  staged_key: string;
  clientOpId?: UUID;
}

export interface ImportProcessResponse extends MutationMeta {
  photo: Photo;
}

export interface FolderSessionRequest {
  project_id: UUID;
  /** Relative paths, e.g. ["a/b/photo.jpg"]. Server creates nested lists mirroring dirs. */
  paths: string[];
  clientOpId?: UUID;
}

export interface FolderSessionResponse extends MutationMeta {
  job_id: UUID;
  /** path → list_id of its parent directory list */
  mapping: Record<string, UUID>;
  lists: ListNode[];
}

export type JobStatus = 'queued' | 'running' | 'paused_cpu' | 'failed' | 'done' | 'cancelled';
export type JobKind = 'upload' | 'folder' | 'tpy' | 'jsonld' | 'compress';

export interface ImportJob {
  id: UUID;
  project_id: UUID;
  kind: JobKind;
  status: JobStatus;
  total: number;
  done: number;
  failed: number;
  cpu_seconds: number;
  checkpoint: Record<string, unknown>;
  report: Record<string, unknown> | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Import — .tpy wizard (§2.12)
// ---------------------------------------------------------------------------

export interface TpyPresignRequest {
  project_id: UUID;
  /** Include when uploading an assets bundle alongside project.tpy. */
  with_assets?: boolean;
  clientOpId?: UUID;
}

export interface TpyPresignResponse {
  job_id: UUID;
  tpy_grant: PresignGrant;
  assets_grant?: PresignGrant;
}

export interface TpyAnalyzeResponse extends MutationMeta {
  job_id: UUID;
  application_id_ok: boolean;
  user_version: number;
  user_version_warning: string | null;
  counts: Record<string, number>;
  template_uris: string[];
  /** Tables present in the .tpy that EZVault does not model (→ raw_import). */
  unknown_tables: string[];
}

export interface TpyRunRequest {
  job_id: UUID;
  project_id: UUID;
  /** 'standard' = assets.zip present; 'advanced' = re-link by filename→md5. */
  mode: 'standard' | 'advanced';
  duplicate_policy?: DuplicatePolicy;
  /** Template URI → action. */
  template_map?: Record<string, 'use_existing' | 'create_new'>;
  clientOpId?: UUID;
}

export interface TpyRunResponse extends MutationMeta {
  job_id: UUID;
  imported: Record<string, number>;
  expected: Record<string, number>;
  conflicts: number;
  done: boolean;
}

export interface ResolveMissingRequest {
  job_id: UUID;
  project_id: UUID;
  /** staged original key → photo subject_id to re-link. */
  links: Array<{ staged_key: string; photo_subject_id: UUID }>;
  clientOpId?: UUID;
}

// ---------------------------------------------------------------------------
// Export (§2.13)
// ---------------------------------------------------------------------------

export interface JsonLdExportQuery {
  item?: UUID;
  /** Export the whole project (the vendor-portable leg). */
  all?: '1';
}

// ---------------------------------------------------------------------------
// Storage meter & retention (§2.14)
// ---------------------------------------------------------------------------

export type StoragePolicy = 'ok' | 'warn' | 'block';

export interface StorageMeter {
  bytes_used: number;
  bytes_limit: number;
  pct: number;
  policy: StoragePolicy;
  breakdown: { originals: number; thumbs: number; exports: number };
  updated_at: string;
}

export interface CompressRequest {
  project_id: UUID;
  /** Compress only these photos; omit = all eligible (keep_original excluded). */
  photo_ids?: UUID[];
  clientOpId?: UUID;
}

export interface HealthResponse {
  neon: 'ok' | 'error';
  r2: 'ok' | 'error' | 'unconfigured';
  queue: { queued: number; running: number; failed: number };
  codecs: Record<string, boolean>;
}

export interface CpuBudgetResponse {
  used_s: number;
  cap_s: number;
  guard_s: number;
  paused: boolean;
  resumes: string | null;
}

// ---------------------------------------------------------------------------
// Sentinel tokens (B14) — server emits these in ts_headline output, escapes
// ALL other HTML, then swaps sentinels for <mark>. Documented here so both
// builders use the same contract.
// ---------------------------------------------------------------------------

export const SEARCH_SENTINEL_START = '\u2060MARK\u2060';
export const SEARCH_SENTINEL_END = '\u2060/MARK\u2060';

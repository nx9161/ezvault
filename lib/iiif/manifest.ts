// SPDX-License-Identifier: MIT
/**
 * lib/iiif/manifest.ts — IIIF Presentation API manifest parser (Wave D,
 * row 26). Pure module (no server-only, no fetch): routes feed it the
 * fetched JSON; tests feed it committed v2 + v3 fixtures.
 *
 * Implemented from the public IIIF Presentation API spec (2.x + 3.0) —
 * clean-room, no Tropy code.
 *
 * Harvest choice (documented per the brief): ONE ITEM PER CANVAS,
 * grouped in a list named from the manifest label — this matches the
 * reference IIIF import plugin's behavior of treating each canvas as a
 * separate archival item under a shared collection (here: list).
 *
 * Image selection per canvas: the FIRST painting image. When the image
 * carries an Image API service, the harvested URL is the service's
 * full-size JPEG — `{service-id}/full/max/0/default.jpg` per the IIIF
 * Image API (`full/max` = full size as delivered, `0` rotation,
 * `default` quality, jpg format). Without a service, the image body's
 * own URL is used as-is.
 */

export class IiifParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IiifParseError';
  }
}

export interface IiifCanvas {
  /** Canvas id (v3 `id` / v2 `@id`), or a positional fallback. */
  id: string;
  label: string | null;
  /** Harvest URL (service-normalized when a service is present). */
  imageUrl: string;
  /** Raw Image API service id, when present. */
  serviceId: string | null;
  width: number | null;
  height: number | null;
}

export interface IiifManifest {
  version: 2 | 3;
  id: string | null;
  label: string;
  description: string | null;
  /** Manifest-level metadata pairs (display labels preserved verbatim). */
  metadata: { label: string; value: string }[];
  canvases: IiifCanvas[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;

/** IIIF language/value shapes -> one display string (first value wins). */
export function iiifText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) {
    for (const el of v) {
      const s = iiifText(el);
      if (s) return s;
    }
    return '';
  }
  if (v && typeof v === 'object') {
    const o = v as AnyObj;
    if (typeof o['@value'] === 'string') return o['@value'];
    if (typeof o['value'] === 'string') return o['value'];
    // Language map (v3): prefer 'en', then 'none', then the first entry.
    const langs = Object.keys(o);
    for (const pref of ['en', 'none', ...langs]) {
      if (Array.isArray(o[pref])) {
        const s = iiifText(o[pref]);
        if (s) return s;
      }
    }
  }
  return '';
}

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function serviceIdOf(service: unknown): string | null {
  const first = asArray(service as AnyObj[])[0];
  if (!first || typeof first !== 'object') return null;
  const id = first['id'] ?? first['@id'];
  return typeof id === 'string' && id ? id.replace(/\/+$/, '') : null;
}

/** Full-size JPEG URL for an Image API service id (Image API spec). */
export function fullSizeImageUrl(serviceId: string): string {
  return `${serviceId.replace(/\/+$/, '')}/full/max/0/default.jpg`;
}

function canvasV3(c: AnyObj, idx: number): IiifCanvas | null {
  let body: AnyObj | null = null;
  for (const page of asArray<AnyObj>(c['items'])) {
    for (const anno of asArray<AnyObj>(page['items'])) {
      const b = anno['body'];
      const candidate = asArray<AnyObj>(b)[0];
      if (candidate && (candidate['type'] === 'Image' || typeof candidate['id'] === 'string')) {
        body = candidate;
        break;
      }
    }
    if (body) break;
  }
  if (!body) return null;
  const serviceId = serviceIdOf(body['service']);
  const rawId = typeof body['id'] === 'string' ? body['id'] : null;
  const imageUrl = serviceId ? fullSizeImageUrl(serviceId) : rawId;
  if (!imageUrl) return null;
  return {
    id: typeof c['id'] === 'string' ? c['id'] : `canvas-${idx + 1}`,
    label: iiifText(c['label']) || null,
    imageUrl,
    serviceId,
    width: typeof c['width'] === 'number' ? c['width'] : null,
    height: typeof c['height'] === 'number' ? c['height'] : null,
  };
}

function canvasV2(c: AnyObj, idx: number): IiifCanvas | null {
  const image = asArray<AnyObj>(c['images'])[0];
  const resource = (image?.['resource'] ?? {}) as AnyObj;
  const serviceId = serviceIdOf(resource['service']);
  const rawId = typeof resource['@id'] === 'string' ? resource['@id'] : null;
  const imageUrl = serviceId ? fullSizeImageUrl(serviceId) : rawId;
  if (!imageUrl) return null;
  return {
    id: typeof c['@id'] === 'string' ? c['@id'] : `canvas-${idx + 1}`,
    label: iiifText(c['label']) || null,
    imageUrl,
    serviceId,
    width: typeof c['width'] === 'number' ? c['width'] : null,
    height: typeof c['height'] === 'number' ? c['height'] : null,
  };
}

/** Parse a IIIF Presentation manifest (v2 or v3) into the harvest shape. */
export function parseIiifManifest(doc: unknown): IiifManifest {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new IiifParseError('manifest is not a JSON object');
  }
  const root = doc as AnyObj;
  const isV3 = root['type'] === 'Manifest' || asArray<AnyObj>(root['items']).some((i) => i?.['type'] === 'Canvas');
  const metadata: { label: string; value: string }[] = [];
  for (const pair of asArray<AnyObj>(root['metadata'])) {
    const label = iiifText(pair?.['label']);
    const value = iiifText(pair?.['value']);
    if (label && value) metadata.push({ label, value });
  }
  const label = iiifText(root['label']) || 'IIIF import';
  const description = iiifText(root['summary']) || iiifText(root['description']) || null;

  let canvases: IiifCanvas[] = [];
  let version: 2 | 3;
  if (isV3) {
    version = 3;
    canvases = asArray<AnyObj>(root['items'])
      .filter((i) => i?.['type'] === 'Canvas')
      .map((c, i) => canvasV3(c, i))
      .filter((c): c is IiifCanvas => c !== null);
  } else {
    version = 2;
    const seq = asArray<AnyObj>(root['sequences'])[0];
    canvases = asArray<AnyObj>(seq?.['canvases'])
      .map((c, i) => canvasV2(c, i))
      .filter((c): c is IiifCanvas => c !== null);
  }
  if (!canvases.length) {
    throw new IiifParseError('manifest contains no canvases with harvestable images');
  }
  return {
    version,
    id: typeof (root['id'] ?? root['@id']) === 'string' ? (root['id'] ?? root['@id']) : null,
    label,
    description,
    metadata,
    canvases,
  };
}

export interface TemplateFieldLite {
  property_uri: string;
  label: string;
  datatype?: string;
}

const METADATA_DEFAULT_DATATYPE = 'http://www.w3.org/2001/XMLSchema#string';

function localNameOf(uri: string): string {
  const parts = uri.split(/[/#]/).filter(Boolean);
  return (parts[parts.length - 1] ?? '').toLowerCase();
}

/**
 * Map manifest pairs onto template fields (pure — unit-tested). A pair
 * maps when its label IS a template property URI, or matches a field
 * label or property local name (case-insensitive). Unmapped pairs are
 * returned for preservation in an item note — never dropped. The canvas
 * title fills the template's `title` field and the manifest description
 * its `description` field when those are still unset.
 */
export function mapManifestMetadata(
  manifest: IiifManifest,
  canvasTitle: string,
  fields: TemplateFieldLite[],
): { values: { property_uri: string; datatype: string; text: string }[]; unmapped: { label: string; value: string }[] } {
  const byLabel = new Map<string, TemplateFieldLite>();
  const byLocal = new Map<string, TemplateFieldLite>();
  const byUri = new Map<string, TemplateFieldLite>();
  for (const f of fields) {
    if (f.label) byLabel.set(f.label.trim().toLowerCase(), f);
    byLocal.set(localNameOf(f.property_uri), f);
    byUri.set(f.property_uri, f);
  }
  const values: { property_uri: string; datatype: string; text: string }[] = [];
  const used = new Set<string>();
  const unmapped: { label: string; value: string }[] = [];
  const add = (field: TemplateFieldLite, text: string) => {
    values.push({ property_uri: field.property_uri, datatype: field.datatype || METADATA_DEFAULT_DATATYPE, text });
    used.add(field.property_uri);
  };
  for (const pair of manifest.metadata) {
    const field = byUri.get(pair.label) ?? byLabel.get(pair.label.trim().toLowerCase()) ?? byLocal.get(pair.label.trim().toLowerCase());
    if (field) add(field, pair.value);
    else unmapped.push(pair);
  }
  const descField = byLocal.get('description');
  if (descField && !used.has(descField.property_uri) && manifest.description) add(descField, manifest.description);
  const titleField = byLocal.get('title');
  if (titleField && !used.has(titleField.property_uri) && canvasTitle) add(titleField, canvasTitle);
  return { values, unmapped };
}

export interface HarvestEntry {
  canvasId: string;
  /** Item title candidate: canvas label, else manifest label + position. */
  title: string;
  imageUrl: string;
  serviceId: string | null;
  width: number | null;
  height: number | null;
  filename: string;
}

/** The harvest plan: one entry (one future item) per canvas, in order. */
export function planHarvest(manifest: IiifManifest): HarvestEntry[] {
  return manifest.canvases.map((c, i) => ({
    canvasId: c.id,
    title: c.label || `${manifest.label} — canvas ${i + 1}`,
    imageUrl: c.imageUrl,
    serviceId: c.serviceId,
    width: c.width,
    height: c.height,
    filename: `iiif-canvas-${i + 1}.jpg`,
  }));
}

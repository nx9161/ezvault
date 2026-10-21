// SPDX-License-Identifier: MIT
/**
 * lib/import/jsonld-expand.ts — JSON-LD expansion + re-compaction seam
 * (pure module: no server-only, no DB — unit-testable like jsonld-context).
 *
 * WHY BOTH STEPS (sweep find, 2026-10-21): acceptJsonLd expanded the
 * incoming document (B10: strict loader, @vocab resolution) and then ran
 * its import walk over the EXPANDED nodes — but the walk is written
 * against the COMPACT vocabulary shape (node['tag'], node['photo'],
 * nested note/filename/checksum keys). Expansion renames every
 * @vocab term to its full IRI (https://tropy.org/v1/tropy#tag, …), so
 * the walk found items and full-IRI metadata only and SILENTLY dropped
 * tags, lists, notes, photos and selections — the app's own JSON-LD
 * export re-imported as bare items. Compacting the expanded form back
 * with the Tropy @vocab context restores exactly the shape the walk
 * (and every Tropy/EZVault export) uses, while expansion still does
 * the B10 validation/resolution work first.
 */
import { strictDocumentLoader, RemoteContextRejectedError, TROPY_CONTEXT_URL } from './jsonld-context';

export { RemoteContextRejectedError };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonLdNode = Record<string, any>;

/** Expand (strict loader) then compact with the Tropy vocab; returns the graph nodes. */
export async function expandAndCompact(doc: unknown): Promise<JsonLdNode[]> {
  const { default: jsonld } = await import('jsonld');
  const expanded = (await jsonld.expand(doc as never, {
    documentLoader: strictDocumentLoader,
  } as never)) as JsonLdNode[];
  const compacted = (await jsonld.compact(expanded as never, { '@vocab': TROPY_CONTEXT_URL } as never, {
    documentLoader: strictDocumentLoader,
  } as never)) as JsonLdNode;
  const graph = compacted['@graph'];
  const nodes = Array.isArray(graph) ? graph : [compacted];
  return nodes.filter((n): n is JsonLdNode => !!n && typeof n === 'object');
}

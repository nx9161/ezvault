// SPDX-License-Identifier: MIT
import 'server-only';

/**
 * lib/import/vocab.ts — Turtle/N3 vocabulary import (B12).
 *
 * Streaming N3 parser with a 50k triple cap (413 beyond). Imported
 * vocabularies persist in the `vocabularies` table (migration 0002) and
 * join the built-in read-only set (DC elements+terms, RDF, Europeana).
 */

import { randomUUID } from 'node:crypto';
import { sql } from '../db/index';
import { HttpError } from '../api/route-utils';

/** B12: triple cap for streaming Turtle/N3 import. */
export const MAX_TRIPLES = 50_000;

/** Built-in read-only vocabularies (phase2 §2.5). */
export const BUILTIN_VOCABULARIES = [
  { prefix: 'dc', uri: 'http://purl.org/dc/elements/1.1/', label: 'Dublin Core Elements' },
  { prefix: 'dcterms', uri: 'http://purl.org/dc/terms/', label: 'Dublin Core Terms' },
  { prefix: 'rdf', uri: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#', label: 'RDF' },
  { prefix: 'edm', uri: 'http://www.europeana.eu/schemas/edm/', label: 'Europeana Data Model' },
];

export interface VocabImportResult {
  triples: number;
  properties: number;
  vocabularyId: string;
}

/**
 * Parse Turtle/N3 source (streaming) and persist the vocabulary.
 * Throws HttpError(413) when the triple cap is exceeded.
 */
export async function importVocabulary(source: string, format: 'turtle' | 'n3' = 'turtle'): Promise<VocabImportResult> {
  const { StreamParser } = await import('n3');
  const { Readable } = await import('node:stream');

  const parser = new StreamParser({ format: format === 'n3' ? 'N3' : 'Turtle' });
  const stream = Readable.from([source]);
  const quads: { subject: string; predicate: string; object: string }[] = [];
  const prefixes = new Map<string, string>();

  await new Promise<void>((resolve, reject) => {
    stream.pipe(parser);
    parser.on('data', (quad: { subject: { value: string }; predicate: { value: string }; object: { value: string } }) => {
      if (quads.length >= MAX_TRIPLES) {
        reject(new HttpError(413, 'too_many_triples', `vocabulary exceeds the ${MAX_TRIPLES}-triple cap (B12)`));
        return;
      }
      quads.push({ subject: quad.subject.value, predicate: quad.predicate.value, object: quad.object.value });
    });
    parser.on('prefix', (prefix: string, iri: { value: string }) => {
      prefixes.set(prefix, iri.value);
    });
    parser.on('end', () => resolve());
    parser.on('error', (err: Error) => reject(new HttpError(422, 'vocab_parse_failed', `N3 parse failed: ${err.message.slice(0, 200)}`)));
  });

  // Collect rdf:type Property/Class declarations as the property inventory.
  const properties = new Map<string, { label?: string; type: string }>();
  for (const qd of quads) {
    if (qd.predicate === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type') {
      const t = qd.object;
      if (/Property$/.test(t) || /Class$/.test(t) || /Datatype$/.test(t)) {
        if (!properties.has(qd.subject)) properties.set(qd.subject, { type: t });
      }
    }
  }
  for (const qd of quads) {
    const p = properties.get(qd.subject);
    if (p && qd.predicate === 'http://www.w3.org/2000/01/rdf-schema#label' && !p.label) {
      p.label = qd.object;
    }
  }

  const firstPrefix = [...prefixes.entries()][0];
  const id = randomUUID();
  const uri = firstPrefix?.[1] ?? '';
  const label = firstPrefix ? `Imported vocabulary (${firstPrefix[0]})` : 'Imported vocabulary';
  await sql()`INSERT INTO vocabularies (id, prefix, uri, label, source_format, triples, properties)
    VALUES (${id}, ${firstPrefix?.[0] ?? ''}, ${uri}, ${label}, ${format},
      ${JSON.stringify(quads.slice(0, 1000))}::jsonb, ${JSON.stringify([...properties.entries()].map(([u, p]) => ({ uri: u, ...p })))}::jsonb)`;

  return { triples: quads.length, properties: properties.size, vocabularyId: id };
}

/** All vocabularies: built-ins + imported. */
export async function listVocabularies(): Promise<{ prefix: string; uri: string; label: string; imported: boolean }[]> {
  const imported = await sql()`SELECT prefix, uri, label FROM vocabularies ORDER BY created_at`;
  return [
    ...BUILTIN_VOCABULARIES.map((v) => ({ ...v, imported: false })),
    ...imported.map((r) => ({
      prefix: r.prefix as string,
      uri: r.uri as string,
      label: r.label as string,
      imported: true,
    })),
  ];
}

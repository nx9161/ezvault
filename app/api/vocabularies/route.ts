// SPDX-License-Identifier: MIT
import { handle, ok } from '@/lib/api/route-utils';
import { listVocabularies } from '@/lib/import/vocab';

export const runtime = 'nodejs';
export const maxDuration = 300;

/** Built-in read-only vocabularies (DC elements+terms, RDF, Europeana) + imported. */
export const GET = handle(async () => {
  return ok({ vocabularies: await listVocabularies() });
});

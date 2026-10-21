// SPDX-License-Identifier: MIT
/**
 * test/wave-d.test.mjs — Wave D (rows 25/26/36).
 *
 *   - Omeka S client (mocked fetch): request shapes (path, key-auth query
 *     params, JSON body with property_id), Dublin Core mapping by
 *     property URI (terms + elements), notes -> dcterms:description,
 *     honest warnings for non-DC / unresolved properties, error mapping
 *     (status + verbatim body excerpt). NO live Omeka instance exists —
 *     nothing here fakes one; live verification is owner-side.
 *   - Credential crypto: MASTER_KEY-derived AES-256-GCM round-trip,
 *     wrong key fails, missing key refuses (no plaintext fallback).
 *   - IIIF: committed v2 + v3 fixture manifests parse (canvases in
 *     order, service URLs normalized to full-size JPEG), harvest plan
 *     (one item per canvas), metadata mapping by label/local-name/URI
 *     with unmapped pairs preserved, SSRF guard (http://, loopback,
 *     link-local metadata IP, private ranges, redirect-to-private).
 *   - Developer tokens: lifecycle (issue -> verify -> scope checks),
 *     hash-at-rest (stored value is the SHA-256, never the secret),
 *     constant-time compare source invariants, subset wiring.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { OmekaClient, OmekaError, buildOmekaItemPayload, dcTermForUri, normalizeOmekaBaseUrl } from '../lib/omeka/client';
import { encryptSecret, decryptSecret, hasMasterKey, MasterKeyMissingError } from '../lib/crypto/master-key';
import { parseIiifManifest, planHarvest, mapManifestMetadata, fullSizeImageUrl, IiifParseError } from '../lib/iiif/manifest';
import { assertPublicHttpsUrl, guardedFetchBytes, SsrfError } from '../lib/fetch-guard';
import {
  generateApiToken, hashApiToken, verifyApiToken, normalizeScopes,
  tokenHasScope, looksLikeApiToken, tokenDisplayPrefix,
} from '../lib/token-core';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const readJson = (p) => JSON.parse(read(p));

// ---------------------------------------------------------------- Omeka mapping

describe('Omeka DC mapping (row 25)', () => {
  it('maps dc terms + dc elements URIs to dcterms, rejects non-DC', () => {
    assert.equal(dcTermForUri('http://purl.org/dc/terms/title'), 'dcterms:title');
    assert.equal(dcTermForUri('http://purl.org/dc/terms/created'), 'dcterms:created');
    assert.equal(dcTermForUri('http://purl.org/dc/elements/1.1/creator'), 'dcterms:creator');
    assert.equal(dcTermForUri('http://example.org/custom/field'), null);
  });

  it('builds literal values with property_id; notes become extra descriptions', () => {
    const ids = new Map([['dcterms:title', 1], ['dcterms:creator', 2], ['dcterms:description', 3]]);
    const { payload, warnings } = buildOmekaItemPayload({
      metadata: [
        { property_uri: 'http://purl.org/dc/terms/title', text: 'Harbor at dawn' },
        { property_uri: 'http://purl.org/dc/elements/1.1/creator', text: 'B. Photographer' },
        { property_uri: 'http://example.org/custom/x', text: 'lost' },
      ],
      notes: ['first note', 'second note'],
    }, ids);
    assert.deepEqual(payload['dcterms:title'], [{ property_id: 1, type: 'literal', '@value': 'Harbor at dawn' }]);
    assert.deepEqual(payload['dcterms:creator'], [{ property_id: 2, type: 'literal', '@value': 'B. Photographer' }]);
    assert.equal(payload['dcterms:description'].length, 2);
    assert.equal(payload['dcterms:description'][0]['@value'], 'first note');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /not Dublin Core/);
  });

  it('drops + warns when a DC term is unresolved on the target site', () => {
    const { payload, warnings } = buildOmekaItemPayload(
      { metadata: [{ property_uri: 'http://purl.org/dc/terms/spatial', text: 'Lisbon' }], notes: [] },
      new Map(),
    );
    assert.deepEqual(payload, {});
    assert.match(warnings[0], /dcterms:spatial not found/);
  });

  it('normalizes base URLs and rejects nonsense', () => {
    assert.equal(normalizeOmekaBaseUrl('https://omeka.example.org/s/'), 'https://omeka.example.org/s');
    assert.throws(() => normalizeOmekaBaseUrl('not a url'), OmekaError);
    assert.throws(() => normalizeOmekaBaseUrl('ftp://x.example.org'), OmekaError);
  });
});

// ---------------------------------------------------------------- Omeka client (mocked fetch)

describe('Omeka client (mocked fetch)', () => {
  const settings = { baseUrl: 'https://omeka.example.org', keyIdentity: 'id-123', keyCredential: 'cred-456' };

  function mockFetch(handler) {
    const calls = [];
    const fn = async (url, init) => {
      calls.push({ url: String(url), init });
      return handler(String(url), init);
    };
    fn.calls = calls;
    return fn;
  }
  const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('createItem posts JSON with key auth params present', async () => {
    const fetchImpl = mockFetch(() => jsonRes(201, { 'o:id': 77, '@id': 'https://omeka.example.org/api/items/77' }));
    const client = new OmekaClient(settings, fetchImpl);
    const out = await client.createItem({ 'dcterms:title': [{ property_id: 1, type: 'literal', '@value': 'X' }] });
    assert.equal(out.id, 77);
    const call = fetchImpl.calls[0];
    const url = new URL(call.url);
    assert.equal(url.pathname, '/api/items');
    assert.equal(url.searchParams.get('key_identity'), 'id-123');
    assert.equal(url.searchParams.get('key_credential'), 'cred-456');
    assert.equal(call.init.method, 'POST');
    const sent = JSON.parse(call.init.body);
    assert.equal(sent['dcterms:title'][0]['property_id'], 1);
    assert.equal(sent['dcterms:title'][0]['@value'], 'X');
  });

  it('updateItem PUTs to the existing remote id (re-push updates, never duplicates)', async () => {
    const fetchImpl = mockFetch(() => jsonRes(200, { 'o:id': 77 }));
    const client = new OmekaClient(settings, fetchImpl);
    await client.updateItem(77, {});
    assert.equal(fetchImpl.calls[0].init.method, 'PUT');
    assert.equal(new URL(fetchImpl.calls[0].url).pathname, '/api/items/77');
  });

  it('getPropertyMap reads o:term/o:id pairs', async () => {
    const fetchImpl = mockFetch(() => jsonRes(200, [
      { 'o:id': 1, 'o:term': 'dcterms:title' },
      { 'o:id': 3, 'o:term': 'dcterms:description' },
    ]));
    const client = new OmekaClient(settings, fetchImpl);
    const map = await client.getPropertyMap();
    assert.equal(map.get('dcterms:title'), 1);
    assert.equal(map.get('dcterms:description'), 3);
  });

  it('createMediaForItem uses the url ingester against the item', async () => {
    const fetchImpl = mockFetch(() => jsonRes(201, { 'o:id': 900 }));
    const client = new OmekaClient(settings, fetchImpl);
    const id = await client.createMediaForItem(77, 'https://storage.example.org/presigned', 'photo.jpg', new Map([['dcterms:title', 1]]));
    assert.equal(id, 900);
    const sent = JSON.parse(fetchImpl.calls[0].init.body);
    assert.equal(sent['o:ingester'], 'url');
    assert.equal(sent['o:source'], 'https://storage.example.org/presigned');
    assert.equal(sent['o:item']['o:id'], 77);
  });

  it('errors map to OmekaError with status + verbatim body excerpt', async () => {
    const fetchImpl = mockFetch(() => new Response('Invalid key_credential for this site', { status: 403 }));
    const client = new OmekaClient(settings, fetchImpl);
    await assert.rejects(() => client.createItem({}), (err) => {
      assert.ok(err instanceof OmekaError);
      assert.equal(err.status, 403);
      assert.match(err.message, /Invalid key_credential/);
      return true;
    });
  });
});

// ---------------------------------------------------------------- credential crypto

describe('Omeka credential crypto (MASTER_KEY)', () => {
  const hexKey = 'ab'.repeat(32); // openssl rand -hex 32 shape

  it('round-trips under a hex MASTER_KEY and a passphrase MASTER_KEY', () => {
    const a = encryptSecret('cred-456', hexKey);
    assert.ok(a.startsWith('v1:'));
    assert.ok(!a.includes('cred-456'), 'ciphertext must not contain the plaintext');
    assert.equal(decryptSecret(a, hexKey), 'cred-456');
    const b = encryptSecret('s3cret', 'a passphrase value');
    assert.equal(decryptSecret(b, 'a passphrase value'), 's3cret');
  });

  it('wrong key and tampering fail loudly', () => {
    const a = encryptSecret('cred-456', hexKey);
    assert.throws(() => decryptSecret(a, 'cd'.repeat(32)));
    const tampered = a.slice(0, -2) + (a.endsWith('AA') ? 'BB' : 'AA');
    assert.throws(() => decryptSecret(tampered, hexKey));
  });

  it('missing MASTER_KEY refuses to encrypt (no plaintext fallback)', () => {
    assert.equal(hasMasterKey(''), false);
    assert.equal(hasMasterKey(undefined), false);
    assert.throws(() => encryptSecret('x', ''), MasterKeyMissingError);
    assert.throws(() => encryptSecret('x', null), MasterKeyMissingError);
  });
});

// ---------------------------------------------------------------- IIIF parser

describe('IIIF manifest parser (row 26)', () => {
  it('parses the v2 fixture: label, metadata, canvases in order, service normalized', () => {
    const m = parseIiifManifest(readJson('test/fixtures/iiif-v2.json'));
    assert.equal(m.version, 2);
    assert.equal(m.label, 'Field Notes 1892');
    assert.equal(m.description, 'A scanned field notebook.');
    assert.equal(m.metadata.length, 3);
    assert.equal(m.canvases.length, 2);
    assert.equal(m.canvases[0].label, 'Page 1');
    assert.equal(
      m.canvases[0].imageUrl,
      'https://iiif.example.org/iiif/image/book1-p1/full/max/0/default.jpg',
    );
    // No service on canvas 2: the resource URL is used as-is.
    assert.equal(m.canvases[1].imageUrl, 'https://iiif.example.org/images/book1/p2.jpg');
    assert.equal(m.canvases[1].serviceId, null);
  });

  it('parses the v3 fixture: language maps, summary, service array normalized', () => {
    const m = parseIiifManifest(readJson('test/fixtures/iiif-v3.json'));
    assert.equal(m.version, 3);
    assert.equal(m.label, 'Harbor Photographs');
    assert.equal(m.description, 'Album of harbor scenes.');
    assert.deepEqual(m.metadata[0], { label: 'Creator', value: 'B. Photographer' });
    assert.equal(m.canvases.length, 2);
    assert.equal(m.canvases[0].label, 'Harbor at dawn');
    assert.equal(
      m.canvases[0].imageUrl,
      'https://iiif.example.org/iiif3/image/album-c1/full/max/0/default.jpg',
    );
    assert.equal(m.canvases[1].imageUrl, 'https://iiif.example.org/iiif3/img/album-c2.jpg');
  });

  it('fullSizeImageUrl follows the Image API pattern', () => {
    assert.equal(fullSizeImageUrl('https://x.example.org/iiif/abc/'), 'https://x.example.org/iiif/abc/full/max/0/default.jpg');
  });

  it('rejects junk manifests honestly', () => {
    assert.throws(() => parseIiifManifest(null), IiifParseError);
    assert.throws(() => parseIiifManifest({ label: 'empty' }), IiifParseError);
  });

  it('harvest plan: one item per canvas, in order', () => {
    const plan = planHarvest(parseIiifManifest(readJson('test/fixtures/iiif-v2.json')));
    assert.equal(plan.length, 2);
    assert.equal(plan[0].title, 'Page 1');
    assert.equal(plan[1].title, 'Page 2');
    assert.equal(plan[0].filename, 'iiif-canvas-1.jpg');
  });

  it('metadata maps by label / local name / URI; unmapped pairs are preserved', () => {
    const m = parseIiifManifest(readJson('test/fixtures/iiif-v2.json'));
    const fields = [
      { property_uri: 'http://purl.org/dc/terms/creator', label: 'Creator' },
      { property_uri: 'http://purl.org/dc/terms/date', label: 'Date created' },
      { property_uri: 'http://purl.org/dc/terms/title', label: 'Title' },
      { property_uri: 'http://purl.org/dc/terms/description', label: 'Description' },
    ];
    const { values, unmapped } = mapManifestMetadata(m, 'Page 1', fields);
    const byUri = new Map(values.map((v) => [v.property_uri, v.text]));
    assert.equal(byUri.get('http://purl.org/dc/terms/creator'), 'A. Researcher'); // by label
    assert.equal(byUri.get('http://purl.org/dc/terms/date'), '1892'); // by local name
    assert.equal(byUri.get('http://purl.org/dc/terms/title'), 'Page 1'); // canvas title
    assert.equal(byUri.get('http://purl.org/dc/terms/description'), 'A scanned field notebook.');
    assert.deepEqual(unmapped, [{ label: 'Shelf Mark', value: 'MS-42' }]);
  });
});

// ---------------------------------------------------------------- SSRF guard + harvest fetch

describe('IIIF SSRF guard (fetch-guard)', () => {
  it('rejects http, loopback, link-local metadata, and private ranges', () => {
    for (const bad of [
      'http://iiif.example.org/manifest.json',
      'https://127.0.0.1/manifest.json',
      'https://127.5.6.7/x',
      'https://169.254.169.254/latest/meta-data/',
      'https://169.254.1.1/x',
      'https://10.0.0.5/x',
      'https://172.16.4.4/x',
      'https://192.168.1.10/x',
      'https://localhost/x',
      'https://[::1]/x',
      'https://user:pass@iiif.example.org/x',
    ]) {
      assert.throws(() => assertPublicHttpsUrl(bad), SsrfError, bad);
    }
  });

  it('accepts public https targets', () => {
    assert.equal(assertPublicHttpsUrl('https://iiif.example.org/m.json').hostname, 'iiif.example.org');
    assert.equal(assertPublicHttpsUrl('https://8.8.8.8/x').hostname, '8.8.8.8');
  });

  it('guarded fetch follows a public redirect but rejects a private one', async () => {
    const okFetch = async (url) => {
      if (url.includes('start')) return new Response(null, { status: 302, headers: { location: 'https://cdn.example.org/final.json' } });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const out = await guardedFetchBytes('https://iiif.example.org/start', { fetchImpl: okFetch });
    assert.equal(out.finalUrl, 'https://cdn.example.org/final.json');
    const evilFetch = async () => new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/' } });
    await assert.rejects(() => guardedFetchBytes('https://iiif.example.org/x', { fetchImpl: evilFetch }), SsrfError);
  });

  it('harvest mapping: manifest + image bytes flow through the guard with fetch mocked', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
    const manifest = readJson('test/fixtures/iiif-v3.json');
    const fetchImpl = async (url) => {
      if (String(url).endsWith('/default.jpg')) return new Response(jpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } });
      return new Response(JSON.stringify(manifest), { status: 200, headers: { 'content-type': 'application/ld+json' } });
    };
    const fetched = await guardedFetchBytes('https://iiif.example.org/iiif3/manifest/photo-album', { fetchImpl });
    const parsed = parseIiifManifest(JSON.parse(fetched.bytes.toString('utf8')));
    const plan = planHarvest(parsed);
    const img = await guardedFetchBytes(plan[0].imageUrl, { fetchImpl });
    assert.deepEqual([...img.bytes.subarray(0, 3)], [0xff, 0xd8, 0xff]);
    // An http image URL inside a (hostile) manifest is refused by the guard.
    await assert.rejects(
      () => guardedFetchBytes('http://iiif.example.org/img.jpg', { fetchImpl }),
      SsrfError,
    );
  });
});

// ---------------------------------------------------------------- developer tokens

describe('developer API tokens (row 36)', () => {
  it('lifecycle: issue -> verify -> wrong secret fails', () => {
    const gen = generateApiToken();
    assert.ok(looksLikeApiToken(gen.token));
    assert.ok(gen.token.startsWith('ezv_'));
    assert.equal(verifyApiToken(gen.token, gen.tokenHash), true);
    assert.equal(verifyApiToken(gen.token + 'x', gen.tokenHash), false);
    assert.equal(verifyApiToken('ezv_totally-different-secret-value', gen.tokenHash), false);
    assert.equal(verifyApiToken('not-a-token', gen.tokenHash), false);
  });

  it('hash at rest: the stored value is the SHA-256 of the secret, never the secret', () => {
    const gen = generateApiToken();
    const expected = createHash('sha256').update(gen.token, 'utf8').digest('hex');
    assert.equal(gen.tokenHash, expected);
    assert.notEqual(gen.tokenHash, gen.token);
    assert.ok(/^[0-9a-f]{64}$/.test(gen.tokenHash));
    assert.equal(hashApiToken(gen.token), gen.tokenHash);
    // The display prefix is a truncation of the token id portion only.
    assert.equal(gen.prefix, tokenDisplayPrefix(gen.token));
    assert.ok(gen.token.length > gen.prefix.length + 20);
  });

  it('scopes are minimal and enforced exactly', () => {
    assert.deepEqual(normalizeScopes(['read']), ['read']);
    assert.deepEqual(normalizeScopes(['notes:write', 'read', 'read']), ['notes:write', 'read']);
    assert.equal(normalizeScopes(['admin']), null);
    assert.equal(normalizeScopes([]), null);
    assert.equal(normalizeScopes('read'), null);
    // A read-only token cannot write notes; notes:write does not imply read.
    assert.equal(tokenHasScope(['read'], 'notes:write'), false);
    assert.equal(tokenHasScope(['notes:write'], 'read'), false);
    assert.equal(tokenHasScope(['read', 'notes:write'], 'notes:write'), true);
  });

  it('constant-time compare is the verification path (source invariant)', () => {
    const core = read('lib/token-core.ts');
    assert.match(core, /function digestsEqual/);
    assert.match(core, /diff \|= a\[i\] \^ b\[i\]/);
    assert.match(core, /verifyApiToken[\s\S]*digestsEqual\(/);
    const auth = read('lib/token-auth.ts');
    assert.match(auth, /token_hash = \$\{hashApiToken\(presented\)\}/);
    assert.match(auth, /revoked_at/);
    assert.match(auth, /has expired/);
    assert.match(auth, /last_used_at = now\(\)/);
  });

  it('subset wiring: documented routes enforce the right scopes', () => {
    const readRoutes = [
      'app/api/projects/route.ts',
      'app/api/projects/[id]/route.ts',
      'app/api/projects/[id]/items/route.ts',
      'app/api/projects/[id]/items/[itemId]/route.ts',
      'app/api/projects/[id]/items/[itemId]/photos/route.ts',
      'app/api/projects/[id]/photos/[photoId]/route.ts',
      'app/api/projects/[id]/notes/[noteId]/route.ts',
    ];
    for (const p of readRoutes) assert.match(read(p), /enforceTokenScope\(req, 'read'\)/, p);
    const notesLib = read('lib/api/notes.ts');
    assert.match(notesLib, /enforceTokenScope\(req, 'read'\)/);
    assert.match(notesLib, /enforceTokenScope\(req, 'notes:write'\)/);
    assert.match(read('app/api/projects/[id]/notes/[noteId]/route.ts'), /enforceTokenScope\(req, 'notes:write'\)/);
    // Token management is human-only.
    assert.match(read('app/api/api-tokens/route.ts'), /rejectTokenAuth\(req\)/);
    assert.match(read('app/api/api-tokens/[tokenId]/route.ts'), /rejectTokenAuth\(req\)/);
    // Creation stores the hash, returns the secret exactly once.
    const create = read('lib/token-auth.ts');
    assert.match(create, /token_hash/);
    assert.ok(!create.includes('VALUES (${name}, ${generated.token},'), 'plaintext must never be inserted');
  });
});

// ---------------------------------------------------------------- Wave D wiring

describe('Wave D wiring', () => {
  it('migration 0011 creates the three tables + job kinds, credential is ciphertext-only', () => {
    const mig = read('db/migrations/0011_wave_d.sql');
    assert.match(mig, /CREATE TABLE IF NOT EXISTS omeka_settings/);
    assert.match(mig, /credential_cipher/);
    assert.match(mig, /CREATE TABLE IF NOT EXISTS omeka_sync/);
    assert.match(mig, /CREATE TABLE IF NOT EXISTS api_tokens/);
    assert.match(mig, /token_hash\s+TEXT NOT NULL UNIQUE/);
    assert.match(mig, /'omeka','iiif'/);
    assert.ok(!/credential\s+TEXT/i.test(mig.replace('credential_cipher', '')), 'no plaintext credential column');
  });

  it('omeka routes + service exist; settings view never carries the credential', () => {
    for (const p of [
      'app/api/projects/[id]/omeka/settings/route.ts',
      'app/api/projects/[id]/omeka/push/route.ts',
      'app/api/projects/[id]/omeka/push-project/route.ts',
      'app/api/projects/[id]/import/iiif/route.ts',
    ]) {
      assert.ok(read(p).includes('handle('), p);
    }
    const service = read('lib/omeka/service.ts');
    assert.match(service, /encryptSecret\(input\.key_credential, master\)/);
    assert.match(service, /decryptSecret/);
    assert.match(service, /MASTER_KEY is not configured/);
    const types = read('lib/types.ts');
    const view = types.slice(types.indexOf('interface OmekaSettingsView'), types.indexOf('interface SaveOmekaSettingsRequest'));
    assert.ok(!/^\s*credential:/m.test(view) && !view.includes('key_credential'), 'settings view must not expose a credential value');
    assert.match(view, /has_credential/);
  });

  it('iiif import harvests through the standard pipeline (magic + staged + process)', () => {
    const imp = read('lib/iiif/import.ts');
    assert.match(imp, /guardedFetchBytes/);
    assert.match(imp, /detectFormat/);
    assert.match(imp, /keys\.upload\(jobId/);
    assert.match(imp, /createPhotoRows/);
    assert.match(imp, /processPhoto/);
    assert.match(imp, /'iiif','running'/);
  });

  it('UI: IIIF tab, Omeka settings + push, token settings all mounted', () => {
    const dialog = read('components/importer/ImportDialog.tsx');
    assert.match(dialog, /"iiif"/);
    assert.match(dialog, /import\/iiif/);
    const settings = read('components/settings/SettingsDialog.tsx');
    assert.match(settings, /omeka\/settings/);
    assert.match(settings, /omeka\/push-project/);
    assert.match(settings, /\/api\/api-tokens/);
    const inspector = read('components/inspector/Inspector.tsx');
    assert.match(inspector, /omeka\/push/);
  });
});

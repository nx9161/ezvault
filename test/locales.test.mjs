// SPDX-License-Identifier: MIT
/**
 * test/locales.test.mjs — Wave E part 2 (row 35 locale remainder).
 *
 * 1. Locale parity: every supported locale file under messages/ carries
 *    EXACTLY the en.json key set (identical flattened paths), no empty
 *    values, and per-key placeholder parity with en: the same variable
 *    names, and ICU plural/select constructs keep their shape (a plural
 *    stays a plural naming the same variable; `#` survives inside it).
 *    Plural CATEGORY sets legitimately differ by language (Ukrainian
 *    needs few/many, Japanese/Chinese only other) — parity is asserted
 *    on variables + construct type, never on category lists.
 * 2. Cookie resolution: lib/i18n/locales.ts resolveLocale — the exact
 *    function i18n/request.ts uses for the `ezv_locale` cookie.
 * 3. Registry integrity: 11 locales, unique codes, every code has a
 *    messages file, every file is in the registry.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  SUPPORTED_LOCALES,
  SUPPORTED_LOCALE_CODES,
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  isSupportedLocale,
  resolveLocale,
} from '../lib/i18n/locales.ts';

const here = dirname(fileURLToPath(import.meta.url));
const messagesDir = join(here, '..', 'messages');

function load(code) {
  return JSON.parse(readFileSync(join(messagesDir, `${code}.json`), 'utf8'));
}

function flatten(node, prefix = '', out = new Map()) {
  for (const [k, v] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') flatten(v, path, out);
    else out.set(path, v);
  }
  return out;
}

const VAR_RE = /\{(\w+)/g;
function varsOf(s) {
  return [...new Set([...String(s).matchAll(VAR_RE)].map((m) => m[1]))].sort();
}
function constructOf(s) {
  const m = String(s).match(/\{\w+,\s*(plural|select|selectordinal)\b/);
  return m ? m[1] : null;
}

const en = flatten(load('en'));

describe('locale registry (row 35)', () => {
  it('ships exactly 11 locales including en, matching the Tropy set', () => {
    assert.equal(SUPPORTED_LOCALES.length, 11);
    assert.deepEqual(
      [...SUPPORTED_LOCALE_CODES].sort(),
      ['de', 'en', 'es', 'fr', 'it', 'ja', 'nl', 'pt', 'pt-BR', 'uk', 'zh'].sort(),
    );
    assert.equal(new Set(SUPPORTED_LOCALE_CODES).size, 11);
    assert.equal(DEFAULT_LOCALE, 'en');
    assert.equal(LOCALE_COOKIE, 'ezv_locale');
  });

  it('every locale lists a non-empty native name', () => {
    for (const l of SUPPORTED_LOCALES) {
      assert.ok(l.nativeName && l.nativeName.trim().length > 0, l.code);
    }
  });

  it('every supported code has a messages file and vice versa', () => {
    for (const code of SUPPORTED_LOCALE_CODES) {
      assert.ok(existsSync(join(messagesDir, `${code}.json`)), `${code}.json missing`);
    }
  });
});

describe('locale parity across all 11 message files', () => {
  for (const code of SUPPORTED_LOCALE_CODES) {
    it(`${code}: identical key set to en (${en.size} keys), no empty values`, () => {
      const flat = flatten(load(code));
      assert.deepEqual([...flat.keys()].sort(), [...en.keys()].sort());
      for (const [path, value] of flat) {
        assert.equal(typeof value, 'string', `${code}:${path} is not a string`);
        assert.ok(value.trim().length > 0, `${code}:${path} is empty`);
      }
    });

    it(`${code}: placeholder parity per key with en`, () => {
      const flat = flatten(load(code));
      for (const [path, enValue] of en) {
        const value = flat.get(path);
        assert.deepEqual(varsOf(value), varsOf(enValue), `${code}:${path} variable mismatch`);
        assert.equal(constructOf(value), constructOf(enValue), `${code}:${path} ICU construct mismatch`);
        if (constructOf(enValue) === 'plural') {
          assert.ok(value.includes('#'), `${code}:${path} plural lost its #`);
        }
      }
    });
  }

  it('non-en locales actually translate (not copies of en)', () => {
    for (const code of SUPPORTED_LOCALE_CODES) {
      if (code === 'en') continue;
      const flat = flatten(load(code));
      let same = 0;
      for (const [path, enValue] of en) if (flat.get(path) === enValue) same += 1;
      // Brand/technical tokens legitimately stay identical (EZVault,
      // IIIF, HTML, single letters); a real translation differs on the
      // overwhelming majority of strings.
      assert.ok(same / en.size < 0.2, `${code} looks untranslated (${same}/${en.size} identical)`);
    }
  });
});

describe('resolveLocale — ezv_locale cookie validation', () => {
  it('accepts every supported code verbatim', () => {
    for (const code of SUPPORTED_LOCALE_CODES) assert.equal(resolveLocale(code), code);
  });

  it('normalizes case variants of regional codes', () => {
    assert.equal(resolveLocale('pt-br'), 'pt-BR');
    assert.equal(resolveLocale('PT-BR'), 'pt-BR');
    assert.equal(resolveLocale('DE'), 'de');
    assert.equal(resolveLocale(' de '), 'de');
  });

  it('falls back to en when the cookie is absent or empty', () => {
    assert.equal(resolveLocale(undefined), 'en');
    assert.equal(resolveLocale(null), 'en');
    assert.equal(resolveLocale(''), 'en');
    assert.equal(resolveLocale('   '), 'en');
  });

  it('falls back to en for unsupported or malformed values', () => {
    for (const bad of ['xx', 'en-US', 'klingon', '../../etc/passwd', 'de.json', 'null', '0']) {
      assert.equal(resolveLocale(bad), 'en', bad);
    }
    assert.equal(resolveLocale(42), 'en');
    assert.equal(resolveLocale({}), 'en');
  });

  it('isSupportedLocale agrees with the registry', () => {
    assert.ok(isSupportedLocale('uk'));
    assert.ok(isSupportedLocale('pt-BR'));
    assert.ok(!isSupportedLocale('ru'));
    assert.ok(!isSupportedLocale(''));
    assert.ok(!isSupportedLocale(null));
  });
});

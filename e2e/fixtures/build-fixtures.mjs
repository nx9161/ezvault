// SPDX-License-Identifier: MIT
// e2e/fixtures/build-fixtures.mjs — builds committed synthetic .tpy fixtures
// for the Playwright E2E suite (W2-C). NEVER the owner's real 48-item file.
// Uses sql.js + sharp from the repo's node_modules (dev-time only).
//
// Output (committed):
//   e2e/fixtures/standard.tpy          — 3 items / 4 photos / 1 selection /
//                                        2 notes / 3 metadata rows / 2 tags / 1 list
//   e2e/fixtures/standard-assets.zip   — DEFLATE zip of the 4 photo bytes
//   e2e/fixtures/advanced.tpy          — 2 items / 3 photos, originals missing
//                                        (paths point at another machine)
//   e2e/fixtures/advanced-originals/   — the real bytes for the re-link step
//
// The .tpy files carry application_id = -621960955 and
// user_version = 2112312400 (the pinned Tropy versions the analyzer expects).

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import initSqlJs from "sql.js";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)));

const TPY_APPLICATION_ID = -621960955;
const TPY_USER_VERSION = 2112312400;

async function png(w, h, r, g, b) {
  return sharp({
    create: { width: w, height: h, channels: 3, background: { r, g, b } },
  })
    .png()
    .toBuffer();
}

const md5 = (buf) => createHash("md5").update(buf).digest("hex");

/** Minimal DEFLATE zip writer (node built-ins only). */
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    crc32.table = table;
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function zipFiles(entries) {
  // entries: [{ name: string, data: Buffer }]
  const chunks = [];
  const central = [];
  let offset = 0;
  const dosTime = (14 << 11) | (30 << 5) | 15; // 14:30:30
  const dosDate = ((2026 - 1980) << 9) | (10 << 5) | 15;
  for (const { name, data } of entries) {
    const deflated = deflateRawSync(data);
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, deflated);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(dosTime, 12);
    cd.writeUInt16LE(dosDate, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(deflated.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + deflated.length;
  }
  const cdStart = offset;
  const cdSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(cdStart, 16);
  return Buffer.concat([...chunks, ...central, end]);
}

function buildDb(build) {
  return (async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.exec(`PRAGMA application_id = ${TPY_APPLICATION_ID};`);
    db.exec(`PRAGMA user_version = ${TPY_USER_VERSION};`);
    for (const ddl of [
      `CREATE TABLE subjects (id INTEGER PRIMARY KEY, template TEXT, type TEXT, created TEXT, modified TEXT)`,
      `CREATE TABLE items (id INTEGER PRIMARY KEY, cover_image_id INTEGER, created TEXT, modified TEXT)`,
      `CREATE TABLE photos (id INTEGER PRIMARY KEY, item_id INTEGER, position INTEGER, path TEXT, protocol TEXT, mimetype TEXT, checksum TEXT, orientation INTEGER, metadata TEXT, size INTEGER, page INTEGER, color INTEGER, density REAL, filename TEXT, created TEXT, modified TEXT)`,
      `CREATE TABLE images (id INTEGER PRIMARY KEY, width INTEGER, height INTEGER, angle INTEGER, mirror INTEGER, brightness REAL, contrast REAL, hue REAL, saturation REAL, negative INTEGER, sharpen REAL)`,
      `CREATE TABLE selections (id INTEGER PRIMARY KEY, photo_id INTEGER, x REAL, y REAL, position INTEGER, created TEXT, modified TEXT)`,
      `CREATE TABLE notes (note_id INTEGER PRIMARY KEY, id INTEGER, text TEXT, state TEXT, language TEXT, created TEXT, modified TEXT, deleted INTEGER)`,
      `CREATE TABLE tags (tag_id INTEGER PRIMARY KEY, name TEXT, color TEXT, created TEXT, modified TEXT)`,
      `CREATE TABLE taggings (tag_id INTEGER, id INTEGER, created TEXT)`,
      `CREATE TABLE lists (list_id INTEGER PRIMARY KEY, name TEXT, parent_list_id INTEGER, position INTEGER, created TEXT, modified TEXT)`,
      `CREATE TABLE list_items (list_id INTEGER, id INTEGER, position INTEGER, added TEXT, deleted INTEGER)`,
      `CREATE TABLE metadata (id INTEGER, property TEXT, value_id INTEGER, language TEXT, created TEXT)`,
      `CREATE TABLE metadata_values (value_id INTEGER PRIMARY KEY, datatype TEXT, text TEXT, data TEXT)`,
    ]) db.exec(ddl);
    build(db);
    const out = Buffer.from(db.export());
    db.close();
    return out;
  })();
}

function q(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

// ---------------------------------------------------------------- standard
async function buildStandard() {
  const colors = [[178, 84, 30], [46, 111, 64], [42, 92, 140], [120, 60, 120]];
  const imgs = [];
  for (let i = 0; i < 4; i++) imgs.push(await png(64, 48, ...colors[i]));

  const db = await buildDb((db) => {
    const now = "2026-10-01T10:00:00";
    for (const id of [1, 2, 3]) {
      db.exec(`INSERT INTO subjects VALUES (${id}, 'https://tropy.org/v1/templates/item', 'item', ${q(now)}, ${q(now)})`);
      db.exec(`INSERT INTO items VALUES (${id}, NULL, ${q(now)}, ${q(now)})`);
    }
    const photos = [
      [11, 1, "photos/std-a.png", "std-a.png"],
      [12, 1, "photos/std-b.png", "std-b.png"],
      [13, 2, "photos/std-c.png", "std-c.png"],
      [14, 3, "photos/std-d.png", "std-d.png"],
    ];
    for (const [pid, item, path, filename] of photos) {
      db.exec(`INSERT INTO subjects VALUES (${pid}, 'https://tropy.org/v1/templates/photo', 'photo', ${q(now)}, ${q(now)})`);
      db.exec(`INSERT INTO photos VALUES (${pid}, ${item}, 0, ${q(path)}, 'file', 'image/png', ${q(md5(imgs[pid - 11]))}, 1, '{}', ${imgs[pid - 11].length}, 0, 1, NULL, ${q(filename)}, ${q(now)}, ${q(now)})`);
      db.exec(`INSERT INTO images VALUES (${pid}, 64, 48, 0, 0, 0, 0, 0, 0, 0, 0)`);
    }
    // one selection on photo 11 (its own images row carries w/h)
    db.exec(`INSERT INTO subjects VALUES (21, '', 'selection', ${q(now)}, ${q(now)})`);
    db.exec(`INSERT INTO selections VALUES (21, 11, 5, 5, 0, ${q(now)}, ${q(now)})`);
    db.exec(`INSERT INTO images VALUES (21, 20, 15, 0, 0, 0, 0, 0, 0, 0, 0)`);
    // notes with dates
    db.exec(`INSERT INTO notes VALUES (101, 11, 'Standard fixture note on photo A.', '', 'en', '2026-10-02T09:00:00', '2026-10-02T09:00:00', NULL)`);
    db.exec(`INSERT INTO notes VALUES (102, 1, 'Item-level note.', '', 'en', '2026-10-03T09:00:00', '2026-10-03T09:00:00', NULL)`);
    // metadata with a language tag
    db.exec(`INSERT INTO metadata_values VALUES (201, 'http://www.w3.org/2001/XMLSchema#string', 'Standard Fixture Item', NULL)`);
    db.exec(`INSERT INTO metadata VALUES (1, 'http://purl.org/dc/terms/title', 201, 'en', ${q(now)})`);
    db.exec(`INSERT INTO metadata_values VALUES (202, 'http://www.w3.org/2001/XMLSchema#string', '2026-09-15', NULL)`);
    db.exec(`INSERT INTO metadata VALUES (11, 'http://purl.org/dc/terms/date', 202, NULL, ${q(now)})`);
    db.exec(`INSERT INTO metadata_values VALUES (203, 'http://www.w3.org/2001/XMLSchema#string', 'Fixture Archive', NULL)`);
    db.exec(`INSERT INTO metadata VALUES (1, 'http://purl.org/dc/terms/source', 203, 'en', ${q(now)})`);
    // tags
    db.exec(`INSERT INTO tags VALUES (301, 'fixture', '#B3541E', ${q(now)}, ${q(now)})`);
    db.exec(`INSERT INTO tags VALUES (302, 'standard', NULL, ${q(now)}, ${q(now)})`);
    db.exec(`INSERT INTO taggings VALUES (301, 1, ${q(now)})`);
    db.exec(`INSERT INTO taggings VALUES (301, 11, ${q(now)})`);
    db.exec(`INSERT INTO taggings VALUES (302, 2, ${q(now)})`);
    // list
    db.exec(`INSERT INTO lists VALUES (401, 'Fixture List', NULL, 0, ${q(now)}, ${q(now)})`);
    db.exec(`INSERT INTO list_items VALUES (401, 1, 0, ${q(now)}, NULL)`);
    db.exec(`INSERT INTO list_items VALUES (401, 2, 1, ${q(now)}, NULL)`);
  });
  writeFileSync(join(root, "standard.tpy"), db);
  const zip = zipFiles(imgs.map((data, i) => ({ name: `std-${"abcd"[i]}.png`, data })));
  writeFileSync(join(root, "standard-assets.zip"), zip);
  console.log("standard.tpy", db.length, "bytes;", "standard-assets.zip", zip.length, "bytes");
}

// ---------------------------------------------------------------- advanced
async function buildAdvanced() {
  const colors = [[30, 90, 140], [140, 90, 30], [60, 140, 90]];
  const imgs = [];
  for (let i = 0; i < 3; i++) imgs.push(await png(80, 60, ...colors[i]));
  mkdirSync(join(root, "advanced-originals"), { recursive: true });
  const names = ["adv-a.png", "adv-b.png", "adv-c.png"];
  imgs.forEach((data, i) => writeFileSync(join(root, "advanced-originals", names[i]), data));

  const db = await buildDb((db) => {
    const now = "2026-10-01T11:00:00";
    for (const id of [1, 2]) {
      db.exec(`INSERT INTO subjects VALUES (${id}, 'https://tropy.org/v1/templates/item', 'item', ${q(now)}, ${q(now)})`);
      db.exec(`INSERT INTO items VALUES (${id}, NULL, ${q(now)}, ${q(now)})`);
    }
    const photos = [
      [11, 1, "/Volumes/ARCHIVE/photos/adv-a.png", "adv-a.png"],
      [12, 1, "/Volumes/ARCHIVE/photos/adv-b.png", "adv-b.png"],
      [13, 2, "/Volumes/ARCHIVE/photos/adv-c.png", "adv-c.png"],
    ];
    for (const [pid, item, path, filename] of photos) {
      db.exec(`INSERT INTO subjects VALUES (${pid}, 'https://tropy.org/v1/templates/photo', 'photo', ${q(now)}, ${q(now)})`);
      // checksum = real md5 of the committed original bytes (honest fixture)
      db.exec(`INSERT INTO photos VALUES (${pid}, ${item}, 0, ${q(path)}, 'file', 'image/png', ${q(md5(imgs[pid - 11]))}, 1, '{}', ${imgs[pid - 11].length}, 0, 1, NULL, ${q(filename)}, ${q(now)}, ${q(now)})`);
      db.exec(`INSERT INTO images VALUES (${pid}, 80, 60, 0, 0, 0, 0, 0, 0, 0, 0)`);
    }
    db.exec(`INSERT INTO notes VALUES (101, 11, 'Advanced fixture note.', '', 'en', '2026-10-04T09:00:00', '2026-10-04T09:00:00', NULL)`);
    db.exec(`INSERT INTO metadata_values VALUES (201, 'http://www.w3.org/2001/XMLSchema#string', 'Advanced Fixture Item', NULL)`);
    db.exec(`INSERT INTO metadata VALUES (1, 'http://purl.org/dc/terms/title', 201, 'en', ${q(now)})`);
    db.exec(`INSERT INTO metadata_values VALUES (202, 'http://www.w3.org/2001/XMLSchema#string', '2026-09-20', NULL)`);
    db.exec(`INSERT INTO metadata VALUES (12, 'http://purl.org/dc/terms/date', 202, NULL, ${q(now)})`);
    db.exec(`INSERT INTO tags VALUES (301, 'fixture', '#2E6F40', ${q(now)}, ${q(now)})`);
    db.exec(`INSERT INTO taggings VALUES (301, 1, ${q(now)})`);
  });
  writeFileSync(join(root, "advanced.tpy"), db);
  console.log("advanced.tpy", db.length, "bytes; advanced-originals/ committed");
}

await buildStandard();
await buildAdvanced();
console.log("fixtures built in", root);

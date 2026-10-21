// SPDX-License-Identifier: MIT
// Regression: hooks-layer wire adapters (lib/api/types.ts). The class of
// bug behind the useLists "{ lists }" crash — hooks typed against a shape
// the routes don't send, with the raw fetcher passing the payload through.
//
// - adaptHealth: GET /api/health answers NESTED checks
//   ({ status, checks: { neon: {status}, storage: {status, detail}, … } }),
//   but HealthResponse is flattened (neon / r2 / queue / codecs). Unadapted,
//   StatusBar read health.neon / health.r2 off the wrong level — both
//   undefined — and showed the Database + Storage chips permanently red
//   ("Something needs attention") on a fully healthy backend.
// - adaptProject: projects.rev is BIGINT → a string on the wire; the
//   declared Project type promises a number. default_density (migration
//   0008) is absent from the wire on databases without that column.
// - adaptNote: notes have no project_id column and the list routes omit
//   it, but NoteDoc promises it; the hook stamps the id it knows.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { adaptHealth, adaptNote, adaptProject } from "../lib/api/types.ts";

// The exact body production returned while healthy (2026-10-21).
const HEALTHY_WIRE = {
  status: "ok",
  checks: {
    neon: { status: "ok" },
    storage: { status: "ok", detail: "r2" },
    queue: { status: "ok", detail: "0 jobs" },
    codecs: {
      status: "ok",
      detail:
        "sharp/libvips:ok,sql.js:ok,jsonld:ok,pdf-render (pdf.js+canvas):ok,jp2-decode (openjpeg wasm):ok",
    },
  },
};

describe("adaptHealth", () => {
  it("maps a healthy payload to all-ok flattened fields", () => {
    const h = adaptHealth(HEALTHY_WIRE);
    assert.equal(h.neon, "ok");
    assert.equal(h.r2, "ok");
    assert.deepEqual(h.queue, { queued: 0, running: 0, failed: 0 });
    assert.deepEqual(h.codecs, {
      "sharp/libvips": true,
      "sql.js": true,
      jsonld: true,
      "pdf-render (pdf.js+canvas)": true,
      "jp2-decode (openjpeg wasm)": true,
    });
  });

  it("surfaces a failed check as non-ok on exactly that field", () => {
    const h = adaptHealth({
      status: "error",
      checks: {
        neon: { status: "ok" },
        storage: { status: "error", detail: "r2 unreachable" },
        queue: { status: "ok", detail: "3 jobs" },
        codecs: { status: "error", detail: "sharp/libvips:ok,sql.js:error" },
      },
    });
    assert.equal(h.neon, "ok");
    assert.equal(h.r2, "error");
    assert.equal(h.queue.queued, 3);
    assert.deepEqual(h.codecs, { "sharp/libvips": true, "sql.js": false });
  });

  it("treats a missing storage check as 'unconfigured', missing neon as error", () => {
    const h = adaptHealth({ status: "ok", checks: {} });
    assert.equal(h.r2, "unconfigured");
    assert.equal(h.neon, "error");
    assert.deepEqual(h.queue, { queued: 0, running: 0, failed: 0 });
    assert.deepEqual(h.codecs, {});
  });
});

describe("adaptProject", () => {
  it("coerces the BIGINT rev string to a number and defaults density", () => {
    const p = adaptProject({
      id: "f302c7be-3d7b-4894-873d-6dcf9a38b826",
      name: "Naman",
      rev: "0",
      default_template_id: null,
      duplicate_policy: "skip",
      notes_export_format: "html",
      created_at: "2026-10-21T15:49:35.831Z",
      updated_at: "2026-10-21T15:49:35.831Z",
    });
    assert.equal(p.rev, 0);
    assert.equal(typeof p.rev, "number");
    assert.equal(p.default_density, 300);
  });

  it("keeps a numeric rev and an explicit density", () => {
    const p = adaptProject({
      id: "x",
      name: "P",
      rev: 7,
      default_density: 150,
      default_template_id: null,
      duplicate_policy: "skip",
      notes_export_format: "html",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    assert.equal(p.rev, 7);
    assert.equal(p.default_density, 150);
  });
});

describe("adaptNote", () => {
  it("stamps the project_id the wire omits", () => {
    const n = adaptNote(
      {
        id: "n1",
        subject_id: "s1",
        project_id: undefined,
        text: "hello",
        state: { type: "doc", content: [] },
        language: null,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
      "proj-9",
    );
    assert.equal(n.project_id, "proj-9");
    assert.equal(n.text, "hello");
  });
});

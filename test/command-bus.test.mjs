// SPDX-License-Identifier: MIT
// Regression: the workspace crash of 2026-10-21 (React #185, "Maximum
// update depth exceeded"). lib/commands/bus.ts fed useSyncExternalStore
// an UNcached snapshot (new object per call) and invoked the listener
// synchronously inside subscribe() — together an infinite render loop
// in StatusBar, the only useCommandBus consumer, which lives only in
// the workspace tree (home page unaffected). These tests pin the
// external-store contract the hook relies on.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { commandBus } from "../lib/commands/bus.ts";

describe("command bus external-store contract", () => {
  it("snapshot() is referentially stable between mutations", () => {
    const a = commandBus.snapshot();
    const b = commandBus.snapshot();
    assert.equal(a, b, "getSnapshot must return the cached object (React #185 guard)");
  });

  it("subscribe() does NOT invoke the listener synchronously", () => {
    let calls = 0;
    const off = commandBus.subscribe(() => {
      calls += 1;
    });
    assert.equal(calls, 0, "listener must not fire during subscribe (forceStoreRerender loop)");
    off();
  });

  it("a mutation publishes a NEW snapshot object and notifies listeners", async () => {
    const before = commandBus.snapshot();
    const seen = [];
    const off = commandBus.subscribe((s) => seen.push(s));
    await commandBus.execute({
      id: "test-op-1",
      label: "Test command",
      scope: "test",
      do: () => {},
      undo: () => {},
      at: Date.now(),
    });
    const after = commandBus.snapshot();
    assert.notEqual(after, before, "snapshot must change identity after a mutation");
    assert.equal(after.undoDepth, before.undoDepth + 1);
    assert.equal(after.undoLabel, "Test command");
    assert.ok(seen.length >= 1, "listener notified on emit");
    assert.equal(seen[seen.length - 1], after, "listener receives the cached snapshot");
    off();
    commandBus.clear();
    assert.equal(commandBus.snapshot().undoDepth, 0);
  });
});

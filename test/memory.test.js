import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readMemory, signatureOf, writeMemory } from "../src/notify/memory.js";

test("the signature changes exactly when the list of slots changes", () => {
  const days = [{ date: "2026-11-20", slots: [{ time: "20:45" }, { time: "23:00" }] }, { date: "2026-11-21", slots: [{ time: "00:30" }] }];
  assert.equal(signatureOf(days), "2026-11-20 20:45,23:00|2026-11-21 00:30");
  assert.equal(signatureOf([]), "");
  assert.notEqual(signatureOf(days), signatureOf([days[0]]));
});

test("memory survives a round trip, forgets rooms that left the watchlist, and tolerates a missing or damaged file", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-"));
  try {
    assert.deepEqual(await readMemory(dir), {});
    await writeMemory(dir, { a: "2026-11-20 20:45", gone: "x" }, ["a", "b"]);
    assert.deepEqual(await readMemory(dir), { a: "2026-11-20 20:45" });

    await fs.writeFile(path.join(dir, "notified.json"), "[1,2");
    assert.deepEqual(await readMemory(dir), {});
    await fs.writeFile(path.join(dir, "notified.json"), JSON.stringify({ a: "ok", b: 5, c: null }));
    assert.deepEqual(await readMemory(dir), { a: "ok" });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

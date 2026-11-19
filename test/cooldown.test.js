import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { athensClock, cooldownMessage, readCooldown, recordRefusal } from "../src/cooldown.js";

async function withStateDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cooldown-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const at = new Date("2026-11-19T09:07:58Z");
const minutesLater = (minutes) => new Date(at.getTime() + minutes * 60_000);

test("no recorded refusal means no cool-down", () =>
  withStateDir(async (dir) => {
    assert.deepEqual(await readCooldown(dir, 60), { active: false, until: null, refusal: null });
    assert.deepEqual(await readCooldown(path.join(dir, "missing"), 60), { active: false, until: null, refusal: null });
  }));

test("a refusal blocks contact for the cool-down and then expires by itself", () =>
  withStateDir(async (dir) => {
    await recordRefusal(dir, { detail: "room page: HTTP 403", room: "Jack Outside the Box" }, at);

    const during = await readCooldown(dir, 60, minutesLater(59));
    assert.equal(during.active, true);
    assert.equal(during.until.toISOString(), "2026-11-19T10:07:58.000Z");
    assert.equal(
      cooldownMessage(during),
      "The site refused us at 11:07 (room page: HTTP 403). Not contacting it again before 12:07 Athens time.",
    );

    assert.equal((await readCooldown(dir, 60, minutesLater(61))).active, false);
  }));

test("a longer Retry-After from the site extends the cool-down", () =>
  withStateDir(async (dir) => {
    await recordRefusal(dir, { detail: "room page: HTTP 429", retryAfterSeconds: 3 * 3600 }, at);
    assert.equal((await readCooldown(dir, 60, minutesLater(170))).active, true);
    assert.equal((await readCooldown(dir, 60, minutesLater(181))).active, false);
  }));

test("a damaged state file does not lock the watcher out", () =>
  withStateDir(async (dir) => {
    await fs.writeFile(path.join(dir, "last-refusal.json"), "{not json");
    assert.equal((await readCooldown(dir, 60)).active, false);
    await fs.writeFile(path.join(dir, "last-refusal.json"), JSON.stringify({ at: "yesterday-ish" }));
    assert.equal((await readCooldown(dir, 60)).active, false);
  }));

test("athensClock shows Athens time", () => {
  assert.equal(athensClock(new Date("2026-11-19T09:07:58Z")), "11:07");
  assert.equal(athensClock(new Date("2026-07-01T21:30:00Z")), "00:30");
});

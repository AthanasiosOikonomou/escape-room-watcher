import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import { ConfigError, loadConfig } from "../src/config.js";
import { roomSlug, validateWatchlist } from "../src/watchlist.js";
import { dayLabel, escapeHtml, formatRoomMessage } from "../src/notify/telegram.js";
import { addDays, athensDate, isoFromDayMonthYear } from "../src/dates.js";

test("config defaults", () => {
  const config = loadConfig({});
  assert.equal(config.pauseBetweenRoomsMs, 8000);
  assert.equal(config.pauseRandomExtraMs, 4000);
  assert.equal(config.refusalCooldownMinutes, 60);
  assert.equal(config.watchlistFile, "watchlist.json");
  assert.equal(config.notifyMode, "on-change");
  assert.equal(config.stateDir, ".state");
  assert.equal(config.telegramToken, null);
});

test("config reads overrides and rejects nonsense", () => {
  assert.equal(loadConfig({ PAUSE_BETWEEN_ROOMS_MS: "20000" }).pauseBetweenRoomsMs, 20000);
  assert.equal(loadConfig({ NOTIFY_MODE: "always" }).notifyMode, "always");
  assert.throws(() => loadConfig({ NOTIFY_MODE: "sometimes" }), ConfigError);
  assert.throws(() => loadConfig({ PAUSE_BETWEEN_ROOMS_MS: "soon" }), ConfigError);
  // Neither the pause between rooms nor the cool-down can be configured away.
  assert.throws(() => loadConfig({ PAUSE_BETWEEN_ROOMS_MS: "0" }), ConfigError);
  assert.throws(() => loadConfig({ REFUSAL_COOLDOWN_MINUTES: "0" }), ConfigError);
});

const ANTIQUE = "https://www.escapeall.gr/en/EscapeRoom/Details/antique";
const list = (...rooms) => ({ version: 1, rooms });

test("the watchlist in the repository is valid", async () => {
  const watchlist = validateWatchlist(JSON.parse(await fs.readFile("watchlist.json", "utf8")));
  assert.ok(watchlist.rooms.length > 0);
  assert.equal(roomSlug(watchlist.rooms.find((room) => room.name === "Antique")), "antique");
});

test("a watchlist entry is normalised: trimmed name, bare room URL, defaults filled in", () => {
  const { rooms } = validateWatchlist(list({ name: "  Antique ", url: `${ANTIQUE}?utm=x#reviews` }));
  assert.deepEqual(rooms, [{ name: "Antique", url: ANTIQUE, paused: false, rules: [] }]);

  const full = { name: "S", url: "https://www.escapeall.gr/el/EscapeRoom/Details/the-sculptor", paused: true, rules: [{ days: ["fri"], from: "19:00", to: "22:00" }] };
  assert.deepEqual(validateWatchlist(list(full)).rooms, [full]);
  assert.deepEqual(validateWatchlist(list()).rooms, []); // an empty watchlist is fine
});

test("the watchlist accepts only EscapeAll room pages over https, each room once", () => {
  const bad = (room, pattern) => assert.throws(() => validateWatchlist(list(room)), pattern ?? ConfigError);
  bad({ name: "x", url: "http://www.escapeall.gr/en/EscapeRoom/Details/antique" });
  bad({ name: "x", url: "https://www.escapeall.gr.evil.example/en/EscapeRoom/Details/antique" });
  bad({ name: "x", url: "https://user:pw@www.escapeall.gr/en/EscapeRoom/Details/antique" });
  bad({ name: "x", url: "https://www.escapeall.gr:8443/en/EscapeRoom/Details/antique" });
  bad({ name: "x", url: "https://www.escapeall.gr/en/Account/Login" });
  bad({ name: "x", url: "file:///etc/passwd" });
  bad({ name: "", url: ANTIQUE });
  bad({ name: "n".repeat(81), url: ANTIQUE });
  bad({ url: ANTIQUE });
  bad({ name: "x", url: ANTIQUE, paused: "yes" });
  bad({ name: "x", url: ANTIQUE, rules: [{ days: ["someday"] }] }, /rule 1: "days" must be a list/);
  bad({ name: "x", url: ANTIQUE, rules: [{ from: "22:00", to: "19:00" }] }, /"from" \(22:00\) is after "to" \(19:00\)/);
  bad({ name: "x", url: ANTIQUE, rules: Array.from({ length: 11 }, () => ({})) });

  // The same room in English and in Greek is still the same room.
  assert.throws(
    () => validateWatchlist(list({ name: "A", url: ANTIQUE }, { name: "B", url: ANTIQUE.replace("/en/", "/el/") })),
    /listed twice/,
  );
  assert.throws(() => validateWatchlist([{ name: "old format", url: ANTIQUE }]), ConfigError);
  assert.throws(() => validateWatchlist({ version: 2, rooms: [] }), ConfigError);
  assert.throws(() => validateWatchlist(list(...Array.from({ length: 41 }, (_, i) => ({ name: `r${i}`, url: `${ANTIQUE}-${i}` })))), /limit is 40/);
});

test("messages escape HTML and label days with their weekday", () => {
  assert.equal(escapeHtml(`<b>&"`), `&lt;b&gt;&amp;&quot;`);
  assert.equal(dayLabel("2026-11-19"), "Thu 19/11/2026");
  assert.equal(dayLabel("2027-01-03"), "Sun 03/01/2027");
  assert.equal(isoFromDayMonthYear("19/11/2026"), "2026-11-19");
  assert.equal(isoFromDayMonthYear("2026-11-19"), null);
  assert.equal(athensDate(new Date("2026-11-19T22:30:00Z")), "2026-11-20");
  assert.equal(addDays("2026-12-25", 14), "2027-01-08");
  assert.equal(
    formatRoomMessage({ name: "Tom & Jerry" }, [
      { date: "2026-11-19", slots: [{ time: "19:00" }, { time: "21:15" }] },
      { date: "2026-11-21", slots: [{ time: "00:30" }] },
    ]),
    "🏠 <b>Tom &amp; Jerry</b>\n\nAvailable slots:\n\n<b>Thu 19/11/2026</b>: 19:00, 21:15\n<b>Sat 21/11/2026</b>: 00:30",
  );
  // With a URL the name is a link to the room; with rules they are shown under it.
  assert.equal(
    formatRoomMessage(
      { name: "Antique", url: "https://www.escapeall.gr/en/EscapeRoom/Details/antique", rules: [{ days: ["sat", "fri"], from: "19:00", to: "22:00" }, { days: ["sun"] }] },
      [{ date: "2026-11-20", slots: [{ time: "20:45" }] }],
    ),
    '🏠 <a href="https://www.escapeall.gr/en/EscapeRoom/Details/antique"><b>Antique</b></a>\n<i>Fri, Sat 19:00–22:00; Sun</i>\n\nAvailable slots:\n\n<b>Fri 20/11/2026</b>: 20:45',
  );
});

test("an overlong message is cut at a day boundary", () => {
  const days = Array.from({ length: 400 }, (_, i) => ({
    date: `2026-11-${String((i % 28) + 1).padStart(2, "0")}`,
    slots: [{ time: "19:00" }, { time: "21:15" }],
  }));
  const text = formatRoomMessage({ name: "Long" }, days);
  assert.ok(text.length <= 4002);
  assert.ok(text.endsWith("\n…"));
});

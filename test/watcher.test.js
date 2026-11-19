import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { loadConfig } from "../src/config.js";
import { addDays } from "../src/dates.js";
import { createTelegram } from "../src/notify/telegram.js";
import { SiteRefusal } from "../src/site/refusal.js";
import { startMockSite } from "./helpers/mock-site.js";

// The room check reads its timings when it is first imported: make it quick for the mock site.
Object.assign(process.env, {
  STAGGER_MS: "0",
  MIN_DELAY_BETWEEN_ROOMS_MS: "0",
  RANDOM_EXTRA_DELAY_MS: "0",
  DAY_CHECK_BASE_MS: "0",
  DAY_CHECK_JITTER_MS: "0",
  TIME_LIST_WAIT_MS: "300",
  GLOBAL_MIN_REQUEST_INTERVAL_MS: "0",
});
const { daysFromAvailability, exitCodeFor, Outcome, runWatch } = await import("../src/watcher.js");

const run = promisify(execFile);
const TOKEN = ["123456", "test-token"].join(":");

// The room check works in the machine's own calendar day.
const now = new Date();
const TODAY = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
const label = (iso) => iso.split("-").reverse().join("/");

let site;
let bot;

/** A stand-in for api.telegram.org that records what it is sent. */
async function startMockTelegram() {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received.push({ path: req.url, body: JSON.parse(body) });
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    received,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

before(async () => {
  site = await startMockSite({ today: TODAY });
  bot = await startMockTelegram();
});

after(async () => {
  await site?.close();
  await bot?.close();
});

/** Requests the room pages caused, without the favicon and the shared stylesheet. */
const pageCalls = () => site.requests.filter((request) => !/favicon|\/Content\//.test(request));
const room = (name, slug) => ({ name, url: `${site.origin}/en/EscapeRoom/Details/${slug}` });
const config = loadConfig({});
const noSleep = async () => {};

function watch(rooms, extra = {}) {
  const lines = [];
  const telegram = createTelegram({ token: TOKEN, chatId: "42", apiBase: bot.origin, log: (line) => lines.push(line) });
  return runWatch({ rooms, config, telegram, log: (line) => lines.push(line), sleep: noSleep, ...extra }).then((report) => ({
    report,
    lines,
  }));
}

test("the original room check, run against the mock site: free slots, nothing free, removed", async () => {
  bot.received.length = 0;
  site.requests.length = 0;
  site.userAgents.length = 0;

  const { report } = await watch([room("Antique <VIP>", "antique"), room("Scream", "coming-soon"), room("Alien", "gone")]);

  assert.deepEqual(report.results.map((r) => r.outcome), [Outcome.OK, Outcome.OK, Outcome.REMOVED]);
  assert.deepEqual(
    report.results[0].days.map((day) => [day.date, day.slots.map((slot) => slot.time)]),
    [
      [TODAY, ["19:00", "21:15"]], // today is already selected on load and must not be dropped as stale
      [addDays(TODAY, 2), ["00:30"]],
    ],
  );
  assert.deepEqual(report.results[1].days, []);
  assert.match(report.results[2].detail, /\/en \(HTTP 200\)$/);
  assert.deepEqual(report.summary, { rooms: 3, withFreeSlots: 1, nothingFree: 1, removed: 1, errors: 0, blocked: 0 });
  assert.equal(exitCodeFor(report), 0);

  // One message, for the one room with free slots.
  assert.equal(bot.received.length, 1);
  const [{ path: sentTo, body }] = bot.received;
  assert.equal(sentTo, `/bot${TOKEN}/sendMessage`);
  assert.equal(body.chat_id, "42");
  assert.match(body.text, /^🏠 <a href="http:\/\/127\.0\.0\.1:\d+\/en\/EscapeRoom\/Details\/antique"><b>Antique &lt;VIP&gt;<\/b><\/a>\n\nAvailable slots:\n\n<b>\w{3} /);
  assert.ok(body.text.includes(`${label(TODAY)}</b>: 19:00, 21:15`));
  assert.ok(body.text.trimEnd().endsWith(`${label(addDays(TODAY, 2))}</b>: 00:30`));

  // The site sees what it always saw: one page load per room (the page fetches its own calendar).
  assert.deepEqual(pageCalls(), [
    "GET /en/EscapeRoom/Details/antique",
    "GET /api/Reservation",
    "GET /en/EscapeRoom/Details/coming-soon",
    "GET /en/EscapeRoom/Details/gone",
    "GET /en",
  ]);
  // A fresh browser per room, each sending one of the original user agents.
  assert.equal(site.userAgents.length, 3);
  for (const userAgent of site.userAgents) assert.match(userAgent, /Chrome\/12[0-2]\.0\.0\.0|Firefox\/123|Version\/17\.3/);
});

test("a refusal stops the run at once: no retry, later rooms untouched, one alert", async () => {
  bot.received.length = 0;
  site.requests.length = 0;

  const { report, lines } = await watch([room("Blocked", "blocked"), room("Antique", "antique")]);

  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].outcome, Outcome.BLOCKED);
  assert.equal(report.results[0].refusal.status, 403);
  assert.equal(report.results[0].refusal.cfMitigated, "challenge");
  assert.deepEqual(report.skipped, ["Antique"]);
  assert.equal(exitCodeFor(report), 2);
  assert.deepEqual(pageCalls(), ["GET /en/EscapeRoom/Details/blocked"]);
  assert.equal(bot.received.length, 1);
  assert.match(bot.received[0].body.text, /watcher stopped/);
  assert.ok(lines.some((line) => line.includes("Stopping this run")));
});

test("a rate limit stops the run and the alert passes on how long the site asks to wait", async () => {
  bot.received.length = 0;
  site.requests.length = 0;
  const { report, lines } = await watch([room("Scream", "coming-soon"), room("Limited", "limited"), room("Antique", "antique")]);

  assert.deepEqual(report.results.map((r) => r.outcome), [Outcome.OK, Outcome.BLOCKED]);
  assert.match(report.blocked, /^HTTP 429 "Access denied/);
  assert.deepEqual(
    { ...report.refusal },
    {
      status: 429,
      title: "Access denied | mock used Cloudflare to restrict access",
      errorCode: "1015",
      retryAfterSeconds: 120,
      server: "cloudflare",
      cfMitigated: null,
    },
  );
  assert.deepEqual(report.skipped, ["Antique"]);
  assert.deepEqual(pageCalls(), ["GET /en/EscapeRoom/Details/coming-soon", "GET /en/EscapeRoom/Details/limited"]);
  assert.equal(bot.received.length, 1);
  assert.match(bot.received[0].body.text, /after 1 of 3 rooms/);
  assert.match(bot.received[0].body.text, /asks to wait 120 seconds/);
  assert.ok(lines.some((line) => line.includes("retry after 120 s")));
});

test("rooms are checked one at a time with the extra pause between them", async () => {
  const waits = [];
  const order = [];
  const checkRoom = async (r) => {
    order.push(`start ${r.name}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    order.push(`end ${r.name}`);
    return { availability: {}, removed: null };
  };
  const { report } = await watch([room("A", "a"), room("B", "b"), room("C", "c")], {
    checkRoom,
    sleep: async (ms) => void waits.push(ms),
  });

  assert.deepEqual(order, ["start A", "end A", "start B", "end B", "start C", "end C"]);
  assert.equal(waits.length, 2);
  for (const ms of waits) assert.ok(ms >= 8000 && ms <= 12000, `pause ${ms}`);
  assert.equal(report.summary.nothingFree, 3);
});

test("a failed check is an error, not 'nothing free', and the run carries on", async () => {
  bot.received.length = 0;
  const answers = [
    { availability: null, removed: null },
    new Error("browser crashed"),
    { availability: { "19/11/2026": ["19:00"] }, removed: null },
  ];
  const checkRoom = async () => {
    const answer = answers.shift();
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const { report } = await watch([room("A", "a"), room("B", "b"), room("C", "c")], { checkRoom });

  assert.deepEqual(report.results.map((r) => r.outcome), [Outcome.ERROR, Outcome.ERROR, Outcome.OK]);
  assert.equal(report.results[1].detail, "browser crashed");
  assert.equal(exitCodeFor(report), 1);
  assert.equal(bot.received.length, 1);
});

test("a refusal thrown by the room check carries its details into the report", async () => {
  const details = { status: 403, title: "Attention Required! | Cloudflare", errorCode: null, retryAfterSeconds: null, server: "cloudflare", cfMitigated: null };
  const { report } = await watch([room("A", "a"), room("B", "b")], {
    checkRoom: async () => {
      throw new SiteRefusal(details);
    },
  });
  assert.equal(report.blocked, 'HTTP 403 "Attention Required! | Cloudflare"');
  assert.deepEqual(report.refusal, details);
  assert.deepEqual(report.skipped, ["B"]);
});

test("daysFromAvailability sorts by date and ignores what is not a day with slots", () => {
  assert.deepEqual(
    daysFromAvailability({ "01/12/2026": ["18:30"], "19/11/2026": ["19:00", "21:15"], "20/11/2026": [], nonsense: ["x"] }),
    [
      { date: "2026-11-19", slots: [{ time: "19:00" }, { time: "21:15" }] },
      { date: "2026-12-01", slots: [{ time: "18:30" }] },
    ],
  );
  assert.deepEqual(daysFromAvailability(null), []);
});

test("a room's rules decide which free slots are reported", async () => {
  bot.received.length = 0;
  const rules = [{ days: ["fri", "sat", "sun"], from: "19:00", to: "22:00" }];
  const checkRoom = async () => ({
    availability: { "19/11/2026": ["19:00", "21:15"], "20/11/2026": ["18:30", "20:45"], "21/11/2026": ["00:30"] },
    removed: null,
  });
  const { report, lines } = await watch([{ ...room("Antique", "antique"), rules }, { ...room("Late", "late"), rules: [{ days: ["mon"] }] }], { checkRoom });

  assert.deepEqual(report.results[0].days, [{ date: "2026-11-20", slots: [{ time: "20:45" }] }]);
  assert.equal(report.results[0].freeSlotsBeforeRules, 5);
  assert.deepEqual(report.results[1].days, []);
  assert.deepEqual(report.summary, { rooms: 2, withFreeSlots: 1, nothingFree: 1, removed: 0, errors: 0, blocked: 0 });
  assert.equal(bot.received.length, 1);
  assert.ok(bot.received[0].body.text.includes("<i>Fri, Sat, Sun 19:00–22:00</i>"));
  assert.ok(bot.received[0].body.text.endsWith("<b>Fri 20/11/2026</b>: 20:45"));
  assert.ok(lines.some((line) => line.includes("1 matching free slot(s) on 1 day(s) (4 more outside your rules)")));
  assert.ok(lines.some((line) => line.includes("Late: nothing free that fits (5 more outside your rules)")));
});

test("the full list is sent when it changes, not again while it stays the same", async () => {
  bot.received.length = 0;
  const memory = {};
  const antique = room("Antique", "antique");
  let availability = { "20/11/2026": ["20:45"] };
  const checkRoom = async () => ({ availability, removed: null });
  const runOnce = () => watch([antique], { checkRoom, memory });

  await runOnce(); // first sight: sent
  await runOnce(); // unchanged: not sent
  assert.equal(bot.received.length, 1);

  availability = { "20/11/2026": ["20:45", "23:00"], "21/11/2026": ["00:30"] };
  const { report } = await runOnce(); // one slot more: the whole list is sent, not only the new slot
  assert.equal(bot.received.length, 2);
  assert.ok(bot.received[1].body.text.endsWith("<b>Fri 20/11/2026</b>: 20:45, 23:00\n<b>Sat 21/11/2026</b>: 00:30"));
  assert.equal(report.results[0].notified, true);

  availability = {};
  await runOnce(); // everything got booked: one short note
  await runOnce(); // still nothing: silence
  assert.equal(bot.received.length, 3);
  assert.match(bot.received[2].body.text, /the slots from the last message are gone/);

  availability = { "20/11/2026": ["20:45"] };
  await runOnce(); // free again: sent again
  assert.equal(bot.received.length, 4);
  assert.deepEqual(memory, { [antique.url]: "2026-11-20 20:45" });
});

test("NOTIFY_MODE=always sends the list on every run", async () => {
  bot.received.length = 0;
  const memory = {};
  const checkRoom = async () => ({ availability: { "20/11/2026": ["20:45"] }, removed: null });
  const always = loadConfig({ NOTIFY_MODE: "always" });
  for (let i = 0; i < 3; i++) await watch([room("Antique", "antique")], { checkRoom, memory, config: always });
  assert.equal(bot.received.length, 3);

  // …and never the "gone" note.
  await watch([room("Antique", "antique")], { checkRoom: async () => ({ availability: {}, removed: null }), memory, config: always });
  assert.equal(bot.received.length, 3);
});

test("a message that could not be sent is tried again on the next run", async () => {
  const memory = {};
  const failing = { send: async () => false };
  const checkRoom = async () => ({ availability: { "20/11/2026": ["20:45"] }, removed: null });
  await runWatch({ rooms: [room("Antique", "antique")], config, telegram: failing, memory, log: () => {}, sleep: noSleep, checkRoom });
  assert.deepEqual(memory, {});
});

test("without Telegram settings nothing is sent and the run still succeeds", async () => {
  const lines = [];
  const telegram = createTelegram({ token: null, chatId: null, log: (line) => lines.push(line) });
  const report = await runWatch({
    rooms: [room("A", "a")],
    config,
    telegram,
    log: (line) => lines.push(line),
    sleep: noSleep,
    checkRoom: async () => ({ availability: { "19/11/2026": ["19:00"] }, removed: null }),
  });
  assert.equal(report.results[0].notified, false);
  assert.ok(lines.includes("(telegram) not configured, message not sent"));
  assert.equal(exitCodeFor(report), 0);
});

test("a Telegram failure is logged without the bot token", async () => {
  const lines = [];
  const telegram = createTelegram({ token: TOKEN, chatId: "42", apiBase: "http://127.0.0.1:9", log: (line) => lines.push(line) });
  assert.equal(await telegram.send("hello"), false);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\(telegram\) send failed/);
  assert.ok(!lines[0].includes("test-token") && !lines[0].includes("123456"));
});

test("the command line refuses a watchlist that points outside EscapeAll", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rooms-"));
  try {
    const file = path.join(dir, "watchlist.json");
    await fs.writeFile(file, JSON.stringify({ version: 1, rooms: [{ name: "Evil", url: "https://example.com/en/EscapeRoom/Details/x" }] }));
    await assert.rejects(
      run(process.execPath, ["src/cli.js", "--dry-run"], { env: { ...process.env, WATCHLIST_FILE: file, STATE_DIR: dir } }),
      (error) => error.code === 1 && /not an EscapeAll room page/.test(error.stderr),
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("paused rooms are skipped, and a watchlist with nothing active contacts nobody", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rooms-"));
  try {
    const file = path.join(dir, "watchlist.json");
    const paused = { name: "Antique", url: "https://www.escapeall.gr/en/EscapeRoom/Details/antique", paused: true };
    await fs.writeFile(file, JSON.stringify({ version: 1, rooms: [paused] }));
    const env = { ...process.env, WATCHLIST_FILE: file, STATE_DIR: dir, DRY_RUN: "true" };

    const { stdout } = await run(process.execPath, ["src/cli.js"], { env });
    assert.match(stdout, /Nothing to check: the watchlist has no active rooms \(1 paused\)/);

    // Asking for a paused room by name is a mistake worth pointing out.
    await assert.rejects(
      run(process.execPath, ["src/cli.js"], { env: { ...env, ONLY_ROOMS: "antique" } }),
      (error) => error.code === 1 && /not on the watchlist \(or paused\): antique/.test(error.stderr),
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("both entry points stay away from the site while a refusal is cooling down", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "state-"));
  try {
    await fs.writeFile(
      path.join(dir, "last-refusal.json"),
      JSON.stringify({ at: new Date(Date.now() - 10 * 60_000).toISOString(), detail: "HTTP 403" }),
    );
    for (const entry of ["src/cli.js", "escape_availability.js"]) {
      await assert.rejects(
        run(process.execPath, [entry, "--dry-run"], { env: { ...process.env, STATE_DIR: dir } }),
        (error) => error.code === 3 && /Not contacting it again before \d\d:\d\d Athens time/.test(error.stdout),
        entry,
      );
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

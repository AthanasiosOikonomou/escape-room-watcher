import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import puppeteer from "puppeteer";

import { startServer } from "../web/server.js";
import { startMockGitHub, TEST_TOKEN } from "./helpers/mock-github.js";

const REPO = "someone/escape-room-watcher";
const ANTIQUE = { name: "Antique", url: "https://www.escapeall.gr/en/EscapeRoom/Details/antique", paused: false, rules: [] };
const NOAH = { name: "Noah", url: "https://www.escapeall.gr/en/EscapeRoom/Details/noah", paused: false, rules: [{ days: ["fri", "sat"], from: "19:00", to: "22:00" }] };
const BLAIR = "https://www.escapeall.gr/en/EscapeRoom/Details/the-blair-witch-project";

let github;
let server;
let browser;
let page;
const problems = [];

before(async () => {
  github = await startMockGitHub({ repo: REPO, path: "watchlist.json", initial: { version: 1, rooms: [ANTIQUE, NOAH] } });
  server = await startServer(
    { token: TEST_TOKEN, repo: REPO, branch: "main", watchlistPath: "watchlist.json", host: "127.0.0.1", port: 0, allowedHosts: [], apiBase: github.apiBase },
    { log: () => {} },
  );
  browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  page = await browser.newPage();
  // Anything the browser complains about (script errors, blocked content) fails the tests.
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("dialog", (dialog) => dialog.accept()); // "leave with unsaved changes?" must never hang a test
  page.on("console", (message) => {
    // The tests provoke one HTTP 409 (conflict) and one 429 (check too soon) on purpose; the browser logs them as failed resources.
    if (message.type() === "error" && !/status of (409|429)/.test(message.text())) problems.push(`console: ${message.text()}`);
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await waitForRooms();
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  await github.close();
});

/** Waits for the list; if it never comes, says what the page shows instead. */
const waitForRooms = async () => {
  try {
    await page.waitForSelector(".room", { timeout: 10_000 });
  } catch {
    const state = await page.evaluate(() => ({
      count: document.getElementById("count")?.textContent,
      notice: document.getElementById("notice")?.textContent,
      url: location.href,
    }));
    throw new Error(`the list did not appear: ${JSON.stringify(state)}`);
  }
};
const text = (selector) => page.$eval(selector, (node) => node.textContent.trim());
const hidden = (selector) => page.$eval(selector, (node) => node.hidden);
const names = () => page.$$eval(".room-name a", (nodes) => nodes.map((node) => node.textContent));
const dialogOpen = () => page.$eval("#slots", (dialog) => dialog.open);
/** What each room shows: one "<lit days> <hours>" line per slot. */
const shownSlots = () =>
  page.$$eval(".room", (rooms) =>
    rooms.map((room) =>
      [...room.querySelectorAll(".slot")].map(
        (slot) => `${slot.querySelectorAll(".dot.on").length} days ${slot.querySelector(".slot-time").textContent}`,
      ),
    ),
  );
const clickText = (scope, label) =>
  page.evaluate(
    (scope, label) => {
      const button = [...document.querySelectorAll(`${scope} button`)].find((b) => b.textContent.trim() === label);
      if (!button) throw new Error(`no button "${label}" in ${scope}`);
      button.click();
    },
    scope,
    label,
  );
const tick = (day) => page.click(`#slots input[type=checkbox][aria-label="${day}"]`);
const ticked = () => page.$$eval("#slots input[type=checkbox]:checked", (boxes) => boxes.map((box) => box.getAttribute("aria-label")));
// The save bar slides in from below; wait until it has arrived before clicking in it.
const clickInSaveBar = async (id) => {
  await page.waitForFunction(() => {
    const bar = document.getElementById("savebar");
    return !bar.hidden && bar.getBoundingClientRect().bottom <= window.innerHeight + 1;
  });
  await page.click(`#${id}`);
};
const saveAndWait = async () => {
  await clickInSaveBar("save");
  await page.waitForFunction(() => document.getElementById("savebar").hidden);
};
const addLink = async (value) => {
  await page.$eval("#add-url", (input) => (input.value = ""));
  await page.type("#add-url", value);
  await page.keyboard.press("Enter");
};
const find = async (value) => {
  await page.$eval("#find-input", (input) => (input.value = ""));
  await page.type("#find-input", value || " ");
  if (!value) await page.keyboard.press("Backspace");
};

test("the saved list is shown: each name links to its room, each slot shows its days and hours", async () => {
  assert.equal(await text("#count"), "2 rooms watched");
  assert.deepEqual(await names(), ["Antique", "Noah"]);
  assert.deepEqual(await shownSlots(), [["7 days any time"], ["2 days 19:00 to 22:00"]]);
  assert.deepEqual(
    await page.$$eval(".room-name a", (links) => links.map((a) => [a.href, a.target, a.rel])),
    [
      [ANTIQUE.url, "_blank", "noopener noreferrer"],
      [NOAH.url, "_blank", "noopener noreferrer"],
    ],
  );
  assert.equal(await hidden("#savebar"), true);
  // No room address and no repository name are printed on the page.
  const body = await text("body");
  assert.ok(!body.includes("EscapeRoom/Details") && !body.includes(REPO));
});

test("a link that is not a room page, or a room already listed, is explained and not added", async () => {
  await addLink("https://www.escapeall.gr/en/Account/Login");
  assert.match(await text("#add-hint"), /That is not a room page/);
  await addLink("https://evil.example/en/EscapeRoom/Details/antique");
  assert.match(await text("#add-hint"), /That is not a room page/);
  await addLink("https://www.escapeall.gr/el/EscapeRoom/Details/Antique");
  assert.equal(await text("#add-hint"), "Antique is already on the list.");
  assert.deepEqual(await names(), ["Antique", "Noah"]);
  assert.equal(await dialogOpen(), false);
  assert.equal(await hidden("#savebar"), true);
});

test("adding a room opens the slots dialog at once; ticking days and picking hours, then saving, puts exactly that on GitHub", async () => {
  await addLink("www.escapeall.gr/en/EscapeRoom/Details/the-blair-witch-project?from=search#reviews");
  assert.equal(await dialogOpen(), true);
  assert.equal(await page.$eval("#slots-name", (input) => input.value), "The Blair Witch Project");
  assert.equal((await ticked()).length, 7); // starts as every day, any time

  for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday"]) await tick(day);
  assert.deepEqual(await ticked(), ["Friday", "Saturday", "Sunday"]);
  await page.select('#slots select[aria-label="Earliest start"]', "19:00");
  await page.select('#slots select[aria-label="Latest start"]', "22:00");
  await page.click("#slots-done");

  assert.equal(await dialogOpen(), false);
  assert.deepEqual(await names(), ["The Blair Witch Project", "Antique", "Noah"]);
  assert.deepEqual((await shownSlots())[0], ["3 days 19:00 to 22:00"]);

  await saveAndWait();
  assert.equal(await text("#toast"), "Saved. The next check uses the new list."); // the whole toast, nothing stray after it
  assert.deepEqual(github.json().rooms[0], {
    name: "The Blair Witch Project",
    url: BLAIR,
    paused: false,
    rules: [{ days: ["fri", "sat", "sun"], from: "19:00", to: "22:00" }],
  });
  assert.equal(github.json().rooms.length, 3);
  assert.equal(github.state.commits.at(-1).message, "Watchlist: add The Blair Witch Project");
});

test("the dialog refuses a slot that cannot work, and Cancel changes nothing", async () => {
  await clickText(".room:first-child", "Edit slots");
  assert.equal(await dialogOpen(), true);

  await page.select('#slots select[aria-label="Latest start"]', "18:00");
  assert.match(await text("#slots .problem"), /ends before it starts/);
  assert.equal(await page.$eval("#slots-done", (button) => button.disabled), true);

  await page.select('#slots select[aria-label="Latest start"]', "01:00"); // past midnight is the same evening
  assert.equal(await page.$("#slots .problem"), null);
  for (const day of ["Friday", "Saturday", "Sunday"]) await tick(day);
  assert.equal(await text("#slots .problem"), "Tick at least one day.");
  assert.equal(await page.$eval("#slots-done", (button) => button.disabled), true);

  await page.click("#slots-cancel");
  assert.equal(await dialogOpen(), false);
  assert.deepEqual((await shownSlots())[0], ["3 days 19:00 to 22:00"]);
  assert.equal(await hidden("#savebar"), true);
});

test("a room can have several slots and a new name; every day at any time is saved as no limit", async () => {
  await clickText(".room:first-child", "Edit slots");
  await page.$eval("#slots-name", (input) => (input.value = ""));
  await page.type("#slots-name", "Blair Witch");
  await page.click("#slots-add");
  assert.equal(await page.$$eval("#slots .slot-edit", (n) => n.length), 2);
  // Second slot: Saturday only, late.
  for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Sunday"]) {
    await page.click(`#slots .slot-edit:nth-child(2) input[type=checkbox][aria-label="${day}"]`);
  }
  await page.select('#slots .slot-edit:nth-child(2) select[aria-label="Earliest start"]', "23:00");
  await page.click("#slots-done");
  assert.deepEqual(await names(), ["Blair Witch", "Antique", "Noah"]);
  assert.deepEqual((await shownSlots())[0], ["3 days 19:00 to 22:00", "1 days from 23:00"]);

  // Noah: tick every day and clear the hours -> no limit at all.
  await clickText(".room:nth-child(3)", "Edit slots");
  await clickText("#slots", "Every day");
  await page.select('#slots select[aria-label="Earliest start"]', "");
  await page.select('#slots select[aria-label="Latest start"]', "");
  await page.click("#slots-done");
  assert.deepEqual((await shownSlots())[2], ["7 days any time"]);

  await saveAndWait();
  const [blair, , noah] = github.json().rooms;
  assert.equal(blair.name, "Blair Witch");
  assert.deepEqual(blair.rules, [{ days: ["fri", "sat", "sun"], from: "19:00", to: "22:00" }, { days: ["sat"], from: "23:00" }]);
  assert.deepEqual(noah.rules, []);
  assert.equal(github.state.commits.at(-1).message, "Watchlist: update Blair Witch, Noah");
});

test("the search box narrows the list by name or by link", async () => {
  await find("noa");
  assert.deepEqual(await names(), ["Noah"]);
  assert.equal(await text("#count"), "1 of 3 rooms");

  await find("https://www.escapeall.gr/el/EscapeRoom/Details/antique?x=1"); // a pasted link, any language
  assert.deepEqual(await names(), ["Antique"]);
  await find("blair-witch"); // part of the address
  assert.deepEqual(await names(), ["Blair Witch"]);

  await find("zzz");
  assert.deepEqual(await names(), []);
  assert.equal(await text("#empty"), "No room on the list matches “zzz”.");

  await find("");
  assert.deepEqual(await names(), ["Blair Witch", "Antique", "Noah"]);
  assert.equal(await text("#count"), "3 rooms watched");
  assert.equal(await hidden("#savebar"), true); // searching is not a change
});

test("pausing and removing: a removed room can be brought back before saving", async () => {
  await clickText(".room:nth-child(2)", "Pause");
  assert.equal(await text("#count"), "2 rooms watched, 1 paused");
  await clickText(".room:nth-child(3)", "Remove");
  assert.deepEqual(await names(), ["Blair Witch", "Antique"]);
  assert.equal(await text("#toast span"), "Removed Noah.");
  await clickText("#toast", "Undo");
  assert.deepEqual(await names(), ["Blair Witch", "Antique", "Noah"]);

  await saveAndWait();
  assert.deepEqual(github.json().rooms.map((room) => [room.name, room.paused]), [["Blair Witch", false], ["Antique", true], ["Noah", false]]);
  assert.equal(github.state.commits.at(-1).message, "Watchlist: update Antique");
});

test("a change made elsewhere is not overwritten: the page offers to load the latest", async () => {
  github.editElsewhere({ version: 1, rooms: [NOAH] });
  await clickText(".room:nth-child(2)", "Resume");
  await clickInSaveBar("save");
  await page.waitForFunction(() => !document.getElementById("notice").hidden);
  assert.match(await text("#notice p"), /changed somewhere else/);
  assert.ok((await text("#notice")).endsWith("Load the latest"));
  assert.deepEqual(github.json().rooms, [NOAH]);

  await clickText("#notice", "Load the latest");
  await page.waitForFunction(() => document.querySelectorAll(".room").length === 1);
  assert.deepEqual(await names(), ["Noah"]);
  assert.equal(await hidden("#savebar"), true);
});

test("the page shows when the rooms were last checked, and Check now starts a check", async () => {
  github.state.runs = [
    { created_at: new Date(Date.now() - 12 * 60_000).toISOString(), status: "completed", conclusion: "success", event: "schedule", html_url: `https://github.com/${REPO}/actions/runs/7` },
  ];
  await page.reload();
  await waitForRooms();
  await page.waitForFunction(() => !document.getElementById("status").hidden);
  assert.equal(await text("#status-text"), "The last check started 12 minutes ago and went fine.");
  assert.equal(await page.$eval("#status-text a", (a) => a.href), `https://github.com/${REPO}/actions/runs/7`);

  await page.click("#check-now");
  await page.waitForFunction(() => !document.getElementById("toast").hidden);
  assert.equal(await text("#toast"), "Check started. Telegram hears about it in a few minutes.");
  assert.deepEqual(github.state.dispatches, [{ ref: "main", inputs: { dry_run: "false", rooms: "" } }]);

  await page.click("#check-now"); // a second click right away is refused politely
  await page.waitForFunction(() => document.getElementById("toast").textContent.includes("a moment ago"));
  assert.equal(github.state.dispatches.length, 1);
});

test("room names are shown as text, never run as markup", async () => {
  github.editElsewhere({ version: 1, rooms: [{ ...NOAH, name: '<img src=x onerror="window.pwned=1">' }] });
  await page.reload();
  await waitForRooms();
  assert.deepEqual(await names(), ['<img src=x onerror="window.pwned=1">']);
  assert.equal(await page.evaluate(() => window.pwned), undefined);
  assert.equal(await page.$(".room img"), null);
});

test("the browser reported no script errors and nothing blocked by the content policy", () => {
  assert.deepEqual(problems, []);
});

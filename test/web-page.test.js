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
    // The conflict test provokes one HTTP 409 on purpose; the browser logs it as a failed resource.
    if (message.type() === "error" && !message.text().includes("status of 409")) problems.push(`console: ${message.text()}`);
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForSelector(".room");
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  await github.close();
});

const text = (selector) => page.$eval(selector, (node) => node.textContent.trim());
const hidden = (selector) => page.$eval(selector, (node) => node.hidden);
const names = () => page.$$eval(".room-name", (nodes) => nodes.map((node) => node.value));
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
// The save bar slides in from below; wait until it has arrived before clicking in it.
const clickInSaveBar = async (id) => {
  await page.waitForFunction(() => {
    const bar = document.getElementById("savebar");
    return !bar.hidden && bar.getBoundingClientRect().bottom <= window.innerHeight + 1;
  });
  await page.click(`#${id}`);
};
const addLink = async (value) => {
  await page.$eval("#add-url", (input) => (input.value = ""));
  await page.type("#add-url", value);
  await page.keyboard.press("Enter");
};

test("the saved list is shown, with nothing to save", async () => {
  assert.equal(await text("#count"), "2 rooms watched");
  assert.deepEqual(await names(), ["Antique", "Noah"]);
  assert.deepEqual(await page.$$eval(".when", (nodes) => nodes.map((n) => n.textContent)), ["Any day, any time.", "Fri, Sat 19:00–22:00."]);
  assert.equal(await hidden("#savebar"), true);
  // Noah's strip is lit on two days only; Antique's on all seven.
  assert.deepEqual(await page.$$eval(".room", (rooms) => rooms.map((room) => room.querySelectorAll(".day.on").length)), [7, 2]);
});

test("a link that is not a room page, or a room already listed, is explained and not added", async () => {
  await addLink("https://www.escapeall.gr/en/Account/Login");
  assert.match(await text("#add-hint"), /That is not a room page/);
  await addLink("https://evil.example/en/EscapeRoom/Details/antique");
  assert.match(await text("#add-hint"), /That is not a room page/);
  await addLink("https://www.escapeall.gr/el/EscapeRoom/Details/Antique");
  assert.equal(await text("#add-hint"), "Antique is already on the list.");
  assert.deepEqual(await names(), ["Antique", "Noah"]);
  assert.equal(await hidden("#savebar"), true);
});

test("adding a room, limiting its days and hours, and saving puts exactly that on GitHub", async () => {
  await addLink("www.escapeall.gr/en/EscapeRoom/Details/the-blair-witch-project?from=search#reviews");
  assert.deepEqual(await names(), ["The Blair Witch Project", "Antique", "Noah"]);
  assert.equal(await hidden("#savebar"), false);
  assert.equal(await page.evaluate(() => document.activeElement.className), "room-name"); // ready to fix the name

  await clickText(".room:first-child", "Limit the days and hours");
  assert.equal(await page.$$eval(".room:first-child .days button[aria-pressed=true]", (n) => n.length), 7);
  await clickText(".room:first-child", "Fri to Sun");
  await page.select('.room:first-child select[aria-label="Earliest start"]', "19:00");
  await page.select('.room:first-child select[aria-label="Latest start"]', "22:00");
  assert.equal(await text(".room:first-child .when"), "Fri, Sat, Sun 19:00–22:00.");
  assert.equal(await page.$$eval(".room:first-child .day.on", (n) => n.length), 3);

  await clickInSaveBar("save");
  await page.waitForFunction(() => document.getElementById("savebar").hidden);
  assert.equal(await text("#toast span"), "Saved. The next check uses the new list.");
  assert.deepEqual(github.json().rooms[0], {
    name: "The Blair Witch Project",
    url: BLAIR,
    paused: false,
    rules: [{ days: ["fri", "sat", "sun"], from: "19:00", to: "22:00" }],
  });
  assert.equal(github.json().rooms.length, 3);
  assert.equal(github.state.commits.at(-1).message, "Watchlist: add The Blair Witch Project");
});

test("a window that ends before it starts is flagged and cannot be saved; past midnight is fine", async () => {
  await page.select('.room:first-child select[aria-label="Latest start"]', "18:00");
  assert.match(await text(".room:first-child .rule-problem"), /ends before it starts/);
  assert.equal(await page.$eval("#save", (button) => button.disabled), true);
  assert.equal(await text("#save-text"), "The Blair Witch Project has a time window to fix.");

  await page.select('.room:first-child select[aria-label="Latest start"]', "01:00");
  assert.equal(await page.$(".room:first-child .rule-problem"), null);
  assert.equal(await text(".room:first-child .when"), "Fri, Sat, Sun 19:00–01:00.");
  assert.equal(await page.$eval("#save", (button) => button.disabled), false);
  await clickInSaveBar("discard");
  assert.equal(await hidden("#savebar"), true);
  assert.equal(await text(".room:first-child .when"), "Fri, Sat, Sun 19:00–22:00.");
});

test("pausing and removing: a removed room can be brought back before saving", async () => {
  await clickText(".room:nth-child(2)", "Pause");
  assert.equal(await text("#count"), "2 rooms watched, 1 paused");
  await clickText(".room:nth-child(3)", "Remove");
  assert.deepEqual(await names(), ["The Blair Witch Project", "Antique"]);
  assert.equal(await text("#toast span"), "Removed Noah.");
  await clickText("#toast", "Undo");
  assert.deepEqual(await names(), ["The Blair Witch Project", "Antique", "Noah"]);

  await clickInSaveBar("save");
  await page.waitForFunction(() => document.getElementById("savebar").hidden);
  assert.deepEqual(github.json().rooms.map((room) => [room.name, room.paused]), [["The Blair Witch Project", false], ["Antique", true], ["Noah", false]]);
  assert.equal(github.state.commits.at(-1).message, "Watchlist: update Antique");
});

test("a change made elsewhere is not overwritten: the page offers to load the latest", async () => {
  github.editElsewhere({ version: 1, rooms: [NOAH] });
  await clickText(".room:nth-child(2)", "Resume");
  await clickInSaveBar("save");
  await page.waitForFunction(() => !document.getElementById("notice").hidden);
  assert.match(await text("#notice p"), /changed somewhere else/);
  assert.deepEqual(github.json().rooms, [NOAH]);

  await clickText("#notice", "Load the latest");
  await page.waitForFunction(() => document.querySelectorAll(".room").length === 1);
  assert.deepEqual(await names(), ["Noah"]);
  assert.equal(await hidden("#savebar"), true);
});

test("room names are shown as text, never run as markup", async () => {
  github.editElsewhere({ version: 1, rooms: [{ ...NOAH, name: '<img src=x onerror="window.pwned=1">' }] });
  await page.reload();
  await page.waitForSelector(".room");
  assert.deepEqual(await names(), ['<img src=x onerror="window.pwned=1">']);
  assert.equal(await page.evaluate(() => window.pwned), undefined);
  assert.equal(await page.$(".room img"), null);
});

test("the browser reported no script errors and nothing blocked by the content policy", () => {
  assert.deepEqual(problems, []);
});

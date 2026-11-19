import test, { after, before } from "node:test";
import assert from "node:assert/strict";

import { ConfigError } from "../src/config.js";
import { loadWebConfig } from "../web/config.js";
import { createGitHub } from "../web/github.js";
import { createScheduler, minutesSince } from "../web/scheduler.js";
import { startServer } from "../web/server.js";
import { startMockGitHub, TEST_TOKEN } from "./helpers/mock-github.js";

const REPO = "someone/escape-room-watcher";
let mock;
let github;
let server;
let origin;
const logged = [];

const run = (minutesAgo, extra = {}) => ({
  created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  status: "completed",
  conclusion: "success",
  event: "schedule",
  html_url: `https://github.com/${REPO}/actions/runs/1`,
  ...extra,
});

before(async () => {
  mock = await startMockGitHub({ repo: REPO, path: "watchlist.json", initial: { version: 1, rooms: [] } });
  const config = {
    token: TEST_TOKEN, repo: REPO, branch: "main", watchlistPath: "watchlist.json", workflowFile: "main.yml",
    checkEveryMinutes: 30, host: "127.0.0.1", port: 0, allowedHosts: [], apiBase: mock.apiBase,
  };
  github = createGitHub(config);
  // schedule: false, so the timer does not fire on its own during the tests.
  server = await startServer(config, { log: (line) => logged.push(line), schedule: false });
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await mock.close();
});

const scheduler = () => createScheduler({ github, everyMinutes: 30, log: (line) => logged.push(line) });
const reset = (...runs) => {
  mock.state.runs = runs;
  mock.state.dispatches = [];
  mock.state.actionsAllowed = true;
  logged.length = 0;
};

test("a check is started when none began within the interval, on the watched branch, as a real run", async () => {
  reset(run(41));
  assert.equal(await scheduler().tick(), "started");
  assert.deepEqual(mock.state.dispatches, [{ ref: "main", inputs: { dry_run: "false", rooms: "" } }]);
  assert.deepEqual(logged, ["started a check (last one 41 minutes ago)"]);
});

test("nothing is started while a recent run exists, whoever started it", async () => {
  for (const recent of [run(29), run(3, { event: "workflow_dispatch" }), run(12, { status: "in_progress", conclusion: null })]) {
    reset(recent);
    assert.equal(await scheduler().tick(), "not-due");
    assert.equal(mock.state.dispatches.length, 0);
  }
});

test("looking again right after starting a run does not start another: restarts cannot pile up runs", async () => {
  reset(run(300));
  const first = scheduler();
  assert.equal(await first.tick(), "started");
  assert.equal(await first.tick(), "not-due");
  assert.equal(await scheduler().tick(), "not-due"); // a freshly restarted service
  assert.equal(mock.state.dispatches.length, 1);
});

test("with no run ever, the first look starts one", async () => {
  reset();
  assert.equal(await scheduler().tick(), "started");
  assert.deepEqual(logged, ["started a check (last one never)"]);
});

test("a token without the Actions permission is reported once, clearly, and never crashes the timer", async () => {
  reset(run(90));
  mock.state.actionsAllowed = false;
  const s = scheduler();
  assert.equal(await s.tick(), "failed");
  assert.equal(await s.tick(), "failed");
  assert.equal(logged.length, 1);
  assert.match(logged[0], /^could not keep the checks going: GitHub refused the token while looking at the last check \(HTTP 403/);
  assert.match(logged[0], /Actions read and write/);
  assert.ok(!logged[0].includes(TEST_TOKEN));

  mock.state.actionsAllowed = true; // permission added: it recovers by itself
  assert.equal(await s.tick(), "started");
});

test("the page can see the last check", async () => {
  reset(run(12, { status: "completed", conclusion: "failure" }));
  const body = await (await fetch(`${origin}/api/status`)).json();
  assert.equal(body.everyMinutes, 30);
  assert.equal(body.latest.status, "completed");
  assert.equal(body.latest.conclusion, "failure");
  assert.equal(body.latest.event, "schedule");
  assert.equal(body.latest.url, `https://github.com/${REPO}/actions/runs/1`);
  assert.ok(minutesSince(body.latest.createdAt) > 11);

  reset();
  assert.equal((await (await fetch(`${origin}/api/status`)).json()).latest, null);

  reset(run(5, { html_url: "javascript:alert(1)" })); // only real GitHub links are passed on
  assert.equal((await (await fetch(`${origin}/api/status`)).json()).latest.url, null);
});

test("Check now starts a run, but only from the page itself and not twice in a row", async () => {
  reset(run(18));
  const check = (headers = { origin }) => fetch(`${origin}/api/check`, { method: "POST", headers });

  assert.equal((await check({})).status, 403);
  assert.equal((await check({ origin: "https://evil.example" })).status, 403);
  assert.equal(mock.state.dispatches.length, 0);

  const started = await check();
  assert.equal(started.status, 202);
  assert.equal(mock.state.dispatches.length, 1);
  assert.ok(logged.includes("started a check on request"));

  const again = await check();
  assert.equal(again.status, 429);
  assert.match((await again.json()).error, /started a moment ago/);
  assert.equal(mock.state.dispatches.length, 1);
  assert.equal((await fetch(`${origin}/api/check`)).status, 405);
});

test("without the Actions permission the page is told what the token needs", async () => {
  reset(run(50));
  mock.state.actionsAllowed = false;
  for (const response of [await fetch(`${origin}/api/status`), await fetch(`${origin}/api/check`, { method: "POST", headers: { origin } })]) {
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /needs Actions read and write/);
  }
});

test("the timer settings are checked at start", () => {
  const base = { GITHUB_TOKEN: TEST_TOKEN, GITHUB_REPO: REPO };
  assert.equal(loadWebConfig(base).checkEveryMinutes, 30);
  assert.equal(loadWebConfig(base).workflowFile, "main.yml");
  assert.equal(loadWebConfig({ ...base, CHECK_EVERY_MINUTES: "0" }).checkEveryMinutes, 0);
  assert.equal(loadWebConfig({ ...base, CHECK_EVERY_MINUTES: "60" }).checkEveryMinutes, 60);
  assert.throws(() => loadWebConfig({ ...base, CHECK_EVERY_MINUTES: "5" }), ConfigError); // not faster than every 15 minutes
  assert.throws(() => loadWebConfig({ ...base, CHECK_EVERY_MINUTES: "often" }), ConfigError);
  assert.throws(() => loadWebConfig({ ...base, WORKFLOW_FILE: "../other.yml" }), ConfigError);
});

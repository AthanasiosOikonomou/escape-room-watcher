import test, { after, before } from "node:test";
import assert from "node:assert/strict";

import { ConfigError } from "../src/config.js";
import { loadWebConfig } from "../web/config.js";
import { describeChange } from "../web/github.js";
import { startServer } from "../web/server.js";
import { startMockGitHub, TEST_TOKEN } from "./helpers/mock-github.js";

const REPO = "someone/escape-room-watcher";
const ANTIQUE = { name: "Antique", url: "https://www.escapeall.gr/en/EscapeRoom/Details/antique", paused: false, rules: [] };
const NOAH = { name: "Noah", url: "https://www.escapeall.gr/en/EscapeRoom/Details/noah", paused: false, rules: [{ days: ["fri", "sat"], from: "19:00", to: "22:00" }] };
const list = (...rooms) => ({ version: 1, rooms });

let github;
let server;
let origin;
const logged = [];

async function start(initial) {
  github = await startMockGitHub({ repo: REPO, path: "watchlist.json", initial });
  const config = {
    token: TEST_TOKEN, repo: REPO, branch: "main", watchlistPath: "watchlist.json",
    host: "127.0.0.1", port: 0, allowedHosts: ["debian.home"], apiBase: github.apiBase,
  };
  server = await startServer(config, { log: (line) => logged.push(line) });
  origin = `http://127.0.0.1:${server.address().port}`;
}

async function stop() {
  await new Promise((resolve) => server.close(resolve));
  await github.close();
}

const get = (path = "/api/watchlist", headers = {}) => fetch(origin + path, { headers });
const put = (body, headers = {}) =>
  fetch(`${origin}/api/watchlist`, {
    method: "PUT",
    headers: { "content-type": "application/json", origin, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

before(() => start(list(ANTIQUE)));
after(stop);

test("the page and its files are served with a strict content policy, and nothing else is", async () => {
  for (const [path, type] of [["/", "text/html"], ["/app.js", "text/javascript"], ["/styles.css", "text/css"], ["/shared/rules.js", "text/javascript"], ["/favicon.svg", "image/svg+xml"]]) {
    const response = await get(path);
    assert.equal(response.status, 200, path);
    assert.ok(response.headers.get("content-type").startsWith(type), path);
    assert.match(response.headers.get("content-security-policy"), /default-src 'none'; script-src 'self'/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  }
  for (const path of ["/server.js", "/config.js", "/../package.json", "/public/app.js", "/.env", "/shared/watchlist.js"]) {
    assert.equal((await get(path)).status, 404, path);
  }
});

test("reading returns the watchlist with the version it came from, and never the token", async () => {
  const response = await get();
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(text), { watchlist: list(ANTIQUE), sha: github.sha(), repo: REPO, branch: "main" });
  assert.ok(!text.includes(TEST_TOKEN));
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("saving commits the normalised watchlist with a message that says what changed", async () => {
  const messy = { ...NOAH, name: "  Noah ", url: `${NOAH.url}?ref=home#top` };
  const response = await put({ watchlist: list(ANTIQUE, messy), sha: github.sha() });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.watchlist, list(ANTIQUE, NOAH));
  assert.equal(body.sha, github.sha());
  assert.deepEqual(github.json(), list(ANTIQUE, NOAH));
  assert.equal(github.state.commits.at(-1).message, "Watchlist: add Noah");
  assert.ok(github.state.commits.at(-1).text.endsWith("}\n"));
  assert.ok(logged.includes("saved: Watchlist: add Noah"));
});

test("saving the same list again commits nothing", async () => {
  const commits = github.state.commits.length;
  const response = await put({ watchlist: list(ANTIQUE, NOAH), sha: github.sha() });
  assert.equal((await response.json()).unchanged, true);
  assert.equal(github.state.commits.length, commits);
});

test("an edit made elsewhere is not overwritten: the save is refused as a conflict", async () => {
  const stale = github.sha();
  github.editElsewhere(list(NOAH));
  const response = await put({ watchlist: list(ANTIQUE), sha: stale });
  assert.equal(response.status, 409);
  assert.deepEqual(github.json(), list(NOAH));
  github.editElsewhere(list(ANTIQUE, NOAH));
});

test("only valid watchlists reach GitHub", async () => {
  const commits = github.state.commits.length;
  const bad = async (watchlist, pattern) => {
    const response = await put({ watchlist, sha: github.sha() });
    assert.equal(response.status, 422);
    assert.match((await response.json()).error, pattern);
  };
  await bad(list({ name: "Evil", url: "https://example.com/en/EscapeRoom/Details/x" }), /not an EscapeAll room page/);
  await bad(list({ ...ANTIQUE, rules: [{ from: "22:00", to: "19:00" }] }), /is after/);
  await bad(list(ANTIQUE, { ...ANTIQUE, name: "Twice" }), /listed twice/);
  await bad({ rooms: [] }, /must look like/);
  assert.equal((await put("{not json", {})).status, 400);
  assert.equal((await put({ watchlist: list(ANTIQUE), sha: "main" })).status, 400);
  assert.equal((await put({ watchlist: list(), sha: github.sha(), pad: "x".repeat(70_000) })).status, 413);
  assert.equal(github.state.commits.length, commits);
});

test("a change must come from the page itself", async () => {
  const body = { watchlist: list(ANTIQUE), sha: github.sha() };
  assert.equal((await put(body, { origin: "https://evil.example" })).status, 403);
  assert.equal((await fetch(`${origin}/api/watchlist`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status, 403);
  assert.equal((await put(body, { "content-type": "text/plain" })).status, 415);
  assert.equal((await fetch(`${origin}/api/watchlist`, { method: "DELETE", headers: { origin } })).status, 405);
  assert.deepEqual(github.json(), list(ANTIQUE, NOAH));
});

test("requests for another host name are turned away", async () => {
  // fetch() does not let a Host header be forged, so speak HTTP directly.
  const { request } = await import("node:http");
  const statusFor = (host) =>
    new Promise((resolve, reject) => {
      const req = request(`${origin}/api/watchlist`, { headers: { host } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on("error", reject);
      req.end();
    });
  assert.equal(await statusFor("evil.example"), 421);
  assert.equal(await statusFor("rebind.attacker.test:8787"), 421);
  assert.equal(await statusFor("debian.home"), 200); // listed in ALLOWED_HOSTS
  assert.equal(await statusFor("server.tail1234.ts.net"), 200); // a Tailscale name
  assert.equal(await statusFor("localhost:8787"), 200);
});

test("a refused token is reported clearly, without the token", async () => {
  github.state.failNextWrite = { status: 403, message: "Resource not accessible by personal access token" };
  const response = await put({ watchlist: list(ANTIQUE), sha: github.sha() });
  const text = await response.text();
  assert.equal(response.status, 502);
  assert.match(text, /GitHub refused the token while saving the watchlist \(HTTP 403: Resource not accessible/);
  assert.match(text, /Contents read and write/);
  assert.ok(!text.includes(TEST_TOKEN));
  assert.deepEqual(github.json(), list(ANTIQUE, NOAH));
});

test("a watchlist file that does not exist yet reads as empty and is created by the first save", async () => {
  await stop();
  await start(null);
  assert.deepEqual(await (await get()).json(), { watchlist: list(), sha: null, repo: REPO, branch: "main" });

  const response = await put({ watchlist: list(ANTIQUE), sha: null });
  assert.equal(response.status, 200);
  assert.deepEqual(github.json(), list(ANTIQUE));
  assert.equal(github.state.commits.at(-1).message, "Watchlist: add Antique");
});

test("a broken file on GitHub is reported, not shown as an empty list", async () => {
  github.editElsewhere({ version: 1, rooms: [{ name: "x", url: "https://example.com/" }] });
  const response = await get();
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /The watchlist on GitHub is not valid/);
  github.editElsewhere(list(ANTIQUE));
});

test("commit messages describe adds, removals and edits", () => {
  const edited = { ...NOAH, paused: true };
  assert.equal(describeChange(list(ANTIQUE, NOAH), list(edited)), "Watchlist: remove Antique; update Noah");
  assert.equal(describeChange(list(ANTIQUE, NOAH), list(NOAH, ANTIQUE)), "Watchlist: reorder");
  const many = Array.from({ length: 30 }, (_, i) => ({ ...ANTIQUE, name: `Room number ${i}`, url: `${ANTIQUE.url}-${i}` }));
  assert.ok(describeChange(list(), list(...many)).length <= 160);
});

test("settings are checked at start", () => {
  const base = { GITHUB_TOKEN: TEST_TOKEN, GITHUB_REPO: REPO };
  const config = loadWebConfig(base);
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 8787);
  assert.equal(config.branch, "main");
  assert.equal(config.apiBase, "https://api.github.com");
  assert.deepEqual(loadWebConfig({ ...base, ALLOWED_HOSTS: "Debian, box.lan" }).allowedHosts, ["debian", "box.lan"]);

  const bad = (env, pattern) => assert.throws(() => loadWebConfig({ ...base, ...env }), pattern ?? ConfigError);
  bad({ GITHUB_TOKEN: "" }, /GITHUB_TOKEN is missing/);
  bad({ GITHUB_REPO: "just-a-name" });
  bad({ GITHUB_REPO: "a/b/../c" });
  bad({ GITHUB_BRANCH: "main; rm -rf" });
  bad({ WATCHLIST_PATH: "../secrets.json" });
  bad({ WATCHLIST_PATH: "watchlist.yml" });
  bad({ PORT: "0" });
  bad({ GITHUB_API_URL: "http://api.github.com" }, /must use https/);
});

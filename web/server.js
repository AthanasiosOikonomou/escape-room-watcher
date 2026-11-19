#!/usr/bin/env node
/**
 * The watchlist page: a small single-user site that edits watchlist.json in
 * the GitHub repository. It never contacts escapeall.gr; the checking is done
 * by the GitHub workflow.
 *
 *   node --env-file=.env web/server.js
 *
 * It also keeps the checks coming: when no run of the workflow began within
 * CHECK_EVERY_MINUTES, it starts one (web/scheduler.js).
 *
 * Settings: GITHUB_TOKEN, GITHUB_REPO (required), GITHUB_BRANCH, WATCHLIST_PATH,
 * WORKFLOW_FILE, CHECK_EVERY_MINUTES, HOST, PORT, ALLOWED_HOSTS. See web/config.js.
 */
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ConfigError } from "../src/config.js";
import { validateWatchlist } from "../src/watchlist.js";
import { loadWebConfig } from "./config.js";
import { createGitHub, describeChange, GitHubError } from "./github.js";
import { createScheduler, minutesSince } from "./scheduler.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX_BODY_BYTES = 64 * 1024;
// "Check now" is refused while a check from the last few minutes is still fresh.
const CHECK_NOW_MIN_GAP_MINUTES = 5;

// The only files the page is made of. Nothing else on disk can be requested.
const STATIC = {
  "/": ["public/index.html", "text/html; charset=utf-8"],
  "/app.js": ["public/app.js", "text/javascript; charset=utf-8"],
  "/styles.css": ["public/styles.css", "text/css; charset=utf-8"],
  "/favicon.svg": ["public/favicon.svg", "image/svg+xml"],
  "/shared/rules.js": ["../src/rules.js", "text/javascript; charset=utf-8"],
};

const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The Host header must name this machine: stops other sites reaching the page through DNS tricks. */
function hostAllowed(hostHeader, config) {
  if (typeof hostHeader !== "string") return false;
  let hostname;
  try {
    hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    LOOPBACK_HOSTS.has(hostname) ||
    hostname === config.host.toLowerCase() ||
    hostname.endsWith(".ts.net") ||
    config.allowedHosts.includes(hostname)
  );
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(payload);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return { tooLarge: true };
    chunks.push(chunk);
  }
  try {
    return { value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { invalid: true };
  }
}

const STATUS_FOR = { auth: 502, conflict: 409, "not-found": 502, unavailable: 502 };

export function createApp(config, { github = createGitHub(config), log = console.log } = {}) {
  let saving = Promise.resolve(); // one save at a time

  async function getWatchlist(res) {
    const { data, sha } = await github.read();
    const watchlist = validateWatchlist(data);
    send(res, 200, { watchlist, sha, repo: config.repo, branch: config.branch });
  }

  /** Only this page may change things: the request must come from the same origin. */
  function fromThisPage(req) {
    try {
      return typeof req.headers.origin === "string" && new URL(req.headers.origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  async function getStatus(res) {
    const latest = await github.latestRun();
    send(res, 200, { everyMinutes: config.checkEveryMinutes, latest });
  }

  async function postCheck(req, res) {
    if (!fromThisPage(req)) return send(res, 403, { error: "This request did not come from the watchlist page." });
    req.resume();
    const latest = await github.latestRun();
    const age = latest ? minutesSince(latest.createdAt) : Infinity;
    if (age < CHECK_NOW_MIN_GAP_MINUTES) {
      return send(res, 429, { error: "A check started a moment ago. Give it a few minutes.", latest });
    }
    await github.startRun();
    log("started a check on request");
    send(res, 202, { started: true });
  }

  async function putWatchlist(req, res) {
    if (!fromThisPage(req)) return send(res, 403, { error: "This request did not come from the watchlist page." });
    if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      return send(res, 415, { error: "Send JSON." });
    }

    const body = await readJsonBody(req);
    if (body.tooLarge) return send(res, 413, { error: "The watchlist is too large." });
    if (body.invalid || body.value === null || typeof body.value !== "object") {
      return send(res, 400, { error: "The request is not valid JSON." });
    }
    const { watchlist: submitted, sha } = body.value;
    if (sha !== null && (typeof sha !== "string" || !/^[0-9a-f]{40,64}$/.test(sha))) {
      return send(res, 400, { error: "The request does not say which version it started from." });
    }

    let watchlist;
    try {
      watchlist = validateWatchlist(submitted);
    } catch (error) {
      if (error instanceof ConfigError) return send(res, 422, { error: error.message });
      throw error;
    }

    const run = saving.then(async () => {
      const current = await github.read();
      if (current.sha !== sha) throw new GitHubError("conflict", "the watchlist changed on GitHub since this page loaded it");
      const before = validateWatchlist(current.data);
      if (JSON.stringify(before) === JSON.stringify(watchlist)) return { sha: current.sha, unchanged: true };
      const message = describeChange(before, watchlist);
      const written = await github.write(watchlist, sha, message);
      log(`saved: ${message}`);
      return written;
    });
    saving = run.catch(() => {});
    const result = await run;
    send(res, 200, { watchlist, sha: result.sha, unchanged: result.unchanged === true });
  }

  return async function handle(req, res) {
    try {
      if (!hostAllowed(req.headers.host, config)) {
        return send(res, 421, { error: "This host name is not allowed. Add it to ALLOWED_HOSTS." });
      }
      const url = new URL(req.url, "http://localhost");

      if (url.pathname === "/api/watchlist") {
        if (req.method === "GET") return await getWatchlist(res);
        if (req.method === "PUT") return await putWatchlist(req, res);
        return send(res, 405, { error: "Method not allowed." }, { allow: "GET, PUT" });
      }
      if (url.pathname === "/api/status") {
        if (req.method === "GET") return await getStatus(res);
        return send(res, 405, { error: "Method not allowed." }, { allow: "GET" });
      }
      if (url.pathname === "/api/check") {
        if (req.method === "POST") return await postCheck(req, res);
        return send(res, 405, { error: "Method not allowed." }, { allow: "POST" });
      }
      if (url.pathname === "/api/health") {
        return send(res, 200, { ok: true });
      }

      const file = STATIC[url.pathname];
      if (file && (req.method === "GET" || req.method === "HEAD")) {
        const content = await fs.readFile(path.join(HERE, file[0]));
        return send(res, 200, req.method === "HEAD" ? "" : content, {
          "content-type": file[1],
          "cache-control": "no-cache",
        });
      }
      return send(res, 404, { error: "Not found." });
    } catch (error) {
      if (error instanceof GitHubError) {
        return send(res, STATUS_FOR[error.kind] ?? 502, { error: error.message, kind: error.kind });
      }
      if (error instanceof ConfigError) {
        // The file on GitHub does not pass validation: say so instead of showing an empty list.
        return send(res, 502, { error: `The watchlist on GitHub is not valid: ${error.message}`, kind: "invalid" });
      }
      log(`unexpected error: ${error?.stack ?? error}`);
      return send(res, 500, { error: "Something went wrong on the server. Its log has the details." });
    }
  };
}

export function startServer(config, options = {}) {
  const github = options.github ?? createGitHub(config);
  const log = options.log ?? console.log;
  const server = http.createServer(createApp(config, { github, log }));
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;

  const scheduler = createScheduler({ github, everyMinutes: config.checkEveryMinutes ?? 0, log });
  server.on("close", () => scheduler.stop());

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      if (options.schedule !== false) scheduler.start();
      resolve(server);
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = loadWebConfig();
    const server = await startServer(config);
    const { port } = server.address();
    console.log(`Watchlist page on http://${config.host}:${port} (edits ${config.watchlistPath} in ${config.repo}, branch ${config.branch})`);
    console.log(
      config.checkEveryMinutes > 0
        ? `Keeping the checks going: a run of ${config.workflowFile} is started when none began in the last ${config.checkEveryMinutes} minutes.`
        : "Not starting checks from here (CHECK_EVERY_MINUTES=0); GitHub's own schedule is on its own.",
    );
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
  } catch (error) {
    console.error(error instanceof ConfigError ? `Configuration problem: ${error.message}` : error);
    process.exit(2);
  }
}

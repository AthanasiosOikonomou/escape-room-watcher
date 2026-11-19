/**
 * Settings of the watchlist page, from environment variables.
 * Run with a file of settings: node --env-file=.env web/server.js
 */
import { ConfigError } from "../src/config.js";

const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const BRANCH = /^[A-Za-z0-9._\/-]{1,100}$/;
const FILE_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.json$/;
const HOSTNAME = /^[A-Za-z0-9.-]{1,253}$/;

export function loadWebConfig(env = process.env) {
  const token = env.GITHUB_TOKEN || "";
  if (token === "") throw new ConfigError("GITHUB_TOKEN is missing (a fine-grained token with Contents read and write on the repository)");

  const repo = env.GITHUB_REPO || "";
  if (!REPO.test(repo)) throw new ConfigError('GITHUB_REPO must look like "owner/repository"');

  const branch = env.GITHUB_BRANCH || "main";
  if (!BRANCH.test(branch) || branch.includes("..")) throw new ConfigError("GITHUB_BRANCH is not a valid branch name");

  const watchlistPath = env.WATCHLIST_PATH || "watchlist.json";
  if (!FILE_PATH.test(watchlistPath) || watchlistPath.includes("..")) {
    throw new ConfigError("WATCHLIST_PATH must be a .json file path inside the repository");
  }

  const port = Number(env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError("PORT must be a port number");

  const allowedHosts = (env.ALLOWED_HOSTS || "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  const badHost = allowedHosts.find((host) => !HOSTNAME.test(host));
  if (badHost) throw new ConfigError(`ALLOWED_HOSTS: "${badHost}" is not a host name`);

  let apiUrl;
  try {
    apiUrl = new URL(env.GITHUB_API_URL || "https://api.github.com");
  } catch {
    throw new ConfigError("GITHUB_API_URL is not a URL");
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(apiUrl.hostname);
  if (apiUrl.protocol !== "https:" && !loopback) {
    throw new ConfigError("GITHUB_API_URL must use https, so the token is never sent in the clear");
  }

  return Object.freeze({
    token,
    repo,
    branch,
    watchlistPath,
    // Loopback by default: publish it to your tailnet with `tailscale serve`, not by opening the port.
    host: env.HOST || "127.0.0.1",
    port,
    allowedHosts,
    apiBase: apiUrl.href.replace(/\/$/, ""),
  });
}

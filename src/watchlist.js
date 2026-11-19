/**
 * The watchlist: which rooms to check and what is interesting for each.
 * It is a file in the repository (watchlist.json), edited by the watchlist
 * page and read by the watcher.
 *
 *   { "version": 1,
 *     "rooms": [ { "name": "Antique",
 *                  "url": "https://www.escapeall.gr/en/EscapeRoom/Details/antique",
 *                  "paused": false,
 *                  "rules": [ { "days": ["fri","sat"], "from": "19:00", "to": "22:00" } ] } ] }
 */
import fs from "node:fs/promises";
import { ConfigError } from "./config.js";
import { ruleProblem } from "./rules.js";

const SITE_HOSTS = new Set(["www.escapeall.gr", "escapeall.gr"]);
const ROOM_PATH = /^\/(en|el)\/EscapeRoom\/Details\/[\w-]+$/;
export const MAX_ROOMS = 40;
export const MAX_RULES_PER_ROOM = 10;
export const MAX_NAME_LENGTH = 80;

/**
 * The watcher only ever opens EscapeAll room pages. Anything else in the file
 * is refused, so a bad edit cannot point a browser somewhere else.
 * @param {unknown} data parsed watchlist.json
 * @param {{ extraOrigins?: string[] }} [options] extra origins accepted (tests use a local mock site)
 * @returns {{ version: 1, rooms: { name: string, url: string, paused: boolean, rules: object[] }[] }}
 */
export function validateWatchlist(data, { extraOrigins = [] } = {}) {
  if (data === null || typeof data !== "object" || Array.isArray(data) || data.version !== 1 || !Array.isArray(data.rooms)) {
    throw new ConfigError('the watchlist must look like { "version": 1, "rooms": [...] }');
  }
  if (data.rooms.length > MAX_ROOMS) {
    throw new ConfigError(`the watchlist holds ${data.rooms.length} rooms; the limit is ${MAX_ROOMS}`);
  }

  const seen = new Set();
  const rooms = data.rooms.map((room, index) => {
    const where = `rooms[${index}]`;
    if (typeof room?.name !== "string" || room.name.trim() === "" || room.name.trim().length > MAX_NAME_LENGTH) {
      throw new ConfigError(`${where}: "name" must be 1 to ${MAX_NAME_LENGTH} characters`);
    }
    const name = room.name.trim();

    let url;
    try {
      url = new URL(room.url);
    } catch {
      throw new ConfigError(`${where} (${name}): "url" is not a valid URL`);
    }
    const onSite = url.protocol === "https:" && SITE_HOSTS.has(url.hostname);
    const plain = url.username === "" && url.password === "" && url.port === "";
    if (!((onSite && plain) || extraOrigins.includes(url.origin)) || !ROOM_PATH.test(url.pathname)) {
      throw new ConfigError(`${where} (${name}): not an EscapeAll room page: ${room.url}`);
    }
    const key = url.pathname.toLowerCase().replace(/^\/(en|el)\//, "/");
    if (seen.has(key)) throw new ConfigError(`${where} (${name}): this room is listed twice`);
    seen.add(key);

    if (room.paused !== undefined && typeof room.paused !== "boolean") {
      throw new ConfigError(`${where} (${name}): "paused" must be true or false`);
    }
    const rules = room.rules ?? [];
    if (!Array.isArray(rules) || rules.length > MAX_RULES_PER_ROOM) {
      throw new ConfigError(`${where} (${name}): "rules" must be a list of at most ${MAX_RULES_PER_ROOM} rules`);
    }
    rules.forEach((rule, ruleIndex) => {
      const problem = ruleProblem(rule);
      if (problem) throw new ConfigError(`${where} (${name}), rule ${ruleIndex + 1}: ${problem}`);
    });

    // Query strings and fragments are dropped: only the room page itself is opened.
    return { name, url: `${url.origin}${url.pathname}`, paused: room.paused === true, rules };
  });

  return { version: 1, rooms };
}

export async function loadWatchlist(file, options) {
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    throw new ConfigError(`cannot read the watchlist ${file}: ${error.message}`);
  }
  return validateWatchlist(parsed, options);
}

/** Last part of the room URL, e.g. "antique". */
export function roomSlug(room) {
  return new URL(room.url).pathname.split("/").pop().toLowerCase();
}

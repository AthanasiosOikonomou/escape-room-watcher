#!/usr/bin/env node
/**
 * Command line entry of the watcher.
 *
 *   node src/cli.js                      check every room, send Telegram messages
 *   node src/cli.js --dry-run            check every room, send nothing
 *   node src/cli.js --rooms antique,noah only these rooms (end of their URL)
 *   node src/cli.js --report out.json    also save the full result as JSON
 *
 * Environment: TELEGRAM_TOKEN, ONLY_CHAT_ID, WATCHLIST_FILE, STATE_DIR,
 * NOTIFY_MODE, PAUSE_BETWEEN_ROOMS_MS, PAUSE_RANDOM_EXTRA_MS,
 * REFUSAL_COOLDOWN_MINUTES, plus the room-check timings read by
 * escape_availability.js (DAYS_AHEAD, …). DRY_RUN=true and ONLY_ROOMS=a,b do
 * the same as --dry-run and --rooms (used by the GitHub workflow).
 *
 * Exit code: 0 clean, 1 a room failed, 2 the site refused us, 3 still cooling
 * down after an earlier refusal (the site was not contacted).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { ConfigError, loadConfig } from "./config.js";
import { cooldownMessage, readCooldown, recordRefusal } from "./cooldown.js";
import { loadWatchlist, roomSlug } from "./watchlist.js";
import { readMemory, writeMemory } from "./notify/memory.js";
import { createTelegram } from "./notify/telegram.js";

const slugList = (text) =>
  text
    .split(",")
    .map((slug) => slug.trim().toLowerCase())
    .filter(Boolean);

function parseArgs(argv, env = process.env) {
  const args = {
    dryRun: ["true", "1"].includes(String(env.DRY_RUN ?? "").toLowerCase()),
    rooms: env.ONLY_ROOMS && slugList(env.ONLY_ROOMS).length > 0 ? slugList(env.ONLY_ROOMS) : null,
    report: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--rooms" && argv[i + 1]) args.rooms = slugList(argv[++i]);
    else if (arg === "--report" && argv[i + 1]) args.report = argv[++i];
    else throw new ConfigError(`unknown or incomplete argument: ${arg}`);
  }
  return args;
}

async function run(argv, { roomOptions } = {}) {
  const args = parseArgs(argv);
  const config = loadConfig();
  const watchlist = await loadWatchlist(config.watchlistFile, roomOptions);
  let rooms = watchlist.rooms.filter((room) => !room.paused);
  const paused = watchlist.rooms.length - rooms.length;

  if (args.rooms) {
    const unknown = args.rooms.filter((slug) => !rooms.some((room) => roomSlug(room) === slug));
    if (unknown.length > 0) throw new ConfigError(`not on the watchlist (or paused): ${unknown.join(", ")}`);
    rooms = rooms.filter((room) => args.rooms.includes(roomSlug(room)));
  }
  if (rooms.length === 0) {
    console.log(`Nothing to check: the watchlist has no active rooms${paused ? ` (${paused} paused)` : ""}.`);
    return 0;
  }

  const cooldown = await readCooldown(config.stateDir, config.refusalCooldownMinutes);
  if (cooldown.active) {
    console.log(`⏸  ${cooldownMessage(cooldown)}`);
    return 3;
  }

  const telegram = args.dryRun
    ? { enabled: false, send: async () => false }
    : createTelegram({ token: config.telegramToken, chatId: config.telegramChatId });

  const mode = args.dryRun ? "dry run, nothing is sent" : telegram.enabled ? "Telegram on" : "Telegram not configured";
  console.log(`🚀 Checking ${rooms.length} room(s)${paused ? `, ${paused} paused` : ""} (${mode}, messages: ${config.notifyMode})`);

  // Loaded here, after the settings were validated: importing the room check starts nothing by itself.
  const { exitCodeFor, runWatch } = await import("./watcher.js");
  // A dry run neither reads nor changes what was last sent.
  const memory = args.dryRun ? {} : await readMemory(config.stateDir);
  const report = await runWatch({ rooms, config, telegram, memory });
  if (!args.dryRun) {
    await writeMemory(config.stateDir, memory, watchlist.rooms.map((room) => room.url));
  }
  if (report.blocked) {
    await recordRefusal(config.stateDir, {
      detail: report.blocked,
      retryAfterSeconds: report.refusal?.retryAfterSeconds ?? null,
      room: report.results.at(-1).name,
    });
  }

  const s = report.summary;
  console.log(
    `\nDone in ${Math.round(report.durationMs / 1000)} s: ${s.withFreeSlots} with free slots, ${s.nothingFree} with nothing free, ` +
      `${s.removed} removed, ${s.errors} failed${report.blocked ? `, STOPPED by the site with ${report.skipped.length} room(s) unchecked` : ""}.`,
  );

  if (args.report) {
    await fs.mkdir(path.dirname(path.resolve(args.report)), { recursive: true });
    await fs.writeFile(args.report, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Report saved to ${args.report}`);
  }
  return exitCodeFor(report);
}

export async function main(argv = process.argv.slice(2), options) {
  try {
    process.exitCode = await run(argv, options);
  } catch (error) {
    if (error instanceof ConfigError) console.error(`Configuration problem: ${error.message}`);
    else console.error(error);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

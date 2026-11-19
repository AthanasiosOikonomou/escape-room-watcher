/**
 * One watch run: check each room in turn, report free slots.
 *
 * How a room is checked is the original logic in escape_availability.js and is
 * not decided here. This file adds the care around it:
 *  - one room at a time, with an extra pause between rooms;
 *  - a refusal (403/429/challenge) stops the run at once and is never retried;
 *  - a removed room and a failed check are reported as such, not as "nothing free".
 */
import { processRoom } from "../escape_availability.js";
import { SiteRefusal } from "./site/refusal.js";
import { isoFromDayMonthYear } from "./dates.js";
import { signatureOf } from "./notify/memory.js";
import { escapeHtml, formatNothingLeftMessage, formatRoomMessage } from "./notify/telegram.js";
import { applyRules } from "./rules.js";

export const Outcome = Object.freeze({
  OK: "ok", // checked; `days` holds the free slots (possibly none)
  REMOVED: "removed", // the room page no longer exists
  BLOCKED: "blocked", // the site refused us
  ERROR: "error", // the check failed for another reason
});

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** { "19/11/2026": ["19:00", "21:15"] } -> [{ date: "2026-11-19", slots: [{ time: "19:00" }, …] }], by date. */
export function daysFromAvailability(availability) {
  const days = [];
  for (const [label, times] of Object.entries(availability ?? {})) {
    const date = isoFromDayMonthYear(label);
    if (!date || !Array.isArray(times) || times.length === 0) continue;
    days.push({ date, slots: times.map((time) => ({ time: String(time) })) });
  }
  return days.sort((a, b) => a.date.localeCompare(b.date));
}

function refusalAlert(result, checked, total, skipped) {
  const wait = result.refusal?.retryAfterSeconds;
  return (
    `⛔ <b>Escape room watcher stopped</b>\n\n` +
    `EscapeAll refused the request (${escapeHtml(result.detail)}) after ${checked} of ${total} rooms. ` +
    `Nothing was retried. ${skipped} room(s) were not checked.` +
    (wait ? `\nThe site asks to wait ${wait} seconds.` : "")
  );
}

/**
 * @param {object} run
 * @param {{ name: string, url: string, rules?: object[] }[]} run.rooms
 * @param {Record<string, string>} [run.memory] room URL -> what was last sent; updated in place
 * @param {ReturnType<import("./config.js").loadConfig>} run.config
 * @param {{ send: (text: string) => Promise<boolean> }} run.telegram
 * @param {(line: string) => void} [run.log]
 * @param {(ms: number) => Promise<void>} [run.sleep]
 * @param {(room: { name: string, url: string }) => Promise<{ availability: object|null, removed: string|null }>} [run.checkRoom]
 */
export async function runWatch({ rooms, config, telegram, memory = {}, log = console.log, sleep = realSleep, checkRoom = processRoom }) {
  const startedAt = new Date();
  const results = [];
  let blocked = null;

  for (const [index, room] of rooms.entries()) {
    if (index > 0) {
      await sleep(config.pauseBetweenRoomsMs + Math.floor(Math.random() * (config.pauseRandomExtraMs + 1)));
    }

    const started = Date.now();
    const result = {
      name: room.name,
      url: room.url,
      outcome: Outcome.ERROR,
      detail: null,
      refusal: null,
      startedAt: new Date(started).toISOString(),
      durationMs: 0,
      days: [],
      freeSlotsBeforeRules: 0,
      notified: false,
    };

    try {
      const checked = await checkRoom(room);
      if (checked.removed) {
        result.outcome = Outcome.REMOVED;
        result.detail = checked.removed;
      } else if (checked.availability === null) {
        result.detail = "the check failed, see the log above";
      } else {
        result.outcome = Outcome.OK;
        const all = daysFromAvailability(checked.availability);
        result.freeSlotsBeforeRules = all.reduce((sum, day) => sum + day.slots.length, 0);
        result.days = applyRules(all, room.rules);
      }
    } catch (error) {
      if (error instanceof SiteRefusal) {
        result.outcome = Outcome.BLOCKED;
        result.detail = error.message;
        result.refusal = error.details;
      } else {
        result.detail = error instanceof Error ? error.message : String(error);
      }
    }
    result.durationMs = Date.now() - started;
    results.push(result);

    if (result.outcome === Outcome.OK) {
      const signature = signatureOf(result.days);
      const lastSent = memory[room.url];
      const slotCount = result.days.reduce((sum, day) => sum + day.slots.length, 0);
      const outsideRules = result.freeSlotsBeforeRules - slotCount;
      const aside = outsideRules > 0 ? ` (${outsideRules} more outside your rules)` : "";

      if (slotCount > 0 && (config.notifyMode === "always" || signature !== lastSent)) {
        log(`✅ ${room.name}: ${slotCount} matching free slot(s) on ${result.days.length} day(s)${aside}`);
        result.notified = await telegram.send(formatRoomMessage(room, result.days));
        if (result.notified) memory[room.url] = signature;
      } else if (slotCount > 0) {
        log(`✅ ${room.name}: ${slotCount} matching free slot(s), same as the last message, not sent again${aside}`);
      } else if (lastSent && config.notifyMode === "on-change") {
        log(`·  ${room.name}: the slots from the last message are gone${aside}`);
        result.notified = await telegram.send(formatNothingLeftMessage(room));
        if (result.notified) memory[room.url] = "";
      } else {
        log(`·  ${room.name}: nothing free that fits${aside}`);
        memory[room.url] = "";
      }
    } else if (result.outcome === Outcome.REMOVED) {
      log(`⚠️ ${room.name}: room page is gone (${result.detail})`);
    } else if (result.outcome === Outcome.BLOCKED) {
      const wait = result.refusal?.retryAfterSeconds;
      log(`⛔ ${room.name}: the site refused the request (${result.detail}${wait ? `, retry after ${wait} s` : ""}). Stopping this run.`);
      blocked = result.detail;
      break;
    } else {
      log(`❌ ${room.name}: ${result.detail}`);
    }
  }

  const skipped = rooms.slice(results.length).map((room) => room.name);
  if (blocked) {
    await telegram.send(refusalAlert(results.at(-1), results.length - 1, rooms.length, skipped.length));
  }

  const count = (outcome) => results.filter((r) => r.outcome === outcome).length;
  return {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    blocked,
    refusal: blocked ? results.at(-1).refusal : null,
    skipped,
    summary: {
      rooms: rooms.length,
      withFreeSlots: results.filter((r) => r.outcome === Outcome.OK && r.days.length > 0).length,
      nothingFree: results.filter((r) => r.outcome === Outcome.OK && r.days.length === 0).length,
      removed: count(Outcome.REMOVED),
      errors: count(Outcome.ERROR),
      blocked: count(Outcome.BLOCKED),
    },
    results,
  };
}

/** 0 = clean run, 1 = at least one room failed, 2 = the site refused us. */
export function exitCodeFor(report) {
  if (report.blocked) return 2;
  return report.summary.errors > 0 ? 1 : 0;
}

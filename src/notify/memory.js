/**
 * Remembers, per room, the slots that were last sent to Telegram, so the same
 * list is not sent again on every run. If the memory is missing (first run,
 * or the stored copy expired) the watcher simply sends again.
 */
import fs from "node:fs/promises";
import path from "node:path";

export const MEMORY_FILE = "notified.json";

/** A stable text for a list of days and slots; "" when there is nothing. */
export function signatureOf(days) {
  return days.map((day) => `${day.date} ${day.slots.map((slot) => slot.time).join(",")}`).join("|");
}

/** @returns {Promise<Record<string, string>>} room URL -> signature of what was last sent */
export async function readMemory(stateDir) {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(stateDir, MEMORY_FILE), "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === "string"));
  } catch {
    return {};
  }
}

/** Keeps only rooms that are still on the watchlist. */
export async function writeMemory(stateDir, memory, roomUrls) {
  const kept = Object.fromEntries(Object.entries(memory).filter(([url]) => roomUrls.includes(url)));
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(path.join(stateDir, MEMORY_FILE), `${JSON.stringify(kept, null, 2)}\n`);
}

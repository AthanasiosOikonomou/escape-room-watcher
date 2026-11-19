/**
 * After the site refuses us, nothing contacts it again until a cool-down has
 * passed. The refusal is written to a small state file so the rule also holds
 * across separate commands and runs.
 */
import fs from "node:fs/promises";
import path from "node:path";

export const REFUSAL_FILE = "last-refusal.json";

/**
 * @returns {Promise<{ active: boolean, until: Date|null, refusal: { at: string, detail: string }|null }>}
 */
export async function readCooldown(stateDir, cooldownMinutes, now = new Date()) {
  let refusal;
  try {
    refusal = JSON.parse(await fs.readFile(path.join(stateDir, REFUSAL_FILE), "utf8"));
  } catch {
    return { active: false, until: null, refusal: null };
  }
  const at = new Date(refusal?.at);
  if (Number.isNaN(at.getTime())) return { active: false, until: null, refusal: null };

  // The site's own Retry-After wins when it asks for longer than our default.
  const minutes = Math.max(cooldownMinutes, Math.ceil((Number(refusal.retryAfterSeconds) || 0) / 60));
  const until = new Date(at.getTime() + minutes * 60_000);
  return { active: now < until, until, refusal };
}

export async function recordRefusal(stateDir, { detail, retryAfterSeconds = null, room = null }, now = new Date()) {
  await fs.mkdir(stateDir, { recursive: true });
  const body = { at: now.toISOString(), detail, retryAfterSeconds, room };
  await fs.writeFile(path.join(stateDir, REFUSAL_FILE), `${JSON.stringify(body, null, 2)}\n`);
}

/** "12:08" in Athens, for messages. */
export function athensClock(date) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Athens", hour: "2-digit", minute: "2-digit" }).format(date);
}

export function cooldownMessage(cooldown) {
  return (
    `The site refused us at ${athensClock(new Date(cooldown.refusal.at))} (${cooldown.refusal.detail}). ` +
    `Not contacting it again before ${athensClock(cooldown.until)} Athens time.`
  );
}

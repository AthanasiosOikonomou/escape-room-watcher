/**
 * Settings of the watcher, from environment variables. The timing of a single
 * room check (DAYS_AHEAD, STAGGER_MS, MIN_DELAY_BETWEEN_ROOMS_MS, …) is read
 * by escape_availability.js itself and is unchanged.
 */

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

function integer(env, name, fallback, { min, max }) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be a whole number between ${min} and ${max}, got "${raw}"`);
  }
  return value;
}

function oneOf(env, name, fallback, allowed) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!allowed.includes(raw)) {
    throw new ConfigError(`${name} must be one of ${allowed.join(", ")}, got "${raw}"`);
  }
  return raw;
}

export function loadConfig(env = process.env) {
  return Object.freeze({
    telegramToken: env.TELEGRAM_TOKEN || null,
    telegramChatId: env.ONLY_CHAT_ID || null,
    watchlistFile: env.WATCHLIST_FILE || "watchlist.json",
    /**
     * "on-change": a room's message is sent when its list of matching free
     * slots differs from the last one sent. "always": sent on every run.
     * Either way the message lists every matching free slot.
     */
    notifyMode: oneOf(env, "NOTIFY_MODE", "on-change", ["on-change", "always"]),
    /** Where the watcher keeps its small state files. */
    stateDir: env.STATE_DIR || ".state",
    /**
     * Extra pause between two rooms, on top of the pauses of the room check
     * itself: this much, plus a random extra. On 2026-11-19 ten page loads in
     * about a minute were answered with HTTP 429, so the floor is not zero.
     */
    pauseBetweenRoomsMs: integer(env, "PAUSE_BETWEEN_ROOMS_MS", 8000, { min: 5000, max: 600_000 }),
    pauseRandomExtraMs: integer(env, "PAUSE_RANDOM_EXTRA_MS", 4000, { min: 0, max: 600_000 }),
    /** After a refusal (403/429), nothing contacts the site for this long. */
    refusalCooldownMinutes: integer(env, "REFUSAL_COOLDOWN_MINUTES", 60, { min: 15, max: 1440 }),
  });
}

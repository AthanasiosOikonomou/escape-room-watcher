/**
 * Keeps the checks coming. GitHub's own scheduler is free to be late or to
 * skip runs, so this looks at the last run every few minutes and starts one
 * when none began within the interval. Runs started by GitHub's schedule or
 * by hand count too, so the two never pile up, and a restart of this service
 * never causes an extra run.
 */

const LOOK_EVERY_MS = 5 * 60_000;
const FIRST_LOOK_AFTER_MS = 20_000;

export function minutesSince(isoTime, now = new Date()) {
  const then = new Date(isoTime).getTime();
  return Number.isNaN(then) ? Infinity : (now.getTime() - then) / 60_000;
}

/**
 * @param {object} options
 * @param {{ latestRun: () => Promise<object|null>, startRun: () => Promise<void> }} options.github
 * @param {number} options.everyMinutes
 * @param {(line: string) => void} [options.log]
 */
export function createScheduler({ github, everyMinutes, log = console.log, now = () => new Date() }) {
  let lastProblem = null;
  let timers = [];

  /** One look: start a run if it is due. Returns what it did, for tests and logs. */
  async function tick() {
    try {
      const latest = await github.latestRun();
      const age = latest ? minutesSince(latest.createdAt, now()) : Infinity;
      if (age < everyMinutes) {
        lastProblem = null;
        return "not-due";
      }
      await github.startRun();
      lastProblem = null;
      log(`started a check (last one ${latest ? `${Math.round(age)} minutes ago` : "never"})`);
      return "started";
    } catch (error) {
      // Say it once, not every five minutes.
      if (error.message !== lastProblem) log(`could not keep the checks going: ${error.message}`);
      lastProblem = error.message;
      return "failed";
    }
  }

  return {
    tick,
    start() {
      if (everyMinutes <= 0 || timers.length > 0) return;
      const first = setTimeout(tick, FIRST_LOOK_AFTER_MS);
      const every = setInterval(tick, LOOK_EVERY_MS);
      first.unref();
      every.unref();
      timers = [first, every];
    },
    stop() {
      for (const timer of timers) clearTimeout(timer);
      timers = [];
    },
  };
}

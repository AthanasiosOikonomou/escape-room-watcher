// How one room is checked on the site. This is the original, proven logic:
// a fresh browser per room, the room page loaded once, the calendar days
// clicked one by one. The only additions are (1) reading the HTTP status so a
// refusal or a removed room is not mistaken for "no availability", and (2) not
// discarding the slots of a day that was already selected before the click.
// Everything around it (room list, pacing between rooms, cool-down, Telegram,
// reports) lives in src/. Running this file starts the watcher: see src/cli.js.
import puppeteer from "puppeteer";
import { pathToFileURL } from "node:url";
import { assertRoomPageServed, RoomGone, SiteRefusal } from "./src/site/refusal.js";

// Politeness and Speed Configuration (Optimized)
const DAYS_AHEAD = Number(process.env.DAYS_AHEAD ?? 14);
const STAGGER_START_MS = Number(process.env.STAGGER_MS ?? 1500);
const MIN_DELAY_BETWEEN_CHECKS_MS = Number(
  process.env.MIN_DELAY_BETWEEN_ROOMS_MS ?? 2500
);
const RANDOM_EXTRA_DELAY_MS = Number(process.env.RANDOM_EXTRA_DELAY_MS ?? 1500);
const DAY_CHECK_BASE_MS = Number(process.env.DAY_CHECK_BASE_MS ?? 1000);
const DAY_CHECK_JITTER_MS = Number(process.env.DAY_CHECK_JITTER_MS ?? 900);
const TIME_LIST_WAIT_MS = Number(process.env.TIME_LIST_WAIT_MS ?? 2500);
const GLOBAL_MIN_REQUEST_INTERVAL_MS = Number(
  process.env.GLOBAL_MIN_REQUEST_INTERVAL_MS ?? 1500
);

// CRITICAL: Fast fail if the calendar doesn't load quickly
const CALENDAR_WAIT_TIMEOUT_MS = 2500;

// --- Global Rate Limiter (State and Function) ---
let _lastRequestAt = 0;
async function enforceGlobalRateLimit() {
  if (GLOBAL_MIN_REQUEST_INTERVAL_MS <= 0) return;
  const now = Date.now();
  const nextAllowed = _lastRequestAt + GLOBAL_MIN_REQUEST_INTERVAL_MS;
  if (now < nextAllowed) {
    const wait = nextAllowed - now;
    // console.log(`(rate-limit) waiting ${wait}ms to respect global interval`);
    await sleep(wait);
  }
  _lastRequestAt = Date.now();
}

// --- Utility Functions ---
function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function randomInt(max) {
  return Math.floor(Math.random() * Math.max(1, Math.floor(max)));
}

function generateUserAgent() {
  const agents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15",
  ];
  return agents[randomInt(agents.length)];
}

async function withRetries(fn, attempts = 3, baseDelay = 1000) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      // A refusal or a removed room is an answer, not a glitch: never retry it.
      if (err instanceof SiteRefusal || err instanceof RoomGone) throw err;
      if (attempt === attempts) throw err;
      const wait = baseDelay * Math.pow(2, attempt - 1) + randomInt(500);
      console.warn(
        `Retry ${attempt}/${attempts} after ${wait}ms: ${err.message}`
      );
      await sleep(wait);
    }
  }
}

// === Date format helpers ===
const dateFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});
const formatDay = (d) => d.getDate().toString();
const formatMonth = (d) => (d.getMonth() + 1).toString();
const formatYear = (d) => d.getFullYear().toString();

// === Puppeteer: Check availability for one room ===
async function checkRoomAvailability(page, room) {
  console.log(`\n🔍 Checking room: ${room.name} (${room.url})`);
  const today = new Date();

  await page.setUserAgent(generateUserAgent());

  await withRetries(
    async () => {
      await enforceGlobalRateLimit();
      const response = await page.goto(room.url, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await assertRoomPageServed(response); // throws SiteRefusal or RoomGone
    },
    3,
    2000
  );

  await sleep(randomInt(500) + 200);

  const dateCellSelector =
    ".dateCell, .date-cell, [data-day], .time-selection, .calendar";

  try {
    await page.waitForSelector(dateCellSelector, {
      timeout: CALENDAR_WAIT_TIMEOUT_MS,
    });
  } catch (e) {
    return {};
  }

  const roomAvailability = {};
  const timeSelectionSelector = ".time-selection";

  // Set initial HTML content of the time slot container
  let lastKnownTimeHTML = await page
    .$eval(timeSelectionSelector, (el) => el.innerHTML)
    .catch(() => "");

  for (let offset = 0; offset <= DAYS_AHEAD; offset++) {
    const date = new Date(today);
    date.setDate(today.getDate() + offset);

    const dayStart = Date.now();
    const [day, month, year] = dateFormatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => part.value);

    const dateStr = `${day}/${month}/${year}`;

    const daySelector = `[data-day="${formatDay(
      date
    )}"][data-month="${formatMonth(date)}"][data-year="${formatYear(date)}"]`;
    const dayElement = await page.$(daySelector);

    if (!dayElement) {
      continue;
    }

    const isDisabled = await page.evaluate(
      (el) =>
        el.classList.contains("disabled") ||
        el.classList.contains("unavailable") ||
        el.getAttribute("aria-disabled") === "true",
      dayElement
    );

    if (isDisabled) {
      continue;
    }

    await dayElement.evaluate((el) =>
      el.scrollIntoView({
        behavior: "smooth",
        block: "center",
        inline: "center",
      })
    );

    await sleep(randomInt(300) + 50);

    // On first load the page already shows today's slots, so clicking today
    // changes nothing; that is not stale data.
    const alreadySelected = await dayElement.evaluate((el) =>
      el.classList.contains("selected-day")
    );

    try {
      await enforceGlobalRateLimit();
      await withRetries(() => dayElement.click(), 2, 300);
    } catch (e) {
      console.warn(`Click failed for ${dateStr} on ${room.name}`);
      continue;
    }

    // --- Wait for Time Slot Update (Mitigating Stale Data) ---
    const expectedChange = lastKnownTimeHTML;
    let timeListUpdated = false;

    try {
      await page.waitForFunction(
        (selector, prevHTML) => {
          const el = document.querySelector(selector);
          return el && el.innerHTML !== prevHTML;
        },
        { timeout: TIME_LIST_WAIT_MS },
        timeSelectionSelector,
        expectedChange
      );
      timeListUpdated = true;
    } catch (e) {
      if (alreadySelected) {
        timeListUpdated = true;
      } else {
        console.log(`[STALE DATA] Time slot list for ${dateStr} did not change.`);
      }
    }

    // CRITICAL: Update the last known HTML for the next loop iteration.
    lastKnownTimeHTML = await page
      .$eval(timeSelectionSelector, (el) => el.innerHTML)
      .catch(() => "");

    // --- Scrape Available Slots ---
    const availableSlots = await page.evaluate(
      (sel, isStale) => {
        const listItems = [...document.querySelectorAll(sel)];

        // Check for explicit "No Slots" messages in the list
        const noSlotsMessage = listItems.some(
          (li) =>
            li.textContent.trim().toLowerCase().includes("no availability") ||
            li.textContent.trim().toLowerCase().includes("fully booked")
        );

        if (isStale && !noSlotsMessage && listItems.length > 0) {
          // If the update timed out (isStale=true) AND we didn't see a clear "fully booked"
          // message, we defensively assume the slots are from a previous date and drop them.
          return [];
        }

        return listItems
          .filter(
            (li) =>
              !li.classList.contains("disabled") &&
              !li.classList.contains("list-group-item-danger") &&
              !li.textContent.trim().toLowerCase().includes("not available") &&
              li.textContent.trim().length > 0
          )
          .map((li) => li.textContent.trim().slice(0, 5));
      },
      `${timeSelectionSelector} li`,
      !timeListUpdated
    ); // Pass update status

    if (availableSlots.length > 0) {
      roomAvailability[dateStr] = availableSlots;
      console.log(
        `✅ ${room.name} - ${dateStr}: Slots → ${availableSlots.join(", ")}`
      );
    } else if (timeListUpdated) {
      // Log a message ONLY if the list updated but was empty.
      console.log(
        `[Empty] ${room.name} - ${dateStr}: List updated but no slots found.`
      );
    }

    const dayElapsed = Date.now() - dayStart;
    await sleep(
      Math.max(
        100,
        DAY_CHECK_BASE_MS + randomInt(DAY_CHECK_JITTER_MS) - dayElapsed
      )
    );
  }

  return roomAvailability;
}

// === Room Processing Function (Isolated Browser) ===
const processRoom = async (room) => {
  let browser;
  let page;
  let availability = {};
  let removed = null;

  try {
    const stagger = STAGGER_START_MS + randomInt(RANDOM_EXTRA_DELAY_MS);
    await sleep(stagger);

    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    page = await browser.newPage();

    availability = await withRetries(
      () => checkRoomAvailability(page, room),
      2,
      1000
    );
  } catch (err) {
    if (err instanceof SiteRefusal) throw err; // the caller stops the whole run
    if (err instanceof RoomGone) {
      removed = err.message;
    } else {
      console.error(`❌ Fatal Error checking room ${room.name}:`, err.message);
      availability = null;
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  await sleep(MIN_DELAY_BETWEEN_CHECKS_MS + randomInt(RANDOM_EXTRA_DELAY_MS));

  return { roomName: room.name, availability, removed };
};

export { processRoom };

// --- Main Execution ---
// `node escape_availability.js` keeps working: it starts the watcher.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { main } = await import("./src/cli.js");
  await main();
}

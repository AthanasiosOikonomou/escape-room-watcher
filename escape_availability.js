import puppeteer from "puppeteer";
import fs from "fs/promises";
import pLimit from "p-limit";
import axios from "axios";

// --- Configuration ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ONLY_CHAT_ID = process.env.ONLY_CHAT_ID;
const ROOMS_FILE = "./roomsToWatch.json";

// Politeness and Speed Configuration (Optimized)
const DAYS_AHEAD = Number(process.env.DAYS_AHEAD ?? 14);
const MAX_CONCURRENT_ROOMS = Number(process.env.MAX_CONCURRENT_REQUESTS ?? 1); // Keeping concurrency low for debugging stability
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

const CALENDAR_WAIT_TIMEOUT_MS = 2500;

// --- Global Rate Limiter (State and Function) ---
let _lastRequestAt = 0;
async function enforceGlobalRateLimit() {
  if (GLOBAL_MIN_REQUEST_INTERVAL_MS <= 0) return;
  const now = Date.now();
  const nextAllowed = _lastRequestAt + GLOBAL_MIN_REQUEST_INTERVAL_MS;
  if (now < nextAllowed) {
    const wait = nextAllowed - now;
    await sleep(wait);
  }
  _lastRequestAt = Date.now();
}

// --- Telegram & Utility Functions (Unchanged) ---
const TELEGRAM_API = TELEGRAM_TOKEN
  ? `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`
  : null;

async function sendToTelegram(message) {
  if (!TELEGRAM_API || !ONLY_CHAT_ID) {
    console.log(
      "(telegram) skipping send — TELEGRAM_TOKEN or ONLY_CHAT_ID missing"
    );
    return;
  }
  try {
    await axios.post(TELEGRAM_API, {
      chat_id: ONLY_CHAT_ID,
      text: message,
      parse_mode: "HTML",
    });
    console.log(`✅ Sent message to chat ID: ${ONLY_CHAT_ID}`);
  } catch (err) {
    console.error(`❌ Failed to send message to ${ONLY_CHAT_ID}:`, err.message);
  }
}

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
      if (attempt === attempts) throw err;
      const wait = baseDelay * Math.pow(2, attempt - 1) + randomInt(500);
      console.warn(
        `Retry ${attempt}/${attempts} after ${wait}ms: ${err.message}`
      );
      await sleep(wait);
    }
  }
}

// === Date format helpers (Unchanged) ===
const today = new Date();
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
  // console.log(`\n🔍 Checking room: ${room.name} (${room.url})`);

  await page.setUserAgent(generateUserAgent());

  await withRetries(
    async () => {
      await enforceGlobalRateLimit();
      await page.goto(room.url, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
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

  // Set a variable to hold the HTML content of the time slot container
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

    try {
      await enforceGlobalRateLimit();
      await withRetries(() => dayElement.click(), 2, 300);
    } catch (e) {
      console.warn(`Click failed for ${dateStr} on ${room.name}`);
      continue;
    }

    // --- Wait for Time Slot Update (Improved) ---
    try {
      // Wait until the inner HTML of the time list is different from the last known state.
      await page.waitForFunction(
        (selector, prevHTML) => {
          const el = document.querySelector(selector);
          // Only return true if element exists AND the HTML has changed
          return el && el.innerHTML !== prevHTML;
        },
        { timeout: TIME_LIST_WAIT_MS },
        timeSelectionSelector,
        lastKnownTimeHTML
      );
    } catch (e) {
      // Timeout - the content may have not changed, or loaded too slowly.
    }

    // After waiting, we must update the last known HTML *before* scraping slots.
    // This new HTML will be the baseline for the next day's check.
    lastKnownTimeHTML = await page
      .$eval(timeSelectionSelector, (el) => el.innerHTML)
      .catch(() => "");

    // --- Scrape Available Slots ---
    const availableSlots = await page.evaluate((sel) => {
      const listItems = [...document.querySelectorAll(sel)];
      return (
        listItems
          .filter(
            (li) =>
              // IMPORTANT: Filter by class/text that indicates availability
              !li.classList.contains("disabled") &&
              !li.classList.contains("list-group-item-danger") &&
              !li.textContent.trim().toLowerCase().includes("not available") &&
              li.textContent.trim().length > 0
          )
          // Extract the time and ensure only the first 5 characters are taken (e.g., "19:10")
          .map((li) => li.textContent.trim().slice(0, 5))
      );
    }, `${timeSelectionSelector} li`);

    if (availableSlots.length > 0) {
      roomAvailability[dateStr] = availableSlots;
      console.log(
        `✅ ${room.name} - ${dateStr}: Slots → ${availableSlots.join(", ")}`
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

// === Room Processing Function (Isolated Browser - Unchanged) ===
const processRoom = async (room, limit) => {
  let browser;
  let page;
  let availability = {};

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
    console.error(`❌ Fatal Error checking room ${room.name}:`, err.message);
    availability = null;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  await sleep(MIN_DELAY_BETWEEN_CHECKS_MS + randomInt(RANDOM_EXTRA_DELAY_MS));

  return { roomName: room.name, availability };
};

// --- Main Execution (Unchanged) ---
(async () => {
  console.log("🚀 Starting concurrent availability check...");

  try {
    const roomsData = await fs.readFile(ROOMS_FILE, "utf8");
    const rooms = JSON.parse(roomsData);

    const limit = pLimit(MAX_CONCURRENT_ROOMS);

    const results = await Promise.all(
      rooms.map((room) => limit(() => processRoom(room, limit)))
    );

    // 3. Reporting
    for (const { roomName, availability } of results) {
      if (!availability || Object.keys(availability).length === 0) {
        console.log(
          `🛑 No availability found for room: ${roomName}, skipping message.`
        );
        continue;
      }

      let message = `🏠 <b>${roomName}</b>\n\nAvailable slots:\n`;
      for (const [dateStr, slots] of Object.entries(availability)) {
        message += `\n<b>${dateStr}</b>: ${slots.join(", ")}`;
      }

      // await sendToTelegram(message);
    }

    console.log("✅ Concurrent availability check complete.");
  } catch (error) {
    console.error(
      "A critical error occurred in the main script:",
      error.message
    );
  }
})();

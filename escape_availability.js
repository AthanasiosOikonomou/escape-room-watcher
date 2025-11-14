import puppeteer from "puppeteer";
import fs from "fs";
import pLimit from "p-limit";
import axios from "axios";

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ONLY_CHAT_ID = process.env.ONLY_CHAT_ID;
const ROOMS_FILE = "./roomsToWatch.json";

// Configuration - tweak these for politeness vs speed
const DAYS_AHEAD = process.env.DAYS_AHEAD ? Number(process.env.DAYS_AHEAD) : 14; // check up to N days ahead (0..N)
const MAX_CONCURRENT_REQUESTS = process.env.MAX_CONCURRENT_REQUESTS
  ? Number(process.env.MAX_CONCURRENT_REQUESTS)
  : 1; // how many pages in parallel (conservative)
const STAGGER_MS = process.env.STAGGER_MS
  ? Number(process.env.STAGGER_MS)
  : 3500; // stagger start between rooms (~3.5s, human-like)
const MIN_DELAY_BETWEEN_ROOMS_MS = process.env.MIN_DELAY_BETWEEN_ROOMS_MS
  ? Number(process.env.MIN_DELAY_BETWEEN_ROOMS_MS)
  : 4500; // wait at least this between room checks (~4.5s)
const RANDOM_EXTRA_DELAY_MS = process.env.RANDOM_EXTRA_DELAY_MS
  ? Number(process.env.RANDOM_EXTRA_DELAY_MS)
  : 1500; // additional random delay (up to ~1.5s)
// Per-day timing (tweak to speed up or be more polite)
const DAY_CHECK_BASE_MS = process.env.DAY_CHECK_BASE_MS
  ? Number(process.env.DAY_CHECK_BASE_MS)
  : 2000; // base pause between checking days (~2s)
const DAY_CHECK_JITTER_MS = process.env.DAY_CHECK_JITTER_MS
  ? Number(process.env.DAY_CHECK_JITTER_MS)
  : 1500; // jitter added to base per-day pause (~0-1.5s)
const TIME_LIST_WAIT_MS = process.env.TIME_LIST_WAIT_MS
  ? Number(process.env.TIME_LIST_WAIT_MS)
  : 1500; // how long to wait for time list to change after clicking (ms)
// Global rate limit to avoid temporary bans. This enforces a minimum interval
// between any two requests that likely hit the server (navigation or day click).
const GLOBAL_MIN_REQUEST_INTERVAL_MS = process.env
  .GLOBAL_MIN_REQUEST_INTERVAL_MS
  ? Number(process.env.GLOBAL_MIN_REQUEST_INTERVAL_MS)
  : 2000; // default ~2s between server-impacting requests (human-like)

let _lastRequestAt = 0;
async function enforceGlobalRateLimit() {
  if (!GLOBAL_MIN_REQUEST_INTERVAL_MS || GLOBAL_MIN_REQUEST_INTERVAL_MS <= 0)
    return;
  const now = Date.now();
  const nextAllowed = _lastRequestAt + GLOBAL_MIN_REQUEST_INTERVAL_MS;
  if (now < nextAllowed) {
    const wait = nextAllowed - now;
    console.log(`(rate-limit) waiting ${wait}ms to respect global interval`);
    await sleep(wait);
  }
  _lastRequestAt = Date.now();
}
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

// === Date format helpers ===
const today = new Date();
const formatDay = (d) => d.getDate().toString();
const formatMonth = (d) => (d.getMonth() + 1).toString();
const formatYear = (d) => d.getFullYear().toString();

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function randomInt(max) {
  return Math.floor(Math.random() * Math.max(1, Math.floor(max)));
}

function generateUserAgent() {
  const agents = [
    // short list; extend as needed
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  ];
  return agents[randomInt(agents.length)];
}

async function withRetries(fn, attempts = 3, baseDelay = 1000) {
  let attempt = 0;
  while (attempt < attempts) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt >= attempts) throw err;
      const wait = baseDelay * Math.pow(2, attempt - 1) + randomInt(500);
      console.warn(
        `Retry ${attempt}/${attempts} after ${wait}ms: ${err.message}`
      );
      await sleep(wait);
    }
  }
}

// === Puppeteer: Check availability for one room (collect data, no sending here) ===
async function checkRoomAvailability(page, room) {
  console.log(`\n🔍 Checking room: ${room.name}`);

  await withRetries(
    async () => {
      // respect global rate limiter before navigation
      await enforceGlobalRateLimit();
      await page.goto(room.url, { waitUntil: "networkidle2", timeout: 30000 });
    },
    3,
    1500
  );

  // If `.dateCell` is missing it likely means booking is not available for this room right now.
  // In that case skip this room instead of retrying.
  try {
    await page.waitForSelector(".dateCell", { timeout: 8000 });
  } catch (err) {
    console.warn(
      `.dateCell not found for ${room.name}; skipping room (likely not open for booking)`
    );
    return {}; // skip this room
  }

  const roomAvailability = {}; // { "DD/MM/YYYY": ["HH:mm", ...] }

  for (let offset = 0; offset <= DAYS_AHEAD; offset++) {
    const date = new Date(today);
    date.setDate(today.getDate() + offset);

    const dayStart = Date.now();

    const day = formatDay(date);
    const month = formatMonth(date);
    const year = formatYear(date);
    const dateStr = `${day}/${month}/${year}`;

    const daySelector = `.dateCell[data-day="${day}"][data-month="${month}"][data-year="${year}"]`;
    const dayElement = await page.$(daySelector);

    if (!dayElement) {
      console.log(`❌ Day ${dateStr} not found for ${room.name}`);
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
      console.log(`⛔ Day ${dateStr} is disabled/unavailable for ${room.name}`);
      continue;
    }

    await dayElement.evaluate((el) =>
      el.scrollIntoView({ behavior: "auto", block: "center", inline: "center" })
    );

    try {
      // clicking the day usually triggers a network request to fetch times — throttle
      await enforceGlobalRateLimit();
      await withRetries(
        () => page.evaluate((el) => el.click(), dayElement),
        2,
        500
      );
    } catch (e) {
      console.warn(`click failed for ${dateStr} on ${room.name}`);
    }

    const prevHTML = await page
      .$eval(".time-selection", (el) => el.innerHTML)
      .catch(() => "");

    try {
      await page.waitForFunction(
        (prev) => {
          const el = document.querySelector(".time-selection");
          return el && el.innerHTML !== prev;
        },
        { timeout: TIME_LIST_WAIT_MS },
        prevHTML
      );
    } catch {
      // timeout - maybe no change, proceed to read
    }

    const availableSlots = await page.evaluate(() => {
      const listItems = [...document.querySelectorAll(".time-selection li")];
      return listItems
        .filter(
          (li) =>
            !li.classList.contains("disabled") &&
            !li.classList.contains("list-group-item-danger") &&
            !li.textContent.trim().toLowerCase().includes("not available")
        )
        .map((li) => li.textContent.trim().slice(0, 5));
    });

    if (availableSlots.length > 0) {
      roomAvailability[dateStr] = availableSlots;
      console.log(
        `✅ ${room.name} - ${dateStr}: Slots → ${availableSlots.join(", ")}`
      );
    } else {
      console.log(`⛔ ${room.name} - ${dateStr}: No slots available`);
    }

    // small polite pause between days so UI has time to settle
    const dayElapsed = Date.now() - dayStart;
    await sleep(
      Math.max(0, DAY_CHECK_BASE_MS + randomInt(DAY_CHECK_JITTER_MS))
    );
    console.log(`⏱️ ${room.name} - checked ${dateStr} in ${dayElapsed}ms`);
  }

  return roomAvailability; // return all found availability for this room
}

// === Main ===
(async () => {
  console.log("🚀 Starting availability check...");

  const rooms = JSON.parse(fs.readFileSync(ROOMS_FILE, "utf8"));

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const limit = pLimit(MAX_CONCURRENT_REQUESTS);

  const results = await Promise.all(
    rooms.map((room, idx) =>
      limit(async () => {
        // Stagger starts so we don't hammer the site when launched for many rooms
        const stagger = idx * STAGGER_MS + randomInt(RANDOM_EXTRA_DELAY_MS);
        await sleep(stagger);

        const page = await browser.newPage();
        await page.setUserAgent(generateUserAgent());
        try {
          const availability = await withRetries(
            () => checkRoomAvailability(page, room),
            2,
            1000
          );

          // Polite pause after finishing a room to reduce request rate
          await sleep(
            MIN_DELAY_BETWEEN_ROOMS_MS + randomInt(RANDOM_EXTRA_DELAY_MS)
          );

          return { roomName: room.name, availability };
        } catch (err) {
          console.error(`❌ Error checking room ${room.name}:`, err.message);
          return { roomName: room.name, availability: null };
        } finally {
          await page.close();
        }
      })
    )
  );

  await browser.close();

  // Compose and send grouped messages per room
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

    await sendToTelegram(message);
  }

  console.log("✅ Availability check complete.");
})();

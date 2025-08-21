import puppeteer from "puppeteer";
import fs from "fs";
import pLimit from "p-limit";
import axios from "axios";

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ONLY_CHAT_ID = process.env.ONLY_CHAT_ID;
const MAX_CONCURRENT_REQUESTS = 3;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;

const ROOMS_FILE = "./roomsToWatch.json";

async function sendToTelegram(message) {
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

// === Puppeteer: Check availability for one room (collect data, no sending here) ===
async function checkRoomAvailability(page, room) {
  console.log(`\n🔍 Checking room: ${room.name}`);
  await page.goto(room.url, { waitUntil: "networkidle2" });
  await page.waitForSelector(".dateCell");

  const roomAvailability = {}; // { "DD/MM/YYYY": ["HH:mm", ...] }

  for (let offset = 0; offset <= 14; offset++){
    const date = new Date(today);
    date.setDate(today.getDate() + offset);

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
    await page.evaluate((el) => el.click(), dayElement);

    const prevHTML = await page
      .$eval(".time-selection", (el) => el.innerHTML)
      .catch(() => "");

    try {
      await page.waitForFunction(
        (prev) => {
          const el = document.querySelector(".time-selection");
          return el && el.innerHTML !== prev;
        },
        { timeout: 3000 },
        prevHTML
      );
    } catch {
      // timeout - no change
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
  }

  return roomAvailability; // return all found availability for this room
}

// === Main ===
(async () => {
  console.log("🚀 Starting availability check...");

  const rooms = JSON.parse(fs.readFileSync(ROOMS_FILE, "utf8"));

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox']
});

  const limit = pLimit(MAX_CONCURRENT_REQUESTS);

  const results = await Promise.all(
    rooms.map((room) =>
      limit(async () => {
        const page = await browser.newPage();
        try {
          const availability = await checkRoomAvailability(page, room);

           // 🕒 Add random delay between 1–3 seconds
          await new Promise(res => setTimeout(res, 1000 + Math.random() * 2000));
          
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

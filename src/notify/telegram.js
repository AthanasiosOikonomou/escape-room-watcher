/**
 * Telegram delivery. The bot token is part of the request URL, so the URL is
 * never logged and errors are reported by status and Telegram's own description.
 */

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MAX_MESSAGE_LENGTH = 4000; // Telegram's limit is 4096

import { describeRule } from "../rules.js";

export function escapeHtml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The room name as a link to its page, so a tap opens the booking calendar. */
function roomHeading(room) {
  const name = `<b>${escapeHtml(room.name)}</b>`;
  return room.url ? `<a href="${escapeHtml(room.url)}">${name}</a>` : name;
}

function rulesLine(room) {
  if (!Array.isArray(room.rules) || room.rules.length === 0) return [];
  return [`<i>${escapeHtml(room.rules.map(describeRule).join("; "))}</i>`];
}

/** "2026-11-19" -> "Thu 19/11/2026" */
export function dayLabel(isoDate) {
  const [year, month, day] = isoDate.split("-");
  const weekday = WEEKDAYS[new Date(`${isoDate}T00:00:00Z`).getUTCDay()];
  return `${weekday} ${day}/${month}/${year}`;
}

/**
 * Every free slot of the room that fits its rules, not only what changed.
 * @param {{ name: string, url?: string, rules?: object[] }} room
 * @param {{ date: string, slots: { time: string }[] }[]} days
 */
export function formatRoomMessage(room, days) {
  const lines = [`🏠 ${roomHeading(room)}`, ...rulesLine(room), "", "Available slots:", ""];
  for (const day of days) {
    lines.push(`<b>${dayLabel(day.date)}</b>: ${day.slots.map((slot) => slot.time).join(", ")}`);
  }
  let text = lines.join("\n");
  while (text.length > MAX_MESSAGE_LENGTH && lines.length > 6) {
    lines.pop();
    text = `${lines.join("\n")}\n…`;
  }
  return text;
}

/** Sent when a room that had matching free slots has none left. */
export function formatNothingLeftMessage(room) {
  return `▫️ ${roomHeading(room)}: the slots from the last message are gone. Nothing free that fits right now.`;
}

/**
 * @param {object} options
 * @param {string|null} options.token
 * @param {string|null} options.chatId
 * @param {string} [options.apiBase]
 * @param {(line: string) => void} [options.log]
 * @returns {{ enabled: boolean, send: (text: string) => Promise<boolean> }}
 */
export function createTelegram({ token, chatId, apiBase = "https://api.telegram.org", log = console.log }) {
  if (!token || !chatId) {
    return {
      enabled: false,
      async send() {
        log("(telegram) not configured, message not sent");
        return false;
      },
    };
  }

  return {
    enabled: true,
    async send(text) {
      try {
        const response = await fetch(`${apiBase}/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: "HTML",
            disable_web_page_preview: true,
          }),
          signal: AbortSignal.timeout(15_000),
        });
        if (response.ok) return true;
        const body = await response.json().catch(() => null);
        log(`(telegram) send failed: HTTP ${response.status}${body?.description ? `, ${body.description}` : ""}`);
        return false;
      } catch (error) {
        // error.message of a fetch failure does not contain the URL.
        log(`(telegram) send failed: ${error?.name ?? "Error"}: ${error?.cause?.code ?? error?.message ?? "unknown"}`);
        return false;
      }
    },
  };
}

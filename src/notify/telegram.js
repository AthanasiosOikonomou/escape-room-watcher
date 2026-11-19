/**
 * Telegram delivery. The bot token is part of the request URL, so the URL is
 * never logged and errors are reported by status and Telegram's own description.
 */

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MAX_MESSAGE_LENGTH = 4000; // Telegram's limit is 4096
// In a group Telegram prints the bot's name directly above the text. This
// blank-looking character on a line of its own puts some air under it
// (Telegram strips ordinary leading blank lines).
const TOP_GAP = "\u2800\n";

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

/** "2026-11-19" -> "Thu 19 Nov" */
export function dayLabel(isoDate) {
  const [, month, day] = isoDate.split("-").map(Number);
  const weekday = WEEKDAYS[new Date(`${isoDate}T00:00:00Z`).getUTCDay()];
  return `${weekday} ${day} ${MONTHS[month - 1]}`;
}

/**
 * Every free slot of the room that fits its rules, not only what changed.
 * Each day is its own quote block, which Telegram draws as a small card:
 * the day in bold, the start times under it.
 * @param {{ name: string, url?: string, rules?: object[] }} room
 * @param {{ date: string, slots: { time: string }[] }[]} days
 */
export function formatRoomMessage(room, days) {
  const head = [`🏠 ${roomHeading(room)}`, ...rulesLine(room)].join("\n");
  const cards = days.map(
    (day) => `<blockquote><b>${dayLabel(day.date)}</b>\n${day.slots.map((slot) => escapeHtml(slot.time)).join("  ·  ")}</blockquote>`,
  );
  let shown = cards.length;
  const build = () => `${head}\n\n${cards.slice(0, shown).join("\n")}${shown < cards.length ? "\n…" : ""}`;
  while (build().length > MAX_MESSAGE_LENGTH && shown > 1) shown -= 1;
  return build();
}

/** The same message without any markup, for the rare case Telegram rejects the formatted one. */
export function plainText(html) {
  return html
    .replace(/<\/blockquote>\n?/g, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .trim();
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
      const post = (body) =>
        fetch(`${apiBase}/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, disable_web_page_preview: true, ...body }),
          signal: AbortSignal.timeout(15_000),
        });
      try {
        let response = await post({ text: `${TOP_GAP}${text}`, parse_mode: "HTML" });
        if (response.status === 400) {
          // Telegram could not read the formatting: the content matters more than the looks.
          const said = await response.json().catch(() => null);
          log(`(telegram) formatted message rejected (${said?.description ?? "HTTP 400"}), sending it as plain text`);
          response = await post({ text: plainText(text) });
        }
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

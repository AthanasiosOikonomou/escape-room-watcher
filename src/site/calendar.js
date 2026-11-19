/**
 * Reading the calendar a room page has already loaded.
 *
 * A bookable room page fetches its whole calendar by itself, once, right after
 * it loads (GET /api/Reservation). Listening for that answer sends nothing to
 * the site and loads nothing extra; it only reads what the page received:
 *   [{ Day, Month, Year, PastDate, AvailabilityTimeSlotList: [{ Name, Quantity, NotSelectable }] }]
 * Name is the start time, sometimes followed by markup; Quantity 1 = free.
 */

const RESERVATION_PATH = "/api/Reservation";
const TIME_AT_START = /^\s*(\d{1,2}):(\d{2})/;

function isCalendarRequest(request) {
  try {
    return request.method() === "GET" && new URL(request.url()).pathname === RESERVATION_PATH;
  } catch {
    return false;
  }
}

/** Resolves `requested` when the page asks for its calendar and `response` when the answer arrives. */
export function watchCalendar(page) {
  let onRequest;
  let onResponse;
  const requested = new Promise((resolve) => {
    onRequest = (request) => {
      if (isCalendarRequest(request)) resolve(true);
    };
  });
  const response = new Promise((resolve) => {
    onResponse = (res) => {
      if (isCalendarRequest(res.request())) resolve(res);
    };
  });
  page.on("request", onRequest);
  page.on("response", onResponse);
  return {
    requested,
    response,
    stop: () => {
      page.off("request", onRequest);
      page.off("response", onResponse);
    },
  };
}

/** Resolves with the promise's value, or with null after `ms`. */
export async function within(promise, ms) {
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {unknown} payload parsed calendar answer
 * @param {{ day: number, month: number, year: number, label: string }[]} wantedDays the days to report, with the label to report them under
 * @returns {Record<string, string[]>|null} label -> free start times; null when the payload is not the calendar we know
 */
export function availabilityFromCalendar(payload, wantedDays) {
  if (!Array.isArray(payload) || payload.length === 0) return null;

  const byDate = new Map();
  for (const entry of payload) {
    if (![entry?.Year, entry?.Month, entry?.Day].every(Number.isInteger)) return null;
    if (!Array.isArray(entry.AvailabilityTimeSlotList)) return null;
    byDate.set(`${entry.Year}-${entry.Month}-${entry.Day}`, entry);
  }

  const availability = {};
  for (const { day, month, year, label } of wantedDays) {
    const entry = byDate.get(`${year}-${month}-${day}`);
    if (!entry || entry.PastDate === true) continue;
    const times = [];
    for (const slot of entry.AvailabilityTimeSlotList) {
      if (!(Number(slot?.Quantity) > 0) || slot?.NotSelectable === true) continue;
      const match = TIME_AT_START.exec(String(slot.Name ?? ""));
      if (match) times.push(`${match[1].padStart(2, "0")}:${match[2]}`);
    }
    if (times.length > 0) availability[label] = times;
  }
  return availability;
}

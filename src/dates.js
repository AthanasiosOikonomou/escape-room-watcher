/** Calendar date in Athens as "YYYY-MM-DD", whatever the machine's own time zone is. */
export function athensDate(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Athens",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** "19/11/2026" (as the room check reports days) -> "2026-11-19"; null if it is not such a date. */
export function isoFromDayMonthYear(text) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(text));
  return match ? `${match[3]}-${match[2]}-${match[1]}` : null;
}

/**
 * Per-room preferences: on which days and at which start hours a slot is
 * interesting. A room without rules accepts every slot; with rules, a slot is
 * kept when at least one rule accepts it.
 *
 * Rule: { days?: ["mon",…], from?: "19:00", to?: "22:00", dateFrom?: "2026-12-20", dateTo?: "2027-01-06" }
 * Every part is optional; a missing part does not restrict.
 *
 * The site lists after-midnight slots under the evening they belong to
 * ("00:30" in Saturday's list is the Saturday night session). So times before
 * 06:00 count as late night, after 23:59 of that day, for slots and for rule
 * bounds alike: { from: "21:00", to: "01:00" } means 21:00 until 01:00 at night.
 */

export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const LATE_NIGHT_BEFORE_MINUTES = 6 * 60;

/** Minutes on the "evening clock": 19:00 -> 1140, 00:30 -> 1470. Null if not HH:MM. */
export function eveningMinutes(time) {
  const match = TIME.exec(String(time));
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes < LATE_NIGHT_BEFORE_MINUTES ? minutes + 24 * 60 : minutes;
}

function isRealDate(text) {
  if (typeof text !== "string" || !ISO_DATE.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

/**
 * @param {unknown} rule
 * @returns {string|null} what is wrong with the rule, or null when it is valid
 */
export function ruleProblem(rule) {
  if (rule === null || typeof rule !== "object" || Array.isArray(rule)) return "a rule must be an object";
  const known = new Set(["days", "from", "to", "dateFrom", "dateTo"]);
  const extra = Object.keys(rule).find((key) => !known.has(key));
  if (extra) return `unknown rule field "${extra}"`;

  if (rule.days !== undefined) {
    if (!Array.isArray(rule.days) || rule.days.some((day) => !WEEKDAYS.includes(day))) {
      return `"days" must be a list of ${WEEKDAYS.join(", ")}`;
    }
    if (new Set(rule.days).size !== rule.days.length) return `"days" lists a day twice`;
  }
  for (const key of ["from", "to"]) {
    if (rule[key] !== undefined && eveningMinutes(rule[key]) === null) return `"${key}" must be a time like 19:00`;
  }
  if (rule.from !== undefined && rule.to !== undefined && eveningMinutes(rule.from) > eveningMinutes(rule.to)) {
    return `"from" (${rule.from}) is after "to" (${rule.to})`;
  }
  for (const key of ["dateFrom", "dateTo"]) {
    if (rule[key] !== undefined && !isRealDate(rule[key])) return `"${key}" must be a date like 2026-12-20`;
  }
  if (rule.dateFrom !== undefined && rule.dateTo !== undefined && rule.dateFrom > rule.dateTo) {
    return `"dateFrom" is after "dateTo"`;
  }
  return null;
}

export function weekdayOf(isoDate) {
  return WEEKDAYS[new Date(`${isoDate}T00:00:00Z`).getUTCDay()];
}

/** Does this rule accept a slot starting at `time` on `isoDate`? */
export function ruleAccepts(rule, isoDate, time) {
  if (Array.isArray(rule.days) && rule.days.length > 0 && !rule.days.includes(weekdayOf(isoDate))) return false;
  if (rule.dateFrom !== undefined && isoDate < rule.dateFrom) return false;
  if (rule.dateTo !== undefined && isoDate > rule.dateTo) return false;

  const minutes = eveningMinutes(time);
  if (minutes === null) return rule.from === undefined && rule.to === undefined;
  if (rule.from !== undefined && minutes < eveningMinutes(rule.from)) return false;
  if (rule.to !== undefined && minutes > eveningMinutes(rule.to)) return false;
  return true;
}

/**
 * @param {{ date: string, slots: { time: string }[] }[]} days
 * @param {object[]|undefined} rules
 * @returns the days and slots the rules accept (days left empty are dropped)
 */
export function applyRules(days, rules) {
  if (!Array.isArray(rules) || rules.length === 0) return days;
  const kept = [];
  for (const day of days) {
    const slots = day.slots.filter((slot) => rules.some((rule) => ruleAccepts(rule, day.date, slot.time)));
    if (slots.length > 0) kept.push({ ...day, slots });
  }
  return kept;
}

const DAY_NAMES = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
const WEEK_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** "Fri, Sat, Sun 19:00–22:00" — a short description for messages and the page. */
export function describeRule(rule) {
  const parts = [];
  const days = WEEK_ORDER.filter((day) => rule.days?.includes(day));
  parts.push(days.length === 0 || days.length === 7 ? "Any day" : days.map((day) => DAY_NAMES[day]).join(", "));
  if (rule.from !== undefined && rule.to !== undefined) parts.push(`${rule.from}–${rule.to}`);
  else if (rule.from !== undefined) parts.push(`from ${rule.from}`);
  else if (rule.to !== undefined) parts.push(`until ${rule.to}`);
  if (rule.dateFrom !== undefined || rule.dateTo !== undefined) {
    parts.push(`(${rule.dateFrom ?? "…"} to ${rule.dateTo ?? "…"})`);
  }
  return parts.join(" ");
}

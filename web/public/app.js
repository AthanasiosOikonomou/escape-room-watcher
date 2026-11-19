import { describeRule, eveningMinutes } from "/shared/rules.js";

const ROOM_LINK = /^https:\/\/(?:www\.)?escapeall\.gr\/(en|el)\/EscapeRoom\/Details\/([\w-]+)\/?(?:[?#].*)?$/i;
const WEEK = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_LABEL = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
const DAY_NAME = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };

// The strip shows 08:00 to 02:00 at night; sessions after midnight belong to the evening before.
const AXIS_START = 8 * 60;
const AXIS_END = 26 * 60;
const TIMES = [];
for (let minutes = AXIS_START; minutes <= AXIS_END; minutes += 30) {
  TIMES.push(`${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`);
}

const $ = (id) => document.getElementById(id);

/** @type {{ watchlist: object, sha: string|null }|null} */
let saved = null;
/** @type {{ name: string, url: string, paused: boolean, rules: object[] }[]} */
let draft = [];
let openUrl = null; // the room whose times are being edited
let busy = false;

// ---------- small helpers ----------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key in node && key !== "list") node[key] = value;
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child !== null && child !== undefined && child !== false) node.append(child);
  }
  return node;
}

function nameFromSlug(slug) {
  return slug
    .split("-")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

const slugOf = (url) => new URL(url).pathname.split("/").filter(Boolean).pop().toLowerCase();

/** A rule as the page edits it: the seven days are always spelled out. */
function ruleForEditing(rule) {
  return {
    days: Array.isArray(rule.days) && rule.days.length > 0 ? WEEK.filter((day) => rule.days.includes(day)) : [...WEEK],
    from: rule.from,
    to: rule.to,
    dateFrom: rule.dateFrom,
    dateTo: rule.dateTo,
  };
}

/** A rule as it is saved: nothing that does not restrict. */
function ruleForSaving(rule) {
  const out = {};
  if (rule.days.length < 7) out.days = WEEK.filter((day) => rule.days.includes(day));
  for (const key of ["from", "to", "dateFrom", "dateTo"]) if (rule[key]) out[key] = rule[key];
  return out;
}

function ruleProblem(rule) {
  if (rule.days.length === 0) return "Pick at least one day.";
  if (rule.from && rule.to && eveningMinutes(rule.from) > eveningMinutes(rule.to)) {
    return "This window ends before it starts. Hours after midnight count as late night of the same evening.";
  }
  if (rule.dateFrom && rule.dateTo && rule.dateFrom > rule.dateTo) return "The first date is after the last date.";
  return null;
}

function draftForSaving() {
  return {
    version: 1,
    rooms: draft.map((room) => ({
      name: room.name.trim(),
      url: room.url,
      paused: room.paused,
      rules: room.rules.map(ruleForSaving),
    })),
  };
}

function problems() {
  const list = [];
  for (const room of draft) {
    if (room.name.trim() === "") list.push(`A room has no name.`);
    if (room.rules.some(ruleProblem)) list.push(`${room.name || "A room"} has a time window to fix.`);
  }
  return list;
}

const isDirty = () => saved !== null && JSON.stringify(draftForSaving()) !== JSON.stringify(saved.watchlist);

// ---------- the week strip ----------

/** Lit stretches of one day, as [start, end] minutes on the evening clock. */
function litStretches(room, day) {
  if (room.rules.length === 0) return [[AXIS_START, AXIS_END]];
  const stretches = [];
  for (const rule of room.rules) {
    if (ruleProblem(rule) || !rule.days.includes(day)) continue;
    const start = Math.max(AXIS_START, rule.from ? eveningMinutes(rule.from) : AXIS_START);
    const end = Math.min(AXIS_END, rule.to ? eveningMinutes(rule.to) : AXIS_END);
    if (end >= start) stretches.push([start, end]);
  }
  return stretches;
}

function weekStrip(room) {
  const span = AXIS_END - AXIS_START;
  const days = WEEK.map((day) => {
    const stretches = litStretches(room, day);
    const track = el(
      "div",
      { class: "track" },
      stretches.map(([start, end]) => {
        const lit = el("i");
        lit.style.top = `${((start - AXIS_START) / span) * 100}%`;
        lit.style.height = `${((end - start) / span) * 100}%`;
        return lit;
      }),
    );
    return el("div", { class: stretches.length ? "day on" : "day" }, el("span", { text: DAY_LABEL[day] }), track);
  });
  const hours = el("div", { class: "hours" }, el("span", { text: "08:00" }), el("span", { text: "17:00" }), el("span", { text: "02:00" }));
  return el("div", { class: "week", "aria-hidden": "true" }, hours, days);
}

function whenText(room) {
  if (room.rules.length === 0) return "Any day, any time.";
  const valid = room.rules.filter((rule) => !ruleProblem(rule));
  if (valid.length === 0) return "No time window is set up correctly yet.";
  return `${valid.map((rule) => describeRule(ruleForSaving(rule))).join("; ")}.`;
}

// ---------- rendering ----------

function timeSelect(label, value, onPick, dataKey) {
  const select = el(
    "select",
    { "aria-label": label, "data-key": dataKey, onchange: (event) => onPick(event.target.value || undefined) },
    el("option", { value: "", text: "any time" }),
    TIMES.map((time) => el("option", { value: time, text: time })),
  );
  // A saved time that is not on the half hour still has to show.
  if (value && !TIMES.includes(value)) select.append(el("option", { value, text: value }));
  select.value = value ?? "";
  return select;
}

function ruleEditor(room, rule, index) {
  const change = (mutate, focusKey) => {
    mutate();
    render(focusKey);
  };
  const key = (part) => `${room.url}|${index}|${part}`;
  const setDays = (days, focusKey) => change(() => (rule.days = WEEK.filter((day) => days.includes(day))), focusKey);
  const problem = ruleProblem(rule);
  const hasDates = Boolean(rule.dateFrom || rule.dateTo || rule.showDates);

  return el(
    "div",
    { class: "rule" },
    el(
      "div",
      { class: "rule-row" },
      el("span", { text: "Days" }),
      el(
        "div",
        { class: "days", role: "group", "aria-label": "Days of the week" },
        WEEK.map((day) =>
          el("button", {
            type: "button",
            text: DAY_LABEL[day],
            "aria-label": DAY_NAME[day],
            "aria-pressed": String(rule.days.includes(day)),
            "data-key": key(day),
            onclick: () =>
              setDays(rule.days.includes(day) ? rule.days.filter((d) => d !== day) : [...rule.days, day], key(day)),
          }),
        ),
      ),
    ),
    el(
      "div",
      { class: "shortcuts" },
      el("button", { type: "button", text: "Every day", "data-key": key("all"), onclick: () => setDays(WEEK, key("all")) }),
      el("button", { type: "button", text: "Fri to Sun", "data-key": key("we"), onclick: () => setDays(["fri", "sat", "sun"], key("we")) }),
      el("button", { type: "button", text: "Mon to Thu", "data-key": key("wd"), onclick: () => setDays(["mon", "tue", "wed", "thu"], key("wd")) }),
    ),
    el(
      "div",
      { class: "rule-row" },
      el("span", { text: "Starts" }),
      el("span", { text: "from" }),
      timeSelect("Earliest start", rule.from, (value) => change(() => (rule.from = value), key("from")), key("from")),
      el("span", { text: "until" }),
      timeSelect("Latest start", rule.to, (value) => change(() => (rule.to = value), key("to")), key("to")),
    ),
    hasDates &&
      el(
        "div",
        { class: "rule-row" },
        el("span", { text: "Dates" }),
        el("span", { text: "from" }),
        el("input", {
          type: "date",
          "aria-label": "First date",
          value: rule.dateFrom ?? "",
          onchange: (event) => change(() => (rule.dateFrom = event.target.value || undefined)),
        }),
        el("span", { text: "to" }),
        el("input", {
          type: "date",
          "aria-label": "Last date",
          value: rule.dateTo ?? "",
          onchange: (event) => change(() => (rule.dateTo = event.target.value || undefined)),
        }),
      ),
    problem && el("p", { class: "rule-problem", text: problem }),
    el(
      "div",
      { class: "rule-foot" },
      hasDates
        ? el("button", {
            type: "button",
            class: "plain",
            text: "Any dates",
            "data-key": key("dates"),
            onclick: () =>
              change(() => {
                rule.dateFrom = undefined;
                rule.dateTo = undefined;
                rule.showDates = false;
              }, key("dates")),
          })
        : el("button", {
            type: "button",
            class: "plain",
            text: "Only between certain dates",
            "data-key": key("dates"),
            onclick: () => change(() => (rule.showDates = true), key("dates")),
          }),
      el("button", {
        type: "button",
        class: "plain danger",
        text: "Remove this window",
        onclick: () => change(() => room.rules.splice(index, 1), `${room.url}|add-rule`),
      }),
    ),
  );
}

function roomRow(room) {
  const open = openUrl === room.url;
  const toggleOpen = () => {
    openUrl = open ? null : room.url;
    render(`${room.url}|edit`);
  };
  const addRule = () => {
    room.rules.push(ruleForEditing({}));
    openUrl = room.url;
    render(`${room.url}|add-rule`);
  };

  const name = el("input", {
    class: "room-name",
    type: "text",
    value: room.name,
    maxLength: 80,
    "aria-label": "Room name",
    "data-key": `${room.url}|name`,
    oninput: (event) => {
      room.name = event.target.value;
      renderSaveBar();
    },
  });

  return el(
    "li",
    { class: room.paused ? "room paused" : "room" },
    el(
      "div",
      { class: "room-top" },
      name,
      room.paused && el("span", { class: "tag", text: "Paused" }),
      el(
        "div",
        { class: "room-actions" },
        el("button", {
          type: "button",
          class: "plain",
          text: open ? "Done" : "Edit times",
          "aria-expanded": String(open),
          "data-key": `${room.url}|edit`,
          onclick: toggleOpen,
        }),
        el("button", {
          type: "button",
          class: "plain",
          text: room.paused ? "Resume" : "Pause",
          "data-key": `${room.url}|pause`,
          onclick: () => {
            room.paused = !room.paused;
            render(`${room.url}|pause`);
          },
        }),
        el("button", { type: "button", class: "plain danger", text: "Remove", onclick: () => removeRoom(room) }),
      ),
    ),
    el(
      "p",
      { class: "room-link" },
      el("a", { href: room.url, target: "_blank", rel: "noopener noreferrer", text: room.url.replace(/^https:\/\/(www\.)?/, "") }),
    ),
    weekStrip(room),
    el("p", { class: "when", text: whenText(room) }),
    open &&
      el(
        "div",
        { class: "editor" },
        room.rules.map((rule, index) => ruleEditor(room, rule, index)),
        el(
          "div",
          { class: "editor-foot" },
          el("button", {
            type: "button",
            text: room.rules.length === 0 ? "Limit the days and hours" : "Add another time window",
            "data-key": `${room.url}|add-rule`,
            onclick: addRule,
          }),
        ),
      ),
  );
}

function renderSaveBar() {
  const dirty = isDirty();
  const issues = dirty ? problems() : [];
  $("savebar").hidden = !dirty;
  $("save-text").textContent = busy ? "Saving to GitHub" : issues.length ? issues[0] : "You have changes that are not saved yet.";
  $("save").disabled = busy || issues.length > 0;
  $("discard").disabled = busy;
}

function render(focusKey) {
  const list = $("rooms");
  list.replaceChildren(...draft.map(roomRow));

  const active = draft.filter((room) => !room.paused).length;
  const paused = draft.length - active;
  $("count").textContent =
    saved === null
      ? "Loading the watchlist"
      : draft.length === 0
        ? "No rooms yet"
        : `${active} ${active === 1 ? "room" : "rooms"} watched${paused ? `, ${paused} paused` : ""}`;
  $("empty").hidden = saved === null || draft.length > 0;
  renderSaveBar();

  if (focusKey) {
    const target = [...document.querySelectorAll("[data-key]")].find((node) => node.dataset.key === focusKey);
    target?.focus();
  }
}

// ---------- notices and toasts ----------

function showNotice(text, actionLabel, action) {
  const notice = $("notice");
  notice.replaceChildren(el("p", { text }), actionLabel ? el("button", { type: "button", text: actionLabel, onclick: action }) : null);
  notice.hidden = false;
}

const hideNotice = () => ($("notice").hidden = true);

let toastTimer;
function toast(text, actionLabel, action) {
  const box = $("toast");
  clearTimeout(toastTimer);
  box.replaceChildren(
    el("span", { text }),
    actionLabel
      ? el("button", {
          type: "button",
          text: actionLabel,
          onclick: () => {
            box.hidden = true;
            action();
          },
        })
      : null,
  );
  box.hidden = false;
  toastTimer = setTimeout(() => (box.hidden = true), actionLabel ? 8000 : 4000);
}

// ---------- actions ----------

function setHint(text, kind) {
  const hint = $("add-hint");
  hint.textContent = text;
  if (kind) hint.dataset.kind = kind;
  else delete hint.dataset.kind;
}

function addRoom(event) {
  event.preventDefault();
  if (saved === null) return;
  const input = $("add-url");
  let text = input.value.trim();
  if (text === "") return setHint("Paste the address of a room page first.", "error");
  if (/^(www\.)?escapeall\.gr\//i.test(text)) text = `https://${text}`;

  const match = ROOM_LINK.exec(text);
  if (!match) {
    return setHint("That is not a room page. A room link looks like https://www.escapeall.gr/en/EscapeRoom/Details/antique", "error");
  }
  const [, language, slug] = match;
  const existing = draft.find((room) => slugOf(room.url) === slug.toLowerCase());
  if (existing) return setHint(`${existing.name} is already on the list.`, "error");
  if (draft.length >= 40) return setHint("The list is full (40 rooms). Remove one first.", "error");

  const url = `https://www.escapeall.gr/${language.toLowerCase()}/EscapeRoom/Details/${slug}`;
  draft.unshift({ name: nameFromSlug(slug), url, paused: false, rules: [] });
  openUrl = url;
  input.value = "";
  setHint("Added. Check the name, set the days and hours, then save.");
  render(`${url}|name`);
}

function removeRoom(room) {
  const index = draft.indexOf(room);
  draft.splice(index, 1);
  if (openUrl === room.url) openUrl = null;
  render();
  toast(`Removed ${room.name || "the room"}.`, "Undo", () => {
    draft.splice(Math.min(index, draft.length), 0, room);
    render(`${room.url}|name`);
  });
}

function adopt(result) {
  saved = { watchlist: result.watchlist, sha: result.sha };
  draft = result.watchlist.rooms.map((room) => ({ ...room, rules: room.rules.map(ruleForEditing) }));
  $("source").textContent = `Saved in ${result.repo ?? $("source").dataset.repo} on GitHub`;
  if (result.repo) $("source").dataset.repo = result.repo;
}

async function request(method, body) {
  const response = await fetch("/api/watchlist", {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}

async function load() {
  hideNotice();
  try {
    const { ok, data } = await request("GET");
    if (!ok) throw new Error(data.error ?? "The watchlist could not be loaded.");
    adopt(data);
    openUrl = null;
    render();
  } catch (error) {
    $("count").textContent = "The watchlist could not be loaded";
    showNotice(error.message === "Failed to fetch" ? "The watchlist server is not answering." : error.message, "Try again", load);
  }
}

async function save() {
  if (busy || problems().length > 0) return;
  busy = true;
  hideNotice();
  renderSaveBar();
  try {
    const { ok, status, data } = await request("PUT", { watchlist: draftForSaving(), sha: saved.sha });
    if (ok) {
      const open = openUrl;
      adopt(data);
      openUrl = draft.some((room) => room.url === open) ? open : null;
      toast("Saved. The next check uses the new list.");
    } else if (status === 409) {
      showNotice("The list was changed somewhere else since this page loaded it. Load the latest version, then make your changes again.", "Load the latest", load);
    } else {
      showNotice(data.error ?? "The changes could not be saved.");
    }
  } catch {
    showNotice("The watchlist server is not answering. Your changes are still here; try saving again.");
  } finally {
    busy = false;
    render();
  }
}

function discard() {
  if (saved === null) return;
  adopt({ watchlist: saved.watchlist, sha: saved.sha });
  openUrl = null;
  hideNotice();
  setHint("");
  render();
}

$("add").addEventListener("submit", addRoom);
$("add-url").addEventListener("input", () => setHint(""));
$("save").addEventListener("click", save);
$("discard").addEventListener("click", discard);
window.addEventListener("beforeunload", (event) => {
  if (isDirty()) event.preventDefault();
});

load();

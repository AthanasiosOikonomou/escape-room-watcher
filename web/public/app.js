import { eveningMinutes } from "/shared/rules.js";

const ROOM_LINK = /^https:\/\/(?:www\.)?escapeall\.gr\/(en|el)\/EscapeRoom\/Details\/([\w-]+)\/?(?:[?#].*)?$/i;
const WEEK = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_LETTER = { mon: "M", tue: "T", wed: "W", thu: "T", fri: "F", sat: "S", sun: "S" };
const DAY_SHORT = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
const DAY_NAME = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };

// Start times offered: 08:00 to 02:00 at night. Sessions after midnight belong to the evening before.
const TIMES = [];
for (let minutes = 8 * 60; minutes <= 26 * 60; minutes += 30) {
  TIMES.push(`${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`);
}

const $ = (id) => document.getElementById(id);

/** @type {{ watchlist: object, sha: string|null }|null} what GitHub holds */
let saved = null;
/** @type {{ name: string, url: string, paused: boolean, rules: object[] }[]} what the page shows */
let draft = [];
/** @type {{ url: string, name: string, slots: object[] }|null} the room open in the dialog */
let editing = null;
let query = "";
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

/** A slot as the dialog edits it: the days are always spelled out. */
function slotForEditing(rule = {}) {
  return {
    days: Array.isArray(rule.days) && rule.days.length > 0 ? WEEK.filter((day) => rule.days.includes(day)) : [...WEEK],
    from: rule.from,
    to: rule.to,
    dateFrom: rule.dateFrom,
    dateTo: rule.dateTo,
    showDates: Boolean(rule.dateFrom || rule.dateTo),
  };
}

/** A slot as it is saved: only what restricts. */
function ruleFromSlot(slot) {
  const rule = {};
  if (slot.days.length < 7) rule.days = WEEK.filter((day) => slot.days.includes(day));
  for (const key of ["from", "to", "dateFrom", "dateTo"]) if (slot[key]) rule[key] = slot[key];
  return rule;
}

function slotProblem(slot) {
  if (slot.days.length === 0) return "Tick at least one day.";
  if (slot.from && slot.to && eveningMinutes(slot.from) > eveningMinutes(slot.to)) {
    return "This slot ends before it starts. Hours after midnight count as late night of the same evening.";
  }
  if (slot.dateFrom && slot.dateTo && slot.dateFrom > slot.dateTo) return "The first date is after the last date.";
  return null;
}

/** Slots that restrict nothing mean "everything", which is saved as no rules at all. */
function rulesFromSlots(slots) {
  const rules = slots.map(ruleFromSlot);
  return rules.some((rule) => Object.keys(rule).length === 0) ? [] : rules;
}

const draftForSaving = () => ({
  version: 1,
  rooms: draft.map((room) => ({ name: room.name, url: room.url, paused: room.paused, rules: room.rules })),
});

const isDirty = () => saved !== null && JSON.stringify(draftForSaving()) !== JSON.stringify(saved.watchlist);

// ---------- how a room's slots are shown in the list ----------

function shortDate(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

function timeText(rule) {
  if (rule.from && rule.to) return rule.from === rule.to ? `at ${rule.from}` : `${rule.from} to ${rule.to}`;
  if (rule.from) return `from ${rule.from}`;
  if (rule.to) return `until ${rule.to}`;
  return "any time";
}

function datesText(rule) {
  if (rule.dateFrom && rule.dateTo) return `${shortDate(rule.dateFrom)} to ${shortDate(rule.dateTo)}`;
  if (rule.dateFrom) return `from ${shortDate(rule.dateFrom)}`;
  if (rule.dateTo) return `until ${shortDate(rule.dateTo)}`;
  return "";
}

function slotLine(rule) {
  const days = Array.isArray(rule.days) && rule.days.length > 0 ? rule.days : WEEK;
  const spoken = `${days.length === 7 ? "Every day" : days.map((day) => DAY_NAME[day]).join(", ")}, ${timeText(rule)}${datesText(rule) ? `, ${datesText(rule)}` : ""}`;
  return el(
    "li",
    { class: "slot" },
    el("span", { class: "sr-only", text: spoken }),
    el(
      "span",
      { class: "dots", "aria-hidden": "true" },
      WEEK.map((day) => el("span", { class: days.includes(day) ? "dot on" : "dot", text: DAY_LETTER[day] })),
    ),
    el("span", { class: "slot-time", "aria-hidden": "true", text: timeText(rule) }),
    datesText(rule) && el("span", { class: "slot-dates", "aria-hidden": "true", text: datesText(rule) }),
  );
}

// ---------- the list ----------

function matches(room) {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  const link = ROOM_LINK.exec(q.startsWith("http") ? query.trim() : `https://${query.trim()}`);
  if (link) return slugOf(room.url) === link[2].toLowerCase();
  return room.name.toLowerCase().includes(q) || room.url.toLowerCase().includes(q);
}

function roomRow(room) {
  const rules = room.rules.length > 0 ? room.rules : [{}];
  return el(
    "li",
    { class: room.paused ? "room paused" : "room", "data-url": room.url },
    el(
      "div",
      { class: "room-top" },
      el(
        "h3",
        { class: "room-name" },
        el("a", { href: room.url, target: "_blank", rel: "noopener noreferrer", text: room.name, title: "Open this room on EscapeAll" }),
      ),
      room.paused && el("span", { class: "tag", text: "Paused" }),
      el(
        "div",
        { class: "room-actions" },
        el("button", { type: "button", class: "plain", text: "Edit slots", "data-key": `${room.url}|edit`, onclick: () => openSlots(room) }),
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
    el("ul", { class: "slots" }, rules.map(slotLine)),
  );
}

function renderSaveBar() {
  const dirty = isDirty();
  $("savebar").hidden = !dirty;
  $("save-text").textContent = busy ? "Saving to GitHub" : "You have changes that are not saved yet.";
  $("save").disabled = busy;
  $("discard").disabled = busy;
}

function render(focusKey) {
  const shown = draft.filter(matches);
  $("rooms").replaceChildren(...shown.map(roomRow));

  const active = draft.filter((room) => !room.paused).length;
  const paused = draft.length - active;
  const searching = query.trim() !== "";
  $("count").textContent =
    saved === null
      ? "Loading the watchlist"
      : draft.length === 0
        ? "No rooms yet"
        : searching
          ? `${shown.length} of ${draft.length} ${draft.length === 1 ? "room" : "rooms"}`
          : `${active} ${active === 1 ? "room" : "rooms"} watched${paused ? `, ${paused} paused` : ""}`;

  $("find").hidden = saved === null || draft.length === 0;
  const empty = $("empty");
  empty.hidden = saved === null || shown.length > 0;
  empty.textContent =
    draft.length === 0
      ? "Nothing on the list yet. Find a room on escapeall.gr, copy its address and paste it above."
      : `No room on the list matches “${query.trim()}”.`;
  renderSaveBar();

  if (focusKey) {
    [...document.querySelectorAll("[data-key]")].find((node) => node.dataset.key === focusKey)?.focus();
  }
}

// ---------- the slots dialog ----------

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

function slotEditor(slot, index) {
  const key = (part) => `slot|${index}|${part}`;
  const change = (mutate, focusKey) => {
    mutate();
    renderSlots(focusKey);
  };
  const setDays = (days, focusKey) => change(() => (slot.days = WEEK.filter((day) => days.includes(day))), focusKey);
  const problem = slotProblem(slot);
  const many = editing.slots.length > 1;

  return el(
    "fieldset",
    { class: "slot-edit" },
    many && el("legend", { text: `Slot ${index + 1}` }),
    el(
      "div",
      { class: "field" },
      el("span", { class: "field-name", id: key("days-label"), text: "Days" }),
      el(
        "div",
        { class: "checks", role: "group", "aria-labelledby": key("days-label") },
        WEEK.map((day) =>
          el(
            "label",
            { class: "check" },
            el("input", {
              type: "checkbox",
              checked: slot.days.includes(day),
              "data-key": key(day),
              "aria-label": DAY_NAME[day],
              onchange: (event) =>
                setDays(event.target.checked ? [...slot.days, day] : slot.days.filter((d) => d !== day), key(day)),
            }),
            el("span", { text: DAY_SHORT[day] }),
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
    ),
    el(
      "div",
      { class: "field" },
      el("span", { class: "field-name", text: "Start time" }),
      el(
        "div",
        { class: "range" },
        el("span", { text: "from" }),
        timeSelect("Earliest start", slot.from, (value) => change(() => (slot.from = value), key("from")), key("from")),
        el("span", { text: "until" }),
        timeSelect("Latest start", slot.to, (value) => change(() => (slot.to = value), key("to")), key("to")),
      ),
    ),
    slot.showDates &&
      el(
        "div",
        { class: "field" },
        el("span", { class: "field-name", text: "Dates" }),
        el(
          "div",
          { class: "range" },
          el("span", { text: "from" }),
          el("input", {
            type: "date",
            "aria-label": "First date",
            value: slot.dateFrom ?? "",
            "data-key": key("date-from"),
            onchange: (event) => change(() => (slot.dateFrom = event.target.value || undefined), key("date-from")),
          }),
          el("span", { text: "to" }),
          el("input", {
            type: "date",
            "aria-label": "Last date",
            value: slot.dateTo ?? "",
            "data-key": key("date-to"),
            onchange: (event) => change(() => (slot.dateTo = event.target.value || undefined), key("date-to")),
          }),
        ),
      ),
    problem && el("p", { class: "problem", text: problem }),
    el(
      "div",
      { class: "slot-foot" },
      el("button", {
        type: "button",
        class: "plain",
        text: slot.showDates ? "Any dates" : "Only between certain dates",
        "data-key": key("dates"),
        onclick: () =>
          change(() => {
            slot.showDates = !slot.showDates;
            if (!slot.showDates) {
              slot.dateFrom = undefined;
              slot.dateTo = undefined;
            }
          }, key("dates")),
      }),
      many &&
        el("button", {
          type: "button",
          class: "plain danger",
          text: "Remove this slot",
          onclick: () => change(() => editing.slots.splice(index, 1), "slots-add"),
        }),
    ),
  );
}

function renderSlots(focusKey) {
  $("slots-list").replaceChildren(...editing.slots.map(slotEditor));
  const nameMissing = $("slots-name").value.trim() === "";
  $("slots-done").disabled = nameMissing || editing.slots.some(slotProblem);
  if (focusKey) {
    [...$("slots").querySelectorAll("[data-key]")].find((node) => node.dataset.key === focusKey)?.focus();
  }
}

function openSlots(room) {
  editing = {
    url: room.url,
    name: room.name,
    slots: room.rules.length > 0 ? room.rules.map(slotForEditing) : [slotForEditing()],
  };
  $("slots-name").value = room.name;
  renderSlots();
  $("slots").showModal();
  $("slots").querySelector('input[type="checkbox"]').focus();
}

function closeSlots() {
  const url = editing?.url;
  editing = null;
  if ($("slots").open) $("slots").close();
  if (url) render(`${url}|edit`);
}

function applySlots(event) {
  event.preventDefault();
  if (!editing || $("slots-done").disabled) return;
  const room = draft.find((r) => r.url === editing.url);
  if (room) {
    room.name = $("slots-name").value.trim();
    room.rules = rulesFromSlots(editing.slots);
  }
  closeSlots();
}

// ---------- notices and toasts ----------

function showNotice(text, actionLabel, action) {
  const notice = $("notice");
  notice.replaceChildren(el("p", { text }));
  if (actionLabel) notice.append(el("button", { type: "button", text: actionLabel, onclick: action }));
  notice.hidden = false;
}

const hideNotice = () => ($("notice").hidden = true);

let toastTimer;
function toast(text, actionLabel, action) {
  const box = $("toast");
  clearTimeout(toastTimer);
  box.replaceChildren(el("span", { text }));
  if (actionLabel) {
    box.append(
      el("button", {
        type: "button",
        text: actionLabel,
        onclick: () => {
          box.hidden = true;
          action();
        },
      }),
    );
  }
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

  const room = { name: nameFromSlug(slug), url: `https://www.escapeall.gr/${language.toLowerCase()}/EscapeRoom/Details/${slug}`, paused: false, rules: [] };
  draft.unshift(room);
  input.value = "";
  setHint("");
  query = "";
  $("find-input").value = "";
  render();
  openSlots(room); // straight to the days and hours
}

function removeRoom(room) {
  const index = draft.indexOf(room);
  draft.splice(index, 1);
  render();
  toast(`Removed ${room.name}.`, "Undo", () => {
    draft.splice(Math.min(index, draft.length), 0, room);
    render(`${room.url}|edit`);
  });
}

function adopt(result) {
  saved = { watchlist: result.watchlist, sha: result.sha };
  draft = result.watchlist.rooms.map((room) => ({ ...room, rules: room.rules.map((rule) => ({ ...rule })) }));
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
    render();
  } catch (error) {
    $("count").textContent = "The watchlist could not be loaded";
    showNotice(error.message === "Failed to fetch" ? "The watchlist server is not answering." : error.message, "Try again", load);
  }
}

async function save() {
  if (busy) return;
  busy = true;
  hideNotice();
  renderSaveBar();
  try {
    const { ok, status, data } = await request("PUT", { watchlist: draftForSaving(), sha: saved.sha });
    if (ok) {
      adopt(data);
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
  adopt(saved);
  hideNotice();
  setHint("");
  render();
}

// ---------- when the rooms were last checked ----------

function ago(isoTime) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(isoTime).getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} ${hours === 1 ? "hour" : "hours"} ago` : `${Math.round(hours / 24)} days ago`;
}

function outcome(run) {
  if (run.status !== "completed") return "is still running";
  if (run.conclusion === "success") return "went fine";
  if (run.conclusion === "cancelled") return "was cancelled";
  return "failed";
}

async function loadStatus() {
  const box = $("status");
  const text = $("status-text");
  try {
    const response = await fetch("/api/status");
    const data = await response.json().catch(() => ({}));
    box.hidden = false;
    if (!response.ok) {
      text.textContent = data.error ?? "The last check cannot be shown right now.";
      $("check-now").hidden = true;
      return;
    }
    $("check-now").hidden = false;
    if (!data.latest) {
      text.textContent = "No check has run yet.";
      return;
    }
    const sentence = `The last check started ${ago(data.latest.createdAt)} and ${outcome(data.latest)}.`;
    text.replaceChildren(data.latest.url ? el("a", { href: data.latest.url, target: "_blank", rel: "noopener noreferrer", text: sentence }) : sentence);
  } catch {
    box.hidden = true;
  }
}

async function checkNow() {
  const button = $("check-now");
  button.disabled = true;
  try {
    const response = await fetch("/api/check", { method: "POST" });
    const data = await response.json().catch(() => ({}));
    toast(response.ok ? "Check started. Telegram hears about it in a few minutes." : (data.error ?? "The check could not be started."));
    setTimeout(loadStatus, 4000);
  } catch {
    toast("The watchlist server is not answering.");
  } finally {
    button.disabled = false;
  }
}

$("add").addEventListener("submit", addRoom);
$("check-now").addEventListener("click", checkNow);
$("add-url").addEventListener("input", () => setHint(""));
$("find-input").addEventListener("input", (event) => {
  query = event.target.value;
  render();
});
$("save").addEventListener("click", save);
$("discard").addEventListener("click", discard);
$("slots-form").addEventListener("submit", applySlots);
$("slots-cancel").addEventListener("click", closeSlots);
$("slots-add").addEventListener("click", () => {
  editing.slots.push(slotForEditing());
  renderSlots(`slot|${editing.slots.length - 1}|mon`);
});
$("slots-name").addEventListener("input", () => renderSlots());
// Esc and a click on the backdrop close the dialog without applying.
$("slots").addEventListener("cancel", (event) => {
  event.preventDefault();
  closeSlots();
});
$("slots").addEventListener("click", (event) => {
  // Only a real pointer click outside the dialog's box counts as "outside".
  const box = $("slots").getBoundingClientRect();
  const pointer = event.detail > 0;
  const outside = event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
  if (pointer && outside) closeSlots();
});
window.addEventListener("beforeunload", (event) => {
  if (isDirty()) event.preventDefault();
});

load();
loadStatus();
setInterval(loadStatus, 60_000);

import test from "node:test";
import assert from "node:assert/strict";

import { availabilityFromCalendar } from "../src/site/calendar.js";
import { calendarPayload } from "./helpers/mock-site.js";

const TODAY = "2026-11-19";
const wanted = (...isoDates) =>
  isoDates.map((iso) => {
    const [year, month, day] = iso.split("-").map(Number);
    return { day, month, year, label: iso.split("-").reverse().join("/") };
  });

test("free, selectable slots of the wanted days are reported under their label", () => {
  const availability = availabilityFromCalendar(
    calendarPayload(TODAY),
    wanted("2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22", "2026-12-05"),
  );
  assert.deepEqual(availability, {
    "19/11/2026": ["19:00", "21:15"], // 23:30 is booked and carries markup after the time
    "21/11/2026": ["00:30"],
    // 20/11: all booked; 22/11: its only slot is not selectable
    "05/12/2026": ["19:00"],
  });
});

test("days outside the calendar, and days the site marks as past, are skipped", () => {
  assert.deepEqual(availabilityFromCalendar(calendarPayload(TODAY), wanted("2026-10-01", "2027-01-01")), {});
  const payload = calendarPayload(TODAY).map((entry) => (entry.Day === 19 && entry.Month === 11 ? { ...entry, PastDate: true } : entry));
  assert.deepEqual(availabilityFromCalendar(payload, wanted("2026-11-19")), {});
});

test("anything that is not the known calendar gives null, so the caller can fall back", () => {
  const days = wanted("2026-11-19");
  assert.equal(availabilityFromCalendar({ days: [] }, days), null);
  assert.equal(availabilityFromCalendar([], days), null);
  assert.equal(availabilityFromCalendar("<html>", days), null);
  assert.equal(availabilityFromCalendar([{ Day: "19", Month: 11, Year: 2026, AvailabilityTimeSlotList: [] }], days), null);
  assert.equal(availabilityFromCalendar([{ Day: 19, Month: 11, Year: 2026 }], days), null);
});

test("odd slot entries are ignored rather than reported", () => {
  const payload = [
    {
      Day: 19, Month: 11, Year: 2026, PastDate: false,
      AvailabilityTimeSlotList: [
        { Name: "9:05", Quantity: 2, NotSelectable: false },
        { Name: "sold out", Quantity: 1 },
        { Name: "20:00", Quantity: "1" },
        { Name: "21:00", Quantity: 0 },
        null,
      ],
    },
  ];
  assert.deepEqual(availabilityFromCalendar(payload, wanted("2026-11-19")), { "19/11/2026": ["09:05", "20:00"] });
});

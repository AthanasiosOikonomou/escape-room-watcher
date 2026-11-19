import test from "node:test";
import assert from "node:assert/strict";

import { applyRules, describeRule, eveningMinutes, ruleAccepts, ruleProblem, weekdayOf } from "../src/rules.js";

// 2026-11-19 is a Thursday.
const THU = "2026-11-19";
const FRI = "2026-11-20";
const SAT = "2026-11-21";
const SUN = "2026-11-22";
const day = (date, ...times) => ({ date, slots: times.map((time) => ({ time })) });
const shown = (days) => days.map((d) => `${d.date} ${d.slots.map((s) => s.time).join(",")}`);

test("weekdays are taken from the calendar date", () => {
  assert.deepEqual([THU, FRI, SAT, SUN].map(weekdayOf), ["thu", "fri", "sat", "sun"]);
});

test("times before 06:00 count as late night of the same evening", () => {
  assert.equal(eveningMinutes("19:00"), 19 * 60);
  assert.equal(eveningMinutes("23:59"), 23 * 60 + 59);
  assert.equal(eveningMinutes("00:30"), 24 * 60 + 30);
  assert.equal(eveningMinutes("05:59"), 24 * 60 + 359);
  assert.equal(eveningMinutes("06:00"), 6 * 60);
  assert.equal(eveningMinutes("7pm"), null);
});

test("no rules means every slot is interesting", () => {
  const days = [day(THU, "17:45", "00:30")];
  assert.equal(applyRules(days, []), days);
  assert.equal(applyRules(days, undefined), days);
});

test("the example from the brief: Fri/Sat/Sun starting 19:00 to 22:00", () => {
  const rules = [{ days: ["fri", "sat", "sun"], from: "19:00", to: "22:00" }];
  const days = [
    day(THU, "19:00", "21:15"), // wrong day
    day(FRI, "18:30", "20:45", "23:00"),
    day(SAT, "17:45", "20:00", "22:15", "00:30"),
    day(SUN, "19:00", "22:00"), // both bounds are included
  ];
  assert.deepEqual(shown(applyRules(days, rules)), [`${FRI} 20:45`, `${SAT} 20:00`, `${SUN} 19:00,22:00`]);
});

test("a window that runs past midnight keeps the late-night session of that evening", () => {
  const rules = [{ days: ["sat"], from: "21:00", to: "01:00" }];
  const days = [day(SAT, "20:00", "22:15", "00:30"), day(SUN, "00:30")];
  assert.deepEqual(shown(applyRules(days, rules)), [`${SAT} 22:15,00:30`]);
});

test("several rules: a slot is kept when any one of them accepts it", () => {
  const rules = [{ days: ["thu"], from: "21:00" }, { days: ["sat", "sun"] }];
  const days = [day(THU, "19:00", "21:15"), day(FRI, "20:45"), day(SAT, "17:45")];
  assert.deepEqual(shown(applyRules(days, rules)), [`${THU} 21:15`, `${SAT} 17:45`]);
});

test("each part of a rule is optional and a date range limits it to a period", () => {
  assert.equal(ruleAccepts({}, THU, "03:00"), true);
  assert.equal(ruleAccepts({ to: "20:00" }, THU, "19:00"), true);
  assert.equal(ruleAccepts({ to: "20:00" }, THU, "20:01"), false);
  assert.equal(ruleAccepts({ days: [] }, THU, "19:00"), true);

  const holidays = { dateFrom: "2026-11-20", dateTo: "2026-11-21" };
  assert.deepEqual([THU, FRI, SAT, SUN].map((d) => ruleAccepts(holidays, d, "19:00")), [false, true, true, false]);
  assert.equal(ruleAccepts({ dateFrom: FRI }, SUN, "19:00"), true);
});

test("rules are validated with a message that says what is wrong", () => {
  assert.equal(ruleProblem({ days: ["fri", "sat"], from: "19:00", to: "22:00" }), null);
  assert.equal(ruleProblem({ from: "21:00", to: "01:00" }), null);
  assert.equal(ruleProblem({}), null);
  assert.match(ruleProblem("fri"), /must be an object/);
  assert.match(ruleProblem({ day: ["fri"] }), /unknown rule field "day"/);
  assert.match(ruleProblem({ days: ["Friday"] }), /"days" must be a list/);
  assert.match(ruleProblem({ days: ["fri", "fri"] }), /twice/);
  assert.match(ruleProblem({ from: "19" }), /"from" must be a time like 19:00/);
  assert.match(ruleProblem({ from: "22:00", to: "19:00" }), /is after/);
  assert.match(ruleProblem({ from: "01:00", to: "21:00" }), /is after/);
  assert.match(ruleProblem({ dateFrom: "2026-02-30" }), /"dateFrom" must be a date/);
  assert.match(ruleProblem({ dateFrom: "2026-12-02", dateTo: "2026-12-01" }), /"dateFrom" is after "dateTo"/);
});

test("rules are described in a short readable line", () => {
  assert.equal(describeRule({ days: ["sun", "fri", "sat"], from: "19:00", to: "22:00" }), "Fri, Sat, Sun 19:00–22:00");
  assert.equal(describeRule({}), "Any day");
  assert.equal(describeRule({ days: ["mon"], from: "20:00" }), "Mon from 20:00");
  assert.equal(describeRule({ to: "21:00", dateFrom: "2026-12-20", dateTo: "2027-01-06" }), "Any day until 21:00 (2026-12-20 to 2027-01-06)");
});

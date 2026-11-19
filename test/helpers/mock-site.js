/**
 * A local stand-in for escapeall.gr, shaped after what the live site was seen
 * to do on 2026-11-19: the room page renders a calendar of `.dateCell` cells,
 * its script fetches GET /api/Reservation once for the whole visible grid, and
 * the slots of the selected day are listed in `ul.time-selection`.
 */
import http from "node:http";
import { addDays, athensDate } from "../../src/dates.js";

const SERVICE_ID = "d8e430f3-c517-4f1f-81d1-ef4d2b610c19";
const LET_ME_KNOW =
  "<span class='let-me-know'>&nbsp;&nbsp;<i class='fa fa-bell-o let-me-know-bell ' aria-hidden='true'></i></span>";

function slot(time, quantity, extra = {}) {
  return {
    AfterMidnight: false,
    Name: quantity > 0 ? time : `${time}${LET_ME_KNOW}`,
    NotSelectable: false,
    OfferPriceListId: null,
    Quantity: quantity,
    TimeSlotId: `slot-${time}`,
    ...extra,
  };
}

/** 42 days starting 24 days before today, like the site's six-week grid. */
export function calendarPayload(today = athensDate()) {
  const slotsByOffset = {
    0: [slot("19:00", 1), slot("21:15", 1), slot("23:30", 0)],
    1: [slot("18:30", 0), slot("20:45", 0)],
    2: [slot("17:45", 0), slot("00:30", 1, { AfterMidnight: true })],
    3: [slot("20:00", 1, { NotSelectable: true })],
    16: [slot("19:00", 1)], // outside a 14-day window
  };
  const days = [];
  for (let offset = -24; offset < 18; offset++) {
    const [year, month, day] = addDays(today, offset).split("-").map(Number);
    const slots = offset < 0 ? [] : (slotsByOffset[offset] ?? []);
    days.push({
      ServiceId: SERVICE_ID,
      Day: day,
      Month: month,
      Year: year,
      AvailabilityTimeSlotList: slots,
      PastDate: offset < 0,
      HasAvailable: slots.some((s) => s.Quantity > 0 && !s.NotSelectable),
    });
  }
  return days;
}

function roomPage({ withBooking, clickable = true }) {
  // A room without online booking still renders the calendar template, but
  // with no data attributes and no script call: the page never asks for a calendar.
  if (!withBooking) {
    const template = Array.from({ length: 42 }, (_, i) => `<div class="dayBox${i + 1} not-available dateCell"></div>`).join("");
    return `<!DOCTYPE html><html><head><title>Mock room</title><link rel="stylesheet" href="/Content/site.css"></head><body>
      <div class="row booking-panels">${template}<ul class="list-group time-selection"></ul></div>
      <p>Coming Soon</p></body></html>`;
  }
  return `<!DOCTYPE html><html><head><title>Mock room</title><link rel="stylesheet" href="/Content/site.css"></head><body>
    <div class="row booking-panels"><div id="grid"></div><ul class="list-group time-selection"></ul></div>
    <script>
      document.addEventListener("DOMContentLoaded", async () => {
        const res = await fetch("/api/Reservation?from=2026-1-1&until=2026-2-11&ServiceId=${SERVICE_ID}&bookedBy=1&language=en&noGifts=false&queueToken=");
        if (!res.ok) return;
        const raw = await res.json();
        const days = Array.isArray(raw) ? raw : raw.days;
        const grid = document.getElementById("grid");
        const list = document.querySelector(".time-selection");
        const show = (cell, day) => {
          grid.querySelectorAll(".selected-day").forEach((c) => c.classList.remove("selected-day"));
          cell.classList.add("selected-day");
          list.innerHTML = day.AvailabilityTimeSlotList.map((s) =>
            '<li class="list-group-item ' + (s.Quantity > 0 && !s.NotSelectable ? "list-group-item-success" : "disabled") +
            ' input-lg" data-timeslot-id="' + day.Day + "-" + s.TimeSlotId + '" data-quantity="' + s.Quantity + '">' + s.Name + "</li>").join("");
        };
        let first = null;
        for (const day of days) {
          const cell = document.createElement("div");
          const state = day.PastDate ? "past-date" : day.HasAvailable ? "available" : "not-available";
          cell.className = "dateCell " + state;
          cell.textContent = day.Day;
          if (${clickable}) cell.style.cssText = "display:inline-block;width:40px;height:40px";
          Object.assign(cell.dataset, { day: day.Day, month: day.Month, year: day.Year });
          cell.addEventListener("click", () => show(cell, day));
          grid.append(cell);
          if (!first && !day.PastDate) first = [cell, day];
        }
        show(...first);
      });
    </script></body></html>`;
}

/**
 * @param {{ today?: string }} [options] the day the mock calendar treats as today ("YYYY-MM-DD")
 * @returns {Promise<{ origin: string, requests: string[], userAgents: string[], close: () => Promise<void> }>}
 */
export async function startMockSite({ today = athensDate() } = {}) {
  const requests = [];
  const userAgents = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://mock");
    requests.push(`${req.method} ${url.pathname}`);
    if (url.pathname.includes("/EscapeRoom/Details/")) userAgents.push(req.headers["user-agent"]);
    const referer = req.headers.referer ?? "";

    if (url.pathname === "/api/Reservation") {
      if (referer.includes("/api-blocked")) {
        res.writeHead(403, { "content-type": "text/html", "cf-mitigated": "challenge" });
        return res.end("<html><title>Just a moment...</title></html>");
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      // "wrapped": a calendar answer in a shape the watcher does not know.
      const payload = calendarPayload(today);
      return res.end(JSON.stringify(referer.includes("/wrapped") ? { days: payload } : payload));
    }

    const slug = url.pathname.match(/^\/en\/EscapeRoom\/Details\/([\w-]+)$/)?.[1];
    if (slug === "gone") {
      res.writeHead(302, { location: "/en" });
      return res.end();
    }
    if (url.pathname === "/Content/site.css") {
      res.writeHead(200, { "content-type": "text/css", "cache-control": "public, max-age=3600" });
      return res.end("body { margin: 0 }");
    }
    if (slug === "limited") {
      res.writeHead(429, { "content-type": "text/html", "retry-after": "120", server: "cloudflare" });
      return res.end("<html><head><title>Access denied | mock used Cloudflare to restrict access</title></head><body>error code: 1015</body></html>");
    }
    if (slug === "blocked") {
      res.writeHead(403, { "content-type": "text/html", "cf-mitigated": "challenge" });
      return res.end("<html><title>Just a moment...</title></html>");
    }
    if (slug) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      // "unclickable": day cells with no size, which a click cannot hit.
      return res.end(roomPage({ withBooking: slug !== "coming-soon", clickable: slug !== "unclickable" }));
    }
    if (url.pathname === "/en") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end("<!DOCTYPE html><html><body>Home</body></html>");
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    userAgents,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

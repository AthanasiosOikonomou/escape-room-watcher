/**
 * Reading the site's answer. This does not change what is sent to the site;
 * it only stops a refusal from being mistaken for "no availability".
 */

const REFUSAL_STATUSES = new Set([403, 429]);
const ROOM_PATH = /\/EscapeRoom\/Details\//i;

/** The site refused the request (HTTP 403/429 or a Cloudflare challenge). Never retried. */
export class SiteRefusal extends Error {
  constructor(details) {
    super(`HTTP ${details.status}${details.title ? ` "${details.title}"` : ""}`);
    this.name = "SiteRefusal";
    this.details = details;
  }
}

/** The room page no longer exists (HTTP 404, or the site redirected elsewhere). */
export class RoomGone extends Error {
  constructor(where) {
    super(where);
    this.name = "RoomGone";
  }
}

/**
 * @param {import("puppeteer").HTTPResponse|null} response the response of page.goto
 * @throws {SiteRefusal|RoomGone}
 */
export async function assertRoomPageServed(response) {
  if (!response) return;
  const status = response.status();
  const headers = response.headers();

  if (REFUSAL_STATUSES.has(status) || headers["cf-mitigated"]) {
    const seconds = Number(headers["retry-after"]);
    let title = null;
    let errorCode = null;
    try {
      const body = await response.text();
      title = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(body)?.[1].trim() ?? null;
      // Cloudflare block pages can carry a four-digit code, e.g. 1015 for rate limiting.
      errorCode = /(?:error code:?\s*|cf-error-code[^>]*>\s*|Error\s+)(1\d{3})\b/i.exec(body)?.[1] ?? null;
    } catch {
      // The body of a refused navigation is not always readable.
    }
    throw new SiteRefusal({
      status,
      title,
      errorCode,
      retryAfterSeconds: Number.isFinite(seconds) && seconds > 0 ? seconds : null,
      server: headers.server ?? null,
      cfMitigated: headers["cf-mitigated"] ?? null,
    });
  }

  let path = "";
  try {
    path = new URL(response.url()).pathname;
  } catch {
    // keep the empty path
  }
  if (status === 404 || !ROOM_PATH.test(path)) {
    throw new RoomGone(`ended at ${response.url()} (HTTP ${status})`);
  }
}

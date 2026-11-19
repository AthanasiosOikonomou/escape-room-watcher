/**
 * The one file this service reads and writes on GitHub: the watchlist.
 * The token never leaves this module and is never logged; errors carry the
 * HTTP status and GitHub's own message only.
 */

export class GitHubError extends Error {
  /** @param {"auth"|"conflict"|"not-found"|"unavailable"} kind */
  constructor(kind, message) {
    super(message);
    this.name = "GitHubError";
    this.kind = kind;
  }
}

export function createGitHub({ token, repo, branch, watchlistPath, apiBase }) {
  const fileUrl = `${apiBase}/repos/${repo}/contents/${watchlistPath.split("/").map(encodeURIComponent).join("/")}`;
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "escape-room-watchlist-page",
  };

  async function call(url, init = {}) {
    let response;
    try {
      response = await fetch(url, { ...init, headers: { ...headers, ...init.headers }, signal: AbortSignal.timeout(15_000) });
    } catch (error) {
      throw new GitHubError("unavailable", `GitHub could not be reached (${error?.cause?.code ?? error?.name ?? "network error"})`);
    }
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  }

  function fail(status, body, doing) {
    const said = typeof body?.message === "string" ? `: ${body.message.slice(0, 200)}` : "";
    if (status === 401 || status === 403) {
      return new GitHubError("auth", `GitHub refused the token while ${doing} (HTTP ${status}${said}). It needs Contents read and write on ${repo}.`);
    }
    if (status === 409 || status === 422) return new GitHubError("conflict", `the watchlist changed on GitHub while ${doing}`);
    if (status === 404) return new GitHubError("not-found", `GitHub has no ${repo} (or the token cannot see it) while ${doing}`);
    return new GitHubError("unavailable", `GitHub answered HTTP ${status} while ${doing}${said}`);
  }

  return {
    /** @returns {Promise<{ data: unknown, sha: string|null }>} sha is null when the file does not exist yet */
    async read() {
      const { status, body } = await call(`${fileUrl}?ref=${encodeURIComponent(branch)}`);
      if (status === 404 && body?.message === "Not Found") {
        // The repository answers, the file is simply not there yet: an empty watchlist.
        const repoCheck = await call(`${apiBase}/repos/${repo}`);
        if (repoCheck.status === 200) return { data: { version: 1, rooms: [] }, sha: null };
        throw fail(repoCheck.status, repoCheck.body, "reading the watchlist");
      }
      if (status !== 200 || typeof body?.content !== "string" || typeof body?.sha !== "string") {
        throw fail(status, body, "reading the watchlist");
      }
      let data;
      try {
        data = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
      } catch {
        throw new GitHubError("unavailable", `${watchlistPath} on GitHub is not valid JSON`);
      }
      return { data, sha: body.sha };
    },

    /**
     * @param {object} watchlist validated watchlist
     * @param {string|null} sha the version this edit started from (null creates the file)
     * @returns {Promise<{ sha: string }>}
     */
    async write(watchlist, sha, message) {
      const content = Buffer.from(`${JSON.stringify(watchlist, null, 2)}\n`, "utf8").toString("base64");
      const { status, body } = await call(fileUrl, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, content, branch, ...(sha ? { sha } : {}) }),
      });
      if ((status !== 200 && status !== 201) || typeof body?.content?.sha !== "string") {
        throw fail(status, body, "saving the watchlist");
      }
      return { sha: body.content.sha };
    },
  };
}

/** A one-line commit message that says what changed. */
export function describeChange(before, after) {
  const byUrl = (list) => new Map(list.rooms.map((room) => [room.url, room]));
  const old = byUrl(before);
  const now = byUrl(after);
  const added = after.rooms.filter((room) => !old.has(room.url)).map((room) => room.name);
  const removed = before.rooms.filter((room) => !now.has(room.url)).map((room) => room.name);
  const changed = after.rooms
    .filter((room) => old.has(room.url) && JSON.stringify(old.get(room.url)) !== JSON.stringify(room))
    .map((room) => room.name);

  const parts = [];
  if (added.length) parts.push(`add ${added.join(", ")}`);
  if (removed.length) parts.push(`remove ${removed.join(", ")}`);
  if (changed.length) parts.push(`update ${changed.join(", ")}`);
  if (parts.length === 0) parts.push("reorder");
  const message = `Watchlist: ${parts.join("; ")}`;
  return message.length > 160 ? `${message.slice(0, 157)}…` : message;
}

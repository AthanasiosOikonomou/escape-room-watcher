/**
 * A local stand-in for the two GitHub endpoints the watchlist page uses:
 * the repository itself and the contents of one file.
 */
import http from "node:http";
import crypto from "node:crypto";

export const TEST_TOKEN = ["github", "pat", "for", "tests"].join("_");

/**
 * @param {{ repo: string, path: string, branch?: string, initial?: object|string|null }} options
 *        initial: the file's JSON (or raw text), or null for "file does not exist yet"
 */
export async function startMockGitHub({ repo, path, branch = "main", initial = null }) {
  const shaOf = (text) => crypto.createHash("sha1").update(text).digest("hex");
  const state = {
    text: initial === null ? null : typeof initial === "string" ? initial : `${JSON.stringify(initial, null, 2)}\n`,
    commits: [],
    requests: [],
    failNextWrite: null,
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://github.mock");
    const reply = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      state.requests.push({ method: req.method, path: url.pathname, authorization: req.headers.authorization });
      if (req.headers.authorization !== `Bearer ${TEST_TOKEN}`) return reply(401, { message: "Bad credentials" });
      if (url.pathname === `/repos/${repo}`) return reply(200, { full_name: repo });
      if (url.pathname !== `/repos/${repo}/contents/${path}`) return reply(404, { message: "Not Found" });

      if (req.method === "GET") {
        if (url.searchParams.get("ref") !== branch || state.text === null) return reply(404, { message: "Not Found" });
        return reply(200, { sha: shaOf(state.text), content: Buffer.from(state.text).toString("base64"), encoding: "base64" });
      }
      if (req.method === "PUT") {
        const body = JSON.parse(raw);
        if (state.failNextWrite) {
          const failure = state.failNextWrite;
          state.failNextWrite = null;
          return reply(failure.status, { message: failure.message });
        }
        const current = state.text === null ? undefined : shaOf(state.text);
        if (body.sha !== current) return reply(409, { message: `${path} does not match ${body.sha}` });
        if (body.branch !== branch) return reply(404, { message: "Branch not found" });
        state.text = Buffer.from(body.content, "base64").toString("utf8");
        state.commits.push({ message: body.message, text: state.text });
        return reply(current ? 200 : 201, { content: { sha: shaOf(state.text) } });
      }
      return reply(405, { message: "Method not allowed" });
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    apiBase: `http://127.0.0.1:${server.address().port}`,
    state,
    sha: () => (state.text === null ? null : shaOf(state.text)),
    json: () => JSON.parse(state.text),
    /** Simulates an edit made elsewhere (another device, or a commit by hand). */
    editElsewhere(data) {
      state.text = `${JSON.stringify(data, null, 2)}\n`;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

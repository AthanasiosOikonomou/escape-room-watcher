# Deploy brief: the escape room watchlist page

This brief is self-contained. It is written for whoever sets the page up on the Debian home server, a person or an AI agent with a shell there.

## What you are installing

A small Node.js web service from the repository `AthanasiosOikonomou/escape-room-watcher` (folder `web/`). It serves one page where Sakis keeps his list of escape rooms and the days and hours he would play. When he saves, the service commits `watchlist.json` to the GitHub repository. A GitHub Actions workflow reads that file every 30 minutes and sends Telegram messages.

The service has no npm dependencies and needs no build step. It talks to `api.github.com` and to nothing else.

## Hard rules

1. Never print, log, commit or paste the GitHub token. It goes into one root-owned file and nowhere else.
2. Do not open the port to the internet or the LAN. The service listens on `127.0.0.1`; Tailscale publishes it to the tailnet.
3. Do not run `npm install` on the server and do not start the watcher (`src/cli.js`, `escape_availability.js`) there. The server never contacts escapeall.gr.
4. Do not edit files in the clone. Updates come from `git pull` only.
5. If a step fails in a way this brief does not cover, stop and report; do not improvise around it.

## Before you start (Sakis does these)

- Branch `rework` is merged into `main`, so `main` contains `watchlist.json` and the `web/` folder.
- A fine-grained personal access token exists: GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token. Repository access: **Only select repositories** → `escape-room-watcher`. Permissions: **Contents: Read and write**. Nothing else. Note the expiry date; the page stops saving when the token expires.

## Steps

### 1. Check the machine

```bash
node -v            # must be v22.12 or newer
which node         # the unit file expects /usr/bin/node
git --version
tailscale status   # must show this machine as connected
```

If Node is older or missing, install Node 24 from NodeSource or the distribution and re-check. If `which node` is not `/usr/bin/node`, adjust `ExecStart` in step 4 to the real path.

### 2. Get the code

```bash
sudo git clone https://github.com/AthanasiosOikonomou/escape-room-watcher.git /opt/escape-room-watcher
ls /opt/escape-room-watcher/web/server.js /opt/escape-room-watcher/watchlist.json
```

Both files must exist. If `web/server.js` is missing, `main` does not have the page yet: stop and report.

### 3. Store the settings

```bash
sudo install -m 600 -o root -g root /dev/null /etc/escape-room-watchlist.env
sudoedit /etc/escape-room-watchlist.env
```

Content (Sakis pastes the token himself, or hands it over out of band):

```
GITHUB_TOKEN=<the fine-grained token>
GITHUB_REPO=AthanasiosOikonomou/escape-room-watcher
GITHUB_BRANCH=main
HOST=127.0.0.1
PORT=8787
```

Check the permissions without showing the content: `sudo stat -c '%a %U' /etc/escape-room-watchlist.env` must print `600 root`.

### 4. Install and start the service

```bash
sudo cp /opt/escape-room-watcher/deploy/escape-room-watchlist.service /etc/systemd/system/
sudo systemd-analyze verify /etc/systemd/system/escape-room-watchlist.service
sudo systemctl daemon-reload
sudo systemctl enable --now escape-room-watchlist
systemctl status escape-room-watchlist --no-pager
```

The status must be `active (running)` and the log must show `Watchlist page on http://127.0.0.1:8787 (edits watchlist.json in AthanasiosOikonomou/escape-room-watcher, branch main)`.

### 5. Check it locally

```bash
curl -s http://127.0.0.1:8787/api/health
curl -s http://127.0.0.1:8787/api/watchlist | head -c 300
```

The first prints `{"ok":true}`. The second prints JSON starting with `{"watchlist":{"version":1,"rooms":[` and listing Sakis's rooms.

### 6. Publish it to the tailnet

```bash
sudo tailscale serve --bg 8787
tailscale serve status
```

`tailscale serve status` shows an `https://<machine>.<tailnet>.ts.net` address proxying to `http://127.0.0.1:8787`. That address is the page. It is reachable only from devices in Sakis's tailnet. Do not use `tailscale funnel`.

### 7. Check it end to end (Sakis, from his laptop or phone)

1. Open the `https://….ts.net` address. The list of rooms appears.
2. Pause one room and press **Save changes**. A toast says "Saved."
3. On GitHub, the repository shows a new commit "Watchlist: update <room>" by Sakis.
4. Resume the room and save again.

## If something goes wrong

| What you see | Cause | What to do |
|---|---|---|
| Service exits at once, log says `Configuration problem: …` | A setting is missing or malformed | Fix `/etc/escape-room-watchlist.env`, then `sudo systemctl restart escape-room-watchlist` |
| `/api/watchlist` returns `GitHub refused the token … (HTTP 401 or 403)` | Token wrong, expired, or without Contents read and write on this repository | Sakis issues a new token; replace it in the env file; restart |
| `/api/watchlist` returns `The watchlist on GitHub is not valid: …` | `watchlist.json` was edited by hand into a bad shape | Report the message to Sakis; do not edit the file from the server |
| Page loads in the browser but says the host name is not allowed (HTTP 421) | Opened under a name that is neither `localhost` nor `*.ts.net` | Add that name to `ALLOWED_HOSTS` in the env file; restart |
| Saving says the list was changed somewhere else | The file changed on GitHub after the page loaded it | Press **Load the latest** and redo the change |
| `systemd-analyze verify` complains about an unknown directive | Older systemd | Remove only the named directive from the copied unit file and re-run |

Logs: `journalctl -u escape-room-watchlist -n 50 --no-pager`. The log never contains the token.

## Updating later

```bash
cd /opt/escape-room-watcher && sudo git pull --ff-only && sudo systemctl restart escape-room-watchlist
```

## Report back

- Node version and path; systemd status line.
- Output of the two `curl` checks (the watchlist one truncated).
- The `tailscale serve status` output.
- Any step that did not behave as written, with the exact message. No token, ever.

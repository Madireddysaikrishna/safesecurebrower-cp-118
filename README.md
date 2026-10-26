# Vessel

Vessel is a self-hosted remote browser control system that runs entirely on your local machine. Open a web UI, click a button, and a real Chromium browser starts inside a Docker container. Its screen streams back to you live, and every click, scroll, and keystroke you make in the UI gets sent to the remote browser in real time.

Multiple users can run independent browser sessions simultaneously. Each session gets its own isolated container with dedicated resource limits, and sessions survive accidental page refreshes.

---

## What It Does

- Launches a headless Chromium browser inside a Docker container on demand
- Streams the browser screen to your web UI as a live JPEG feed at roughly 30 fps
- Forwards mouse clicks, mouse movement, scroll events, and keyboard input to the remote browser
- Lets you navigate to any URL, go back, go forward, and reload from a toolbar in the UI
- Supports multiple concurrent users (up to 5 by default), each with their own fully isolated container
- Survives page refreshes by preserving the session for 2 minutes via TTL-based reconnection
- Caps each container to 512 MB RAM and 1 CPU core to prevent any single user from crashing the host
- Automatically tears down the container when the session ends or the TTL expires
- **Authenticates every WebSocket connection** with a shared-secret token before accepting any command
- **Blocks dangerous URLs** before navigation: rejects bad schemes (`javascript:`, `file:`, `data:`), private/loopback IPv4 and IPv6 destinations, and a configurable hostname denylist; resolves hostnames pre-navigation to catch SSRF via DNS

No external services required. Everything runs on localhost.

---

## What It Does Not Do (Not Implemented)

The following features are **not present** in the current codebase:

- **URL-based phishing/malware detection** — a hostname not on the denylist is not necessarily safe. No ML or reputation service is used.
- **Data loss prevention (DLP)** — no clipboard isolation, file download interception, or content inspection policy exists.
- **HTTPS / WSS** — all communication is plain HTTP and plain WebSocket. Do not expose this to any network outside localhost.
- **Complete DNS-rebinding protection** — the pre-navigation DNS check and CDP redirect intercept reduce SSRF risk but do not prevent a server from returning a private IP *after* the TCP connection is established (true DNS rebinding). Network-level enforcement (e.g. iptables inside the container or a DNS-over-HTTPS proxy) would be required for complete protection.

---

## Architecture

The system has three distinct layers. Each layer has a single responsibility and communicates with its neighbors over WebSockets.

```
+------------------+        WebSocket        +-------------------+        WebSocket        +----------------------+
|                  |  ws://localhost:3000    |                   |  ws://localhost:300XX   |                      |
|   Browser (UI)   | <---------------------> |   Backend Server  | <---------------------> |  Docker Container    |
|   Next.js App    |                         |   Node.js/Express |                         |  Node.js + Chromium  |
|   port 3002      |                         |   port 3000       |                         |  (dynamic host port) |
|                  |                         |                   |                         |                      |
| - Renders stream |     HTTP (REST)         | - Spawns Docker   |   CDP over Puppeteer    | - Runs Puppeteer     |
| - Sends input    | GET /api/status         | - Allocates ports |                         | - Page.startScreencast
| - Stores UUID    | <---------------------> | - Routes sessions |                         | - Accepts commands   |
| - TTL reconnect  |                         | - Enforces limits |                         |                      |
+------------------+                         +-------------------+                         +----------------------+
```

The backend dynamically allocates a host port in the range 30000–40000 for each new container, so multiple containers can run simultaneously without port conflicts.

### Data Flow for a Single Frame

```
Chromium renders a frame
        |
        v
Page.screencastFrame CDP event fires (base64 JPEG)
        |
        v
browser.js sends JSON: { type: "frame", data: "<base64>" }
        |
        v
Container WebSocket server (dynamic port)
        |
        v
Backend receives the message, calls .toString() to keep it a text frame
        |
        v
Backend routes the frame to the correct frontend WebSocket via session registry
        |
        v
Frontend hook receives the message, parses JSON
        |
        v
imgRef.current.src = "data:image/jpeg;base64,..." (direct DOM update, no re-render)
        |
        v
Browser displays the frame
```

### Data Flow for a Click

```
User clicks on the stream <img> element
        |
        v
Click handler reads x, y relative to the rendered image bounds
(accounts for object-fit:contain letterboxing)
        |
        v
Normalizes to 0.0–1.0 range: { type: "click", x: 0.42, y: 0.31 }
        |
        v
Frontend sends JSON over WebSocket to backend
        |
        v
Backend logs the input and forwards to the correct container WebSocket
        |
        v
browser.js parses the message, multiplies by viewport size (1280×720)
        |
        v
Sends mouseMoved then mousePressed + mouseReleased via CDP
        |
        v
Chromium registers the click at those pixel coordinates
```

---

## Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| Frontend | Next.js 16, React 19, TypeScript | Web UI, stream rendering, input capture |
| Backend | Node.js, Express, ws | HTTP API, WebSocket relay, Docker orchestration |
| Container | Debian bookworm-slim, Node.js 20, Chromium | Headless browser runtime |
| Browser Driver | Puppeteer Core ^21 | Chromium launch and CDP access |
| Browser Protocol | Chrome DevTools Protocol (CDP) | Screen capture, input injection |
| Container Runtime | Docker (via dockerode ^4) | Spinning up, resource-limiting, and tearing down containers |
| Communication | WebSockets (ws ^8) | Real-time bidirectional messaging between all layers |
| Session Identity | UUID v4 (uuid library) | Persistent session IDs stored in `localStorage` for reconnection |

---

## Project Structure

```
vessel/
|
|-- container/
|   |-- Dockerfile           Debian + Chromium + Node.js image definition
|   |-- browser.js           WebSocket server inside the container, runs Puppeteer and CDP
|   |-- package.json         puppeteer-core + ws
|   |-- test-client.html     Minimal HTML to test the container directly (Phase 2 smoke test)
|
|-- backend/
|   |-- server.js            Express + WebSocket relay + dockerode orchestrator
|   |-- portAllocator.js     Finds free host ports in range 30000-40000, prevents race conditions
|   |-- sessionRegistry.js   In-memory Map of active and orphaned sessions keyed by UUID
|   |-- isolation-test.js    Docker isolation test harness (runs against live container)
|   |-- package.json         express + ws + dockerode + cors + uuid
|   |-- test-client.html     Phase 3 relay smoke-test page
|
|-- frontend/
|   |-- app/
|   |   |-- page.tsx         Main page: LandingView + StreamView components
|   |   |-- layout.tsx       Root layout, metadata
|   |   |-- globals.css      Full design system, light theme
|   |-- hooks/
|   |   |-- useRemoteBrowser.ts  Custom React hook, owns all WebSocket and reconnection logic
|   |-- package.json
|   |-- tsconfig.json
|
|-- .gitignore
|-- README.md
```

---

## How the Container Works

The container image is a Debian Linux environment with Chromium installed via `apt-get` and Node.js 20 installed via NodeSource.

When the container starts, `browser.js` runs. It creates a WebSocket server on port 3001 (internally) and waits. The moment the backend connects to it, it:

1. Launches Chromium using `puppeteer.launch()` with flags like `--no-sandbox` and `--disable-dev-shm-usage` required inside Docker
2. Opens a new page and sets a 1280×720 viewport
3. Navigates to Google
4. Creates a raw CDP session using `page.createCDPSession()`
5. Calls `Page.startScreencast` with JPEG format at quality 75
6. Listens for `Page.screencastFrame` events and sends each frame to the WebSocket client
7. Listens for input commands and maps them to the appropriate CDP calls

When the backend disconnects, the browser is closed. The container itself is then stopped and removed by the backend.

The reason for using `puppeteer-core` instead of `puppeteer` is image size. The full `puppeteer` package downloads its own copy of Chromium on install (around 300 MB). Since Chromium is installed through `apt-get` in the Dockerfile, only the Node.js library is needed.

### Container Hardening

Each container runs with these isolation settings (source: `backend/server.js` and `container/browser.js`):

- **Non-root user** — the process runs as the `browser` user (UID > 0), created in the Dockerfile
- **Private bridge network** — containers are placed on the `vessel-isolated` Docker bridge, which has ICC (`inter-container communication`) disabled
- **Outbound internet allowed** — NAT masquerade is enabled so Chromium can load web pages
- **Chromium flags** — WebRTC disabled (`--disable-webrtc`), geolocation disabled, webcam/mic silently denied, extensions and plugins disabled, crash reporter disabled
- **`CapDrop ALL` is intentionally not used** — dropping all Linux capabilities causes the Chromium zygote process to crash silently on startup. Isolation is achieved through non-root user, resource limits, and the network mode instead.

---

## How the Backend Works

The backend (`server.js`) has three responsibilities: HTTP API, Docker orchestration, and WebSocket routing across multiple sessions.

### Multi-Tenant Session Management

The backend handles up to 5 concurrent sessions (configurable via `MAX_SESSIONS` in `server.js`). Each connection goes through this flow:

1. The frontend connects and sends a `hello` message containing either a stored session UUID (reconnection attempt) or `null` (new session)
2. If reconnecting with a valid UUID, the backend resumes that session immediately without touching Docker
3. If starting fresh, the backend allocates a free host port via `portAllocator.js`, creates a Docker container mapped to that port, and registers the session in the `sessionRegistry`

The `portAllocator` uses `net.createServer` to test whether a port is truly free before reserving it. It maintains a `Set` of currently reserved ports to prevent race conditions when multiple users connect simultaneously.

The `sessionRegistry` is an in-memory `Map` keyed by UUID. Each entry stores the container handle, the container WebSocket, the host port, the current session status (`active` or `orphaned`), and the TTL timer handle.

### TCP Readiness Probe

After starting a container, the backend probes the allocated host port using a raw TCP socket (`net.createConnection`) until it opens. This avoids triggering a WebSocket upgrade handshake during the probe, which would launch Chromium prematurely.

### WebSocket Relay

The backend acts as a transparent relay. Container frames are forwarded to the connected frontend socket. Frontend inputs are logged and forwarded to the container socket. Each session has its own pair of sockets and they never cross.

### TTL-Based Graceful Reconnection

When a frontend WebSocket closes (for example when the user refreshes the page), the backend:

1. Marks the session as `orphaned` in the registry
2. Starts a 2-minute TTL timer using `setTimeout`
3. If the user reconnects within 2 minutes with the same UUID from `localStorage`, the timer is cancelled, the new socket is wired to the existing container, and the stream resumes
4. If the timer expires, the cleanup function runs and the container is stopped

This means a page refresh never destroys the remote browser session.

### Resource Limits (Noisy Neighbor Protection)

Every container is created with hard resource limits injected into the Docker `HostConfig` via the cgroups interface. Values are defined at the top of `backend/server.js`:

| Constant | Value | Effect |
|---|---|---|
| `CONTAINER_MEMORY_BYTES` | **512 MB** | OOM killer fires inside the container if exceeded |
| `MemorySwap` | equal to Memory | Disables swap entirely for that container |
| `CONTAINER_NANO_CPUS` | **1.0 core** | Enforced by Linux CFS scheduler |
| `CONTAINER_PIDS_LIMIT` | **512** | Prevents fork-bomb style DoS from inside the container |

These limits are enforced at the Linux kernel level. Other containers and the Node.js backend process are in separate cgroups and are completely unaffected if one container hits a limit.

---

## How the Frontend Works

The frontend is a Next.js 16 app with two visual states: a landing page and a stream view.

All WebSocket logic lives in `hooks/useRemoteBrowser.ts`, a custom React hook. The hook manages connection state, status messages, frame callbacks, and reconnection identity.

### Session Persistence

On startup, the hook checks `localStorage` for a `safebrowser_session_id` key (source: `useRemoteBrowser.ts` line 22). If one exists, it sends it in the `hello` message. If the backend confirms the session is still alive (`session_resumed`), the stream picks up immediately. If the backend reports the session expired, `localStorage` is cleared and a fresh container is booted.

The `disconnect` function explicitly removes the UUID from `localStorage`, ensuring a deliberate end session does not reconnect to the old container.

### High-Performance Frame Rendering

Incoming JPEG frames arrive at roughly 30 per second. Instead of calling `setState` for each frame (which would trigger 30 React re-renders per second), the hook stores a callback in a `useRef`. The callback directly mutates `imgRef.current.src` via a DOM reference. React never re-renders for frame updates. Only genuine state changes (connection status, errors, FPS count) go through `useState`.

### Input Handling

Keyboard input is captured by a `window.addEventListener('keydown')` listener. The listener is suppressed only when the focused element is the local URL input (`id="url-input"`). Single printable characters are sent as `{ type: "type" }` commands, which map to the `Input.insertText` CDP command. Special keys (Enter, Backspace, Tab, arrow keys) are sent as `{ type: "keydown" }` and mapped to `Input.dispatchKeyEvent`.

Mouse coordinates are normalized to a 0.0–1.0 range before being sent, with a correction for `object-fit: contain` letterboxing so clicks in the black bars are clamped to the image edge rather than mapping outside the Chromium viewport.

---

## Getting Started

### Prerequisites

- Docker Desktop installed and running (the backend connects via the Windows named pipe `//./pipe/docker_engine`)
- Node.js 18 or higher
- npm

### Step 1: Build the Container Image

```bash
cd container
docker build -t browse-container:phase2 .
```

This step takes 2–3 minutes on the first run because it downloads Chromium and Node.js. Subsequent builds use the Docker layer cache and are much faster.

### Step 2: Configure Authentication

The backend refuses to start without a shared secret, and every WebSocket client must present that secret in its `hello` message.

**Generate a strong token:**

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Create `backend/.env`** (already in `.gitignore` — never commit this file):

```
VESSEL_TOKEN=<paste-your-generated-token-here>
```

**Create `frontend/.env.local`** (already in `.gitignore`):

```
VESSEL_TOKEN=<same-token-as-above>
```

The frontend reads `VESSEL_TOKEN` through a server-side Next.js API route (`/api/token`). It is **not** prefixed with `NEXT_PUBLIC_` and is therefore never compiled into the browser JavaScript bundle. See `frontend/app/api/token/route.ts`.

> **Optional:** Override the allowed HTTP origin (default `http://localhost:3002`) by adding `ALLOWED_ORIGIN=http://your-host:3002` to `backend/.env`.

### Step 3: Start the Backend

```bash
cd backend
npm install
node server.js
```

You should see:

```
[backend] SafeBrowser backend ready
  HTTP   -> http://localhost:3000
  WS     -> ws://localhost:3000
  Status -> http://localhost:3000/api/status
  Network -> vessel-isolated
  Max sessions: 5 | Orphan TTL: 120s
```

If `VESSEL_TOKEN` is missing the process exits immediately with a clear message.

### Step 4: Start the Frontend

Open a second terminal:

```bash
cd frontend
npm install
npm run dev
```

You should see Next.js start on port 3002:

```
Local: http://localhost:3002
```

### Step 5: Open the UI

Visit `http://localhost:3002` in your browser. Click **Start Browser**. The backend will:

1. Ensure the `vessel-isolated` Docker bridge network exists
2. Allocate a free host port in the range 30000–40000
3. Spin up the Docker container mapped to that port (takes about 5–10 seconds)
4. Launch Chromium inside it, capped at 512 MB RAM and 1 CPU core
5. Start streaming frames to your browser

You will see Google load in the stream. Click anywhere on the stream to interact with it. Type to enter text. Use the URL toolbar to navigate, go back, go forward, or reload.

Click **End Session** to stop the container. Docker removes it automatically.

If you accidentally refresh the page, the session will resume automatically within 2 minutes using the UUID stored in your browser's `localStorage` under the key `safebrowser_session_id`.

### Optional: Change the Backend URL

The frontend reads `NEXT_PUBLIC_BACKEND_URL` from the environment. To point at a different backend host, add it to `frontend/.env.local`:

```
NEXT_PUBLIC_BACKEND_URL=ws://your-host:3000
```

If the variable is not set, the frontend defaults to `ws://localhost:3000`.


---

## Ports Reference

| Port | Service | Notes |
|---|---|---|
| 3000 | Backend HTTP + WebSocket | REST API and relay server |
| 3002 | Frontend (Next.js dev) | The UI you interact with (`npm run dev`) |
| 30000–40000 | Container WebSockets | Dynamically allocated per session, mapped from internal port 3001 |

---

## How Input Commands Work

The container's `browser.js` accepts the following JSON commands over its WebSocket connection:

| Command | Fields | Action |
|---|---|---|
| `hello` | `sessionId` (string or null), `token` (string) | Handshake; `token` is validated server-side before any session work proceeds |
| `navigate` | `url` | Navigate to a URL; `https://` is prepended if no scheme is present |
| `click` | `x`, `y` (normalized 0–1) | Left mouse click at that position |
| `mousemove` | `x`, `y` (normalized 0–1) | Move the mouse cursor without clicking |
| `scroll` | `x`, `y`, `deltaY` | Mouse wheel scroll |
| `type` | `text` | Insert a printable character via CDP `insertText` |
| `keydown` | `key` | Special key press (Enter, Backspace, Tab, arrow keys, etc.) |
| `back` | _(none)_ | Navigate back in browser history |
| `forward` | _(none)_ | Navigate forward in browser history |
| `reload` | _(none)_ | Reload the current page |

All `navigate`, `back`, `forward`, and `reload` commands are protected by a `navigating` boolean mutex in `browser.js` to prevent concurrent `page.goto()` calls from stacking up and causing navigation loops.

---

## Session Lifecycle

```
User opens UI
      |
      v
Frontend sends { type: "hello", sessionId: null } (first visit)
or { type: "hello", sessionId: "uuid-xxx" }  (returning user)
      |
      v
Backend: new session -> allocate port, boot container, register session
Backend: returning   -> find session in registry, cancel TTL, resume stream
      |
      v
Session is ACTIVE: frames flow, inputs are relayed
      |
      v (user closes tab or refreshes)
Backend marks session ORPHANED, starts 2-minute TTL timer
      |
      v (user returns within 2 minutes)      | (timer expires)
Session resumes, TTL cancelled               | Cleanup runs, container stopped
```

---

## Running the Isolation Test

The backend includes a standalone test script that starts a container and verifies isolation properties:

```bash
cd backend
node isolation-test.js
```

The test checks:

- **A. Lifecycle** — container is running, not privileged
- **B. User identity** — process runs as `browser` (non-root), UID > 0, effective capabilities = 0x0
- **C. Resource limits** — Memory, MemorySwap, NanoCpus, PidsLimit match expected values
- **D. Network** — `NetworkMode` is `vessel-isolated`, outbound internet is reachable
- **E. Filesystem** — `/app` is not writable by the `browser` user
- **F. Browser location** — Chromium is not running on the host; `node browser.js` is running inside the container

Requires Docker to be running and the `browse-container:phase2` image to be built first.

---

## URL Threat Detection

Every user-initiated navigation is evaluated by `checkUrl()` in `container/browser.js` **before** `page.goto()` is called.

### What is checked

| Check | Detail |
|---|---|
| URL parseable | Rejects anything that cannot be parsed as a valid URL |
| Scheme whitelist | Only `http:` and `https:` are accepted. `javascript:`, `file:`, `data:`, `ftp:`, `blob:`, `vbscript:` etc. are blocked |
| IPv6 literals | All IPv6 literals in URLs are blocked (e.g. `http://[::1]`, `http://[2001:db8::]`) |
| Private IPv4 literals | `127.x`, `10.x`, `172.16–31.x`, `192.168.x`, `169.254.x`, `0.0.0.0`, `192.0.2.x` etc. are blocked |
| Denylist | Configurable list of exact hostnames and their subdomains (see `DENYLIST` in `container/browser.js`) |
| Pre-navigation DNS resolution | The hostname is resolved via `dns.lookup()` before navigation. If any resolved IP is private/loopback, the navigation is blocked |
| Redirect interception | A CDP `Network.requestWillBeSent` listener catches HTTP redirects mid-navigation and calls `Page.stopLoading` if the redirect destination is blocked |

### What a blocked navigation does

The container sends a `{ type: 'nav_blocked', reason: '...' }` message back to the frontend. The UI displays the reason as a 5-second warning banner without terminating the session. The stream continues from the last successfully loaded page.

### Known limitations

- **Not a phishing detector** — a URL absent from the denylist is not necessarily safe.
- **DNS-rebinding gap** — `checkUrl()` resolves the hostname once, before navigation starts. A malicious server that serves a legitimate IP on the first query and then switches to a private IP on subsequent queries (classic DNS rebinding) is not fully stopped by this check alone.
- **Public IPv6 allowed** — public AAAA records (e.g. for `example.com`) are permitted through the DNS path. Only loopback, link-local, unique-local, and IPv4-mapped private ranges are blocked.

### Extending the denylist

Edit the `DENYLIST` array at the top of `container/browser.js`:

```javascript
const DENYLIST = [
  'malware-test.example',
  'phishing-test.example',
  'denylist-test.invalid',
  // add your entries here — exact hostname or subdomain match
];
```

After editing, rebuild the container image:

```bash
cd container
docker build -t browse-container:phase2 .
```

### Running the URL threat test

```bash
cd container
node url-threat-test.js
```

This is a pure unit test — it does not require Docker or a running container. It covers 40 checks across 10 categories (A–J).

---

**Container startup time.** Chromium takes 5–10 seconds to launch inside the container. This is normal. The booting overlay in the UI covers the stream area during this time.

**Port conflicts.** If containers are not cleaned up properly (for example if the backend crashes), ports in the 30000–40000 range may remain allocated. Clean up all Vessel containers with:

```bash
docker ps -a --filter ancestor=browse-container:phase2 --format "{{.ID}}" | xargs docker rm -f
```

**Frame quality vs. performance.** The screencast is configured at JPEG quality 75. Raising this in `container/browser.js` under `Page.startScreencast` increases bandwidth between the container and the backend.

**Memory and heavy pages.** The 512 MB RAM limit is sufficient for most pages. Very heavy pages with many media elements may hit this limit and cause a tab crash inside the remote browser. You can raise `CONTAINER_MEMORY_BYTES` in `backend/server.js` if needed.

**No HTTPS or WSS.** All communication is plain HTTP and WebSocket. This is intentional for local development only. Do not expose this backend on any network without adding TLS and authentication.

**No authentication.** There is no mechanism to restrict who can connect to the backend and start a container. This is an accepted limitation for local use.

**Session IDs are not access-controlled.** The UUID stored in `localStorage` under `safebrowser_session_id` acts as a bearer token. Any code with access to that value can resume the corresponding session.

**No end-to-end automated tests.** The isolation test verifies container security properties. There are no automated tests for the WebSocket relay path, multi-session concurrency, or the frontend UI. All interaction testing is currently manual.

---

## How It Was Built (Phase by Phase)

**Phase 1** established that Chromium could run headlessly inside Docker at all. The output was a single screenshot saved to `/tmp/screenshot.png`.

**Phase 2** turned `browser.js` into a persistent WebSocket server. It used `Page.startScreencast` via a raw CDP session to stream frames. A test HTML file connected directly to the container to confirm the stream worked.

**Phase 3** introduced the backend orchestrator. Instead of connecting directly to the container, the test client connected to the backend, which spawned the container on demand and relayed messages. This is where `dockerode` and the TCP port probe were introduced.

**Phase 4** replaced the raw HTML test client with a proper Next.js UI. The custom hook pattern was introduced to separate connection logic from rendering. Direct DOM mutation was used for frame rendering to avoid re-render overhead.

**Phase 5** added multi-tenant support. The single `activeSession` global was replaced with a `portAllocator` module and a `sessionRegistry` Map. Each user now gets a dynamically allocated container on a unique host port.

**Phase 6** added graceful reconnection with TTL-based session preservation. Page refreshes no longer destroy the remote browser. Sessions are kept alive for 2 minutes in an `orphaned` state before being garbage collected.

**Phase 7** added Linux cgroup-based resource limits. Each container is capped at **512 MB RAM** and **1 CPU core**, with swap disabled and PID count limited to 512.

**Phase 8** added the `vessel-isolated` Docker bridge network with ICC disabled, hardened Chromium launch flags (WebRTC off, geolocation off, webcam/mic denied), and the standalone isolation test harness. Several bugs were also fixed: the navigate-loop caused by `url_changed` feedback, the 0-fps screencast freeze after navigation, click coordinate mapping for letterboxed images, mouse pre-move for accurate CDP hit testing, and the CapDrop ALL black-screen issue.

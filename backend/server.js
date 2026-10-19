const http     = require('http');
const net      = require('net');
const express  = require('express');
const cors     = require('cors');
const { WebSocketServer, WebSocket } = require('ws');
const Docker   = require('dockerode');

const { allocatePort, releasePort } = require('./portAllocator');
const registry = require('./sessionRegistry');

const BACKEND_PORT    = 3000;
const CONTAINER_IMAGE = 'browse-container:phase2';
const MAX_SESSIONS    = 5;
const TTL_MS          = 2 * 60 * 1000; // 2 minutes

const CONTAINER_MEMORY_BYTES = 512 * 1024 * 1024; // 512 MB RAM (Chromium needs ~200–400 MB)
const CONTAINER_NANO_CPUS    = 1.0 * 1e9;         // 1 CPU core
const CONTAINER_PIDS_LIMIT   = 512;               // Chromium spawns many helper processes

const app    = express();
app.use(cors({ origin: '*' }));
const server = http.createServer(app);
const docker = new Docker({ socketPath: '//./pipe/docker_engine' });
const wss    = new WebSocketServer({ server });

async function waitForContainerPort(port, maxRetries = 30, intervalMs = 500) {
  console.log(`[backend] Probing TCP port ${port} (up to ${maxRetries} attempts)...`);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const open = await new Promise((resolve) => {
      const socket = net.createConnection({ host: 'localhost', port });
      const timer  = setTimeout(() => { socket.destroy(); resolve(false); }, 800);
      socket.on('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
      socket.on('error',   () => { clearTimeout(timer); resolve(false); });
    });

    if (open) {
      console.log(`[backend] Port ${port} ready after ${attempt} attempt(s).`);
      await new Promise((r) => setTimeout(r, 400));
      return;
    }
    console.log(`[backend] Attempt ${attempt}/${maxRetries} — port ${port} not open yet...`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error(`Container port ${port} never opened after ${maxRetries} attempts.`);
}

app.get('/api/status', (req, res) => {
  res.json({
    status: 'ok',
    activeSessions: registry.getSessionCount(),
    maxSessions: MAX_SESSIONS,
    ttlSeconds: TTL_MS / 1000,
    sessions: registry.getAllSessions().map((s) => ({
      id:        s.id,
      port:      s.port,
      status:    s.status,
      createdAt: s.createdAt,
    })),
  });
});

wss.on('connection', (frontendWs) => {
  console.log(`\n[backend] New WS connection. Active sessions: ${registry.getSessionCount()}/${MAX_SESSIONS}`);

  if (registry.getSessionCount() >= MAX_SESSIONS) {
    console.warn('[backend] At capacity. Rejecting.');
    frontendWs.send(JSON.stringify({ type: 'error', message: 'Server is at capacity. Please try again later.' }));
    frontendWs.close();
    return;
  }

  frontendWs.once('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      frontendWs.close();
      return;
    }

    if (msg.type !== 'hello') {
      frontendWs.close();
      return;
    }

    const incomingSessionId = msg.sessionId || null;

    if (incomingSessionId) {
      const resumed = registry.reconnectSession(incomingSessionId, frontendWs);

      if (resumed) {
        const session = registry.getSession(incomingSessionId);
        console.log(`[backend] Reconnect: resuming session ${incomingSessionId.slice(0, 8)}...`);

        // Remove stale listener before re-wiring to avoid duplicate pushes
        session.containerWs.removeAllListeners('message');
        session.containerWs.on('message', (data) => {
          if (frontendWs.readyState === WebSocket.OPEN) {
            frontendWs.send(data.toString());
          }
        });

        frontendWs.send(JSON.stringify({ type: 'status', message: 'session_resumed' }));
        attachListeners(frontendWs, session.containerWs, incomingSessionId, session.container, session.port);
        return;
      }

      console.log(`[backend] Session ${incomingSessionId.slice(0, 8)} not found or expired. Starting fresh.`);
      frontendWs.send(JSON.stringify({ type: 'status', message: 'session_expired' }));
    }

    await startNewSession(frontendWs);
  });
});

async function startNewSession(frontendWs) {
  let container   = null;
  let containerWs = null;
  let sessionId   = null;
  let port        = null;

  try {
    port = await allocatePort();
    console.log(`[backend] Allocated port: ${port}`);

    container = await docker.createContainer({
      Image: CONTAINER_IMAGE,
      HostConfig: {
        AutoRemove:    true,
        NetworkMode:   'bridge',
        PortBindings:  { '3001/tcp': [{ HostPort: String(port) }] },

        // ── Memory & CPU (existing) ────────────────────────────────────────
        Memory:        CONTAINER_MEMORY_BYTES,
        MemorySwap:    CONTAINER_MEMORY_BYTES, // disables swap entirely
        NanoCpus:      CONTAINER_NANO_CPUS,

        // ── Isolation hardening ───────────────────────────────────────────
        // NOTE: CapDrop ALL is intentionally NOT used here.
        // Chromium's zygote and renderer processes need Linux capabilities
        // (e.g. SYS_ADMIN for user-namespace sandboxing) even when launched
        // with --no-sandbox. Dropping ALL causes the zygote to crash silently
        // immediately after launch, producing a 0-fps black screen.
        // Isolation is achieved via: non-root user (browser), PidsLimit,
        // Memory cap, CPU cap, and the --no-sandbox / --disable-* Chromium flags.

        // Limit total PIDs to prevent fork-bomb style DoS from inside.
        PidsLimit:     CONTAINER_PIDS_LIMIT,
      },
    });

    await container.start();
    console.log(`[backend] Container started. ID: ${container.id.slice(0, 12)} on port ${port}`);
    frontendWs.send(JSON.stringify({ type: 'status', message: 'container_starting' }));

    await waitForContainerPort(port);

    // Retry WS connect — the TCP port can open before ws is ready to upgrade
    containerWs = await (async () => {
      const maxTries = 10;
      for (let i = 1; i <= maxTries; i++) {
        try {
          const ws = new WebSocket(`ws://localhost:${port}`);
          await new Promise((resolve, reject) => {
            ws.on('open',  resolve);
            ws.on('error', reject);
          });
          console.log(`[backend] Container WS connected on attempt ${i}.`);
          return ws;
        } catch (err) {
          if (i === maxTries) throw new Error(`Container WS failed after ${maxTries} attempts: ${err.message}`);
          console.log(`[backend] WS attempt ${i}/${maxTries} failed, retrying in 500ms...`);
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    })();

    sessionId = registry.createSession(container, containerWs, port, frontendWs);
    console.log(`[backend] Relay ready. Session: ${sessionId.slice(0, 8)}...`);

    frontendWs.send(JSON.stringify({ type: 'status', message: 'session_ready', sessionId }));

    containerWs.on('message', (data) => {
      if (frontendWs.readyState === WebSocket.OPEN) {
        frontendWs.send(data.toString());
      }
    });

    attachListeners(frontendWs, containerWs, sessionId, container, port);

  } catch (err) {
    console.error('[backend] Session setup failed:', err.message);
    if (frontendWs.readyState === WebSocket.OPEN) {
      frontendWs.send(JSON.stringify({ type: 'error', message: err.message }));
      frontendWs.close();
    }
    await cleanup(sessionId, container, containerWs, port);
  }
}

function attachListeners(frontendWs, containerWs, sessionId, container, port) {
  frontendWs.on('message', (data) => {
    if (containerWs.readyState !== WebSocket.OPEN) return;
    containerWs.send(data);
    try {
      const msg = JSON.parse(data.toString());
      const tag = `[${sessionId.slice(0, 8)}]`;
      if (msg.type === 'click')    console.log(`${tag} click    x=${msg.x?.toFixed(3)} y=${msg.y?.toFixed(3)}`);
      if (msg.type === 'navigate') console.log(`${tag} navigate → ${msg.url}`);
      if (msg.type === 'type')     console.log(`${tag} type     "${msg.text}"`);
      if (msg.type === 'keydown')  console.log(`${tag} keydown  ${msg.key}`);
      if (msg.type === 'scroll')   console.log(`${tag} scroll   deltaY=${msg.deltaY}`);
    } catch (_) {}
  });

  frontendWs.on('close', () => {
    console.log(`[backend] Frontend disconnected. Orphaning session ${sessionId.slice(0, 8)} for ${TTL_MS / 1000}s...`);

    const timer = setTimeout(async () => {
      console.log(`[backend] TTL expired for ${sessionId.slice(0, 8)}. Destroying container.`);
      const session = registry.getSession(sessionId);
      await cleanup(sessionId, session?.container, session?.containerWs, session?.port);
    }, TTL_MS);

    registry.markOrphaned(sessionId, timer);
  });

  frontendWs.on('error', (err) => {
    console.error(`[backend] Frontend WS error for ${sessionId.slice(0, 8)}:`, err.message);
  });

  containerWs.on('close', () => {
    console.log(`[backend] Container WS closed for session ${sessionId.slice(0, 8)}.`);
    if (frontendWs.readyState === WebSocket.OPEN) {
      frontendWs.send(JSON.stringify({ type: 'status', message: 'container_closed' }));
      frontendWs.close();
    }
    cleanup(sessionId, container, containerWs, port);
  });
}

async function cleanup(sessionId, container, containerWs, port) {
  if (sessionId) registry.deleteSession(sessionId);
  if (port)      releasePort(port);

  try {
    if (containerWs && containerWs.readyState !== WebSocket.CLOSED) {
      containerWs.terminate();
    }
  } catch (_) {}

  try {
    if (container) {
      await container.stop({ t: 2 });
      console.log('[backend] Container stopped and removed.');
    }
  } catch (err) {
    if (!err.statusCode || (err.statusCode !== 304 && err.statusCode !== 404)) {
      console.error('[backend] Error stopping container:', err.message);
    }
  }
}

server.listen(BACKEND_PORT, () => {
  console.log(`\n[backend] SafeBrowser backend ready`);
  console.log(`  HTTP   → http://localhost:${BACKEND_PORT}`);
  console.log(`  WS     → ws://localhost:${BACKEND_PORT}`);
  console.log(`  Status → http://localhost:${BACKEND_PORT}/api/status`);
  console.log(`  Max sessions: ${MAX_SESSIONS} | Orphan TTL: ${TTL_MS / 1000}s\n`);
});

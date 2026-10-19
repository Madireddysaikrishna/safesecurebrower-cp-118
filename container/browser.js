const puppeteer = require('puppeteer-core');
const { WebSocketServer } = require('ws');

const CHROMIUM_PATH = '/usr/bin/chromium';
const WS_PORT  = 3001;
const VIEWPORT = { width: 1280, height: 720 };
const START_URL    = 'https://google.com';
const NAV_TIMEOUT  = 20000; // 20 s — generous enough for slow sites

const BROWSER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-sync',
  '--disable-translate',
  '--disable-default-apps',
  '--no-first-run',
  '--no-pings',
];

const wss = new WebSocketServer({ port: WS_PORT, host: '0.0.0.0' });
console.log(`[container] WebSocket server listening on ws://0.0.0.0:${WS_PORT}`);

wss.on('connection', async (ws) => {
  console.log('[container] Client connected — launching browser session...');

  let browser     = null;
  let cdpClient   = null;
  let frameHandler = null;

  // ── navigating guard ────────────────────────────────────────────────────
  // Prevents concurrent page.goto() calls when the user clicks Go multiple
  // times quickly (or the frontend sends duplicate navigate messages).
  // Without this guard, a second navigate arrives while page.goto() is still
  // awaiting, queues another goto() on the same CDP session, and the two
  // interleave — producing the "navigate × 4" loop seen in the logs.
  let navigating = false;

  // ── Screencast lifecycle ─────────────────────────────────────────────────
  // Keep a single named frameHandler so we can remove it before restarting.
  async function stopScreencast() {
    if (frameHandler) {
      cdpClient.removeListener('Page.screencastFrame', frameHandler);
      frameHandler = null;
    }
    try { await cdpClient.send('Page.stopScreencast'); } catch (_) {}
  }

  async function startScreencast() {
    await stopScreencast();
    await cdpClient.send('Page.startScreencast', {
      format:        'jpeg',
      quality:       75,
      maxWidth:      VIEWPORT.width,
      maxHeight:     VIEWPORT.height,
      everyNthFrame: 1,
    });
    frameHandler = async ({ data, sessionId }) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'frame', data }));
      }
      try {
        await cdpClient.send('Page.screencastFrameAck', { sessionId });
      } catch (_) {}
    };
    cdpClient.on('Page.screencastFrame', frameHandler);
    console.log('[container] Screencast started.');
  }

  // ── Safe navigate helper ─────────────────────────────────────────────────
  // Stops screencast, navigates with a timeout, restarts screencast, and
  // sends a url_changed event. Falls back gracefully on timeout/error.
  // The `navigating` flag prevents concurrent calls from stacking up.
  async function safeNavigate(page, url) {
    if (navigating) {
      console.log(`[container] Already navigating — skipping duplicate request to: ${url}`);
      return;
    }
    navigating = true;
    console.log(`[container] Navigating to: ${url}`);
    await stopScreencast();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    } catch (err) {
      console.warn(`[container] Navigation warning (${url}): ${err.message}`);
    } finally {
      navigating = false;
    }
    await startScreencast();
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'url_changed', url: page.url() }));
    }
  }

  // ── Mouse helper: always move to point before pressing ──────────────────
  // Chromium requires a prior mouseMoved event to update its internal cursor
  // position before it will correctly hit-test a mousePressed. Without this,
  // clicks on input elements and links can silently miss focus/activation.
  // This mirrors exactly what Puppeteer's page.click() does internally.
  async function mouseClick(px, py) {
    await cdpClient.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: px, y: py, button: 'none', clickCount: 0,
    });
    await cdpClient.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: px, y: py,
      button: 'left', clickCount: 1, modifiers: 0,
    });
    await cdpClient.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: px, y: py,
      button: 'left', clickCount: 1, modifiers: 0,
    });
  }

  // ── Main session ─────────────────────────────────────────────────────────
  try {
    browser = await puppeteer.launch({
      executablePath: CHROMIUM_PATH,
      headless: true,
      args: BROWSER_ARGS,
    });

    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    page.setDefaultNavigationTimeout(NAV_TIMEOUT);

    cdpClient = await page.createCDPSession();

    console.log(`[container] Navigating to ${START_URL}...`);
    await safeNavigate(page, START_URL);
    console.log('[container] Initial page ready, screencast running.');

    // ── Command dispatcher ─────────────────────────────────────────────────
    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        console.warn('[container] Received non-JSON message, ignoring.');
        return;
      }

      try {
        switch (msg.type) {

          case 'click': {
            const px = Math.round(msg.x * VIEWPORT.width);
            const py = Math.round(msg.y * VIEWPORT.height);
            console.log(`[container] Click at pixel (${px}, ${py})`);
            // mouseClick sends mouseMoved first so Chromium hit-tests correctly
            await mouseClick(px, py);
            break;
          }

          case 'mousemove': {
            const px = Math.round(msg.x * VIEWPORT.width);
            const py = Math.round(msg.y * VIEWPORT.height);
            await cdpClient.send('Input.dispatchMouseEvent', {
              type: 'mouseMoved', x: px, y: py, button: 'none', clickCount: 0,
            });
            break;
          }

          case 'scroll': {
            const px = Math.round(msg.x * VIEWPORT.width);
            const py = Math.round(msg.y * VIEWPORT.height);
            await cdpClient.send('Input.dispatchMouseEvent', {
              type: 'mouseWheel', x: px, y: py,
              deltaX: 0, deltaY: msg.deltaY || 100,
            });
            break;
          }

          case 'keydown': {
            // Special / control keys (Backspace, Enter, Arrow*, Tab, Escape, F-keys…)
            await cdpClient.send('Input.dispatchKeyEvent', {
              type: 'keyDown', key: msg.key,
            });
            await cdpClient.send('Input.dispatchKeyEvent', {
              type: 'keyUp', key: msg.key,
            });
            break;
          }

          case 'type': {
            // Printable characters — insertText reaches the focused element
            // regardless of which key was pressed (handles IME, accents, etc.)
            await cdpClient.send('Input.insertText', { text: msg.text });
            break;
          }

          case 'navigate': {
            let targetUrl = msg.url.trim();
            if (!/^https?:\/\//i.test(targetUrl)) {
              targetUrl = 'https://' + targetUrl;
            }
            await safeNavigate(page, targetUrl);
            break;
          }

          case 'back': {
            if (navigating) break;
            navigating = true;
            await stopScreencast();
            await page.goBack({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {});
            navigating = false;
            await startScreencast();
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({ type: 'url_changed', url: page.url() }));
            }
            break;
          }

          case 'forward': {
            if (navigating) break;
            navigating = true;
            await stopScreencast();
            await page.goForward({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {});
            navigating = false;
            await startScreencast();
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({ type: 'url_changed', url: page.url() }));
            }
            break;
          }

          case 'reload': {
            if (navigating) break;
            navigating = true;
            await stopScreencast();
            await page.reload({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {});
            navigating = false;
            await startScreencast();
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({ type: 'url_changed', url: page.url() }));
            }
            break;
          }

          default:
            console.warn(`[container] Unknown command type: ${msg.type}`);
        }
      } catch (err) {
        navigating = false; // always release on error
        console.error('[container] Error handling command:', err.message);
      }
    });

  } catch (err) {
    console.error('[container] Failed to start browser session:', err.message);
    ws.close();
    return;
  }

  ws.on('close', async () => {
    console.log('[container] Client disconnected. Cleaning up...');
    try { await stopScreencast(); } catch (_) {}
    try { if (browser) await browser.close(); } catch (_) {}
    console.log('[container] Browser closed. Ready for next connection.');
  });

  ws.on('error', (err) => {
    console.error('[container] WebSocket error:', err.message);
  });
});

wss.on('error', (err) => {
  console.error('[container] Server error:', err.message);
  process.exit(1);
});

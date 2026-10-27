const puppeteer = require('puppeteer-core');
const { WebSocketServer } = require('ws');

// All URL safety logic lives in checkUrl.js — the single source of truth
// shared by this runtime module and the test suite.
const { checkUrl } = require('./checkUrl');

const CHROMIUM_PATH = '/usr/bin/chromium';
const WS_PORT  = 3001;
const VIEWPORT = { width: 1280, height: 720 };
const START_URL    = 'https://google.com';
const NAV_TIMEOUT  = 20000; // 20 s — generous enough for slow sites

const BROWSER_ARGS = [
  // Required for headless in Docker (no sandbox user-ns available)
  '--no-sandbox',
  '--disable-setuid-sandbox',

  // Rendering / GPU — no display in container
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--disable-software-rasterizer',

  // Suppress first-run / telemetry / crash reporter
  '--no-first-run',
  '--no-pings',
  '--disable-background-networking',
  '--disable-sync',
  '--disable-translate',
  '--disable-default-apps',
  '--noerrdialogs',
  '--disable-breakpad',        // no crash reporter phoning home
  '--metrics-recording-only',  // metrics stay local, not sent

  // Extensions / plugins — not needed, reduce attack surface
  '--disable-extensions',
  '--disable-plugins',
  '--disable-component-update',

  // Privacy: prevent browsed pages from accessing sensors
  '--disable-geolocation',
  '--use-fake-ui-for-media-stream',   // deny webcam/mic silently
  '--disable-notifications',

  // WebRTC — disable to prevent IP leak through STUN/TURN
  '--disable-webrtc',

  // Background processes
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
];

const wss = new WebSocketServer({ port: WS_PORT, host: '0.0.0.0' });
console.log(`[container] WebSocket server listening on ws://0.0.0.0:${WS_PORT}`);

wss.on('connection', async (ws) => {
  console.log('[container] Client connected — launching browser session...');

  let browser      = null;
  let cdpClient    = null;
  let frameHandler = null;

  // ── navigating guard ─────────────────────────────────────────────────────
  // Prevents concurrent page.goto() calls when the user clicks Go multiple
  // times quickly (or the frontend sends duplicate navigate messages).
  // Without this guard, a second navigate arrives while page.goto() is still
  // awaiting, queues another goto() on the same CDP session, and the two
  // interleave — producing the "navigate × 4" loop seen in the logs.
  let navigating = false;

  // ── Screencast lifecycle ─────────────────────────────────────────────────
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

    // ── CDP Fetch interception: validate ALL document-level navigations ──────
    //
    // Fetch.enable with resourceType:'Document' intercepts every HTTP/HTTPS
    // request that would produce a top-level page navigation, including:
    //
    //   • In-page link clicks (the main bypass vector with the old approach)
    //   • JavaScript redirects  (window.location, location.href = …)
    //   • <meta http-equiv="refresh"> redirects
    //   • HTTP 3xx redirect hops (each hop is a fresh paused request)
    //   • Address-bar navigates sent via the 'navigate' command (second check)
    //   • back / forward history navigations that issue a network request
    //
    // This supersedes the previous Network.requestWillBeSent approach, which
    // only caught HTTP redirect hops and missed in-page link clicks entirely.
    //
    // The explicit checkUrl() call inside the 'navigate' case below still runs
    // first as a fast path (user sees the block message before Chromium even
    // starts), while the Fetch interceptor is the authoritative enforcement
    // layer for everything not originating from the address bar.
    //
    // Limitation: back/forward navigation to pages served from Chromium's
    // in-memory cache does not emit a Fetch.requestPaused event. Those URLs
    // were already validated when first navigated — re-validation is not
    // possible without network-level enforcement outside the container.
    await cdpClient.send('Fetch.enable', {
      patterns: [{ requestStage: 'Request', resourceType: 'Document' }],
    });

    cdpClient.on('Fetch.requestPaused', async ({ requestId, request, resourceType }) => {
      // The pattern filter guarantees Document type, but guard defensively.
      if (resourceType !== 'Document') {
        await cdpClient.send('Fetch.continueRequest', { requestId }).catch(() => {});
        return;
      }

      const result = await checkUrl(request.url).catch(() => ({
        ok:     false,
        reason: 'Internal URL check error during Fetch intercept',
      }));

      if (!result.ok) {
        console.warn(`[container] Fetch intercept blocked: ${result.reason}`);
        await cdpClient.send('Fetch.failRequest', {
          requestId,
          errorReason: 'BlockedByClient',
        }).catch(() => {});
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'nav_blocked', reason: result.reason }));
        }
      } else {
        await cdpClient.send('Fetch.continueRequest', { requestId }).catch(() => {});
      }
    });

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
            await cdpClient.send('Input.dispatchKeyEvent', {
              type: 'keyDown', key: msg.key,
            });
            await cdpClient.send('Input.dispatchKeyEvent', {
              type: 'keyUp', key: msg.key,
            });
            break;
          }

          case 'type': {
            await cdpClient.send('Input.insertText', { text: msg.text });
            break;
          }

          case 'navigate': {
            let targetUrl = (msg.url ?? '').trim();
            if (!targetUrl) break;
            // Add https:// prefix only if there is no scheme at all.
            if (!/^[a-z][a-z0-9+\-.]*:\/\//i.test(targetUrl)) {
              targetUrl = 'https://' + targetUrl;
            }

            // ── Fast-path check (address-bar navigations) ──────────────────
            // Validate before handing the URL to Chromium. This gives the user
            // immediate feedback and avoids starting a navigation that the Fetch
            // interceptor would then abort. The Fetch interceptor below provides
            // a second, independent validation layer — it catches every
            // navigation regardless of origin (links, JS, redirects, etc.).
            const check = await checkUrl(targetUrl);
            if (!check.ok) {
              console.warn(`[container] Navigate command blocked — ${check.reason}`);
              if (ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify({ type: 'nav_blocked', reason: check.reason }));
              }
              break;
            }
            await safeNavigate(page, targetUrl);
            break;
          }

          // ── History navigation ───────────────────────────────────────────
          // back / forward / reload do NOT call checkUrl() explicitly here;
          // they navigate to URLs that were already validated when first
          // visited. The Fetch interceptor above provides a second check for
          // any navigation that issues a network request (i.e. non-cached
          // back/forward and all reloads).
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

const puppeteer = require('puppeteer-core');
const { WebSocketServer } = require('ws');
const dns        = require('dns').promises;
const net        = require('net');

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

// ── URL Threat Detection ─────────────────────────────────────────────────────
//
// Configurable denylist of hostnames / patterns to block outright.
// This is NOT a phishing detection engine — an unlisted URL is not safe.
// Add entries as exact lowercase hostnames or partial strings.
const DENYLIST = [
  'malware-test.example',
  'phishing-test.example',
  'denylist-test.invalid',
];

// Private / loopback IPv4 CIDR ranges (RFC 1918, RFC 5735, RFC 3927).
const PRIVATE_CIDRS_V4 = [
  { base: 0x7f000000, mask: 0xff000000 }, // 127.0.0.0/8   loopback
  { base: 0x0a000000, mask: 0xff000000 }, // 10.0.0.0/8    RFC-1918
  { base: 0xac100000, mask: 0xfff00000 }, // 172.16.0.0/12 RFC-1918
  { base: 0xc0a80000, mask: 0xffff0000 }, // 192.168.0.0/16 RFC-1918
  { base: 0xa9fe0000, mask: 0xffff0000 }, // 169.254.0.0/16 link-local
  { base: 0x00000000, mask: 0xffffffff }, // 0.0.0.0       unspecified
  { base: 0xc0000200, mask: 0xffffff00 }, // 192.0.2.0/24  TEST-NET-1
  { base: 0xc6336400, mask: 0xffffff00 }, // 198.51.100.0/24 TEST-NET-2
  { base: 0xcb007100, mask: 0xffffff00 }, // 203.0.113.0/24 TEST-NET-3
];

/**
 * Returns true if the IPv4 address (dotted-decimal string) falls within
 * any private, loopback, or reserved range.
 */
function isPrivateIpV4(addr) {
  const parts = addr.split('.');
  if (parts.length !== 4) return false;
  const n = parts.reduce((acc, oct) => (acc << 8) | (parseInt(oct, 10) & 0xff), 0) >>> 0;
  // Use >>> 0 on the & result: JS bitwise ops return signed 32-bit integers,
  // but the base constants above 0x7FFFFFFF are stored as positive JS Numbers.
  // Without >>> 0, (n & mask) for e.g. 0xAC100000 would be -1408237568,
  // which never equals the positive base 2886729728.
  return PRIVATE_CIDRS_V4.some(({ base, mask }) => ((n & mask) >>> 0) === base);
}

/**
 * Returns true if the address is an IPv6 address that is loopback (::1),
 * unspecified (::), or maps to a private IPv4 space (::ffff:10.x / ::ffff:192.168.x etc.).
 * Reject all IPv6 literals conservatively — the container has no use for them.
 */
function isBlockedIpV6(addr) {
  // Block ALL IPv6 literals in URLs. Users have no need to type raw IPv6
  // addresses into the browser bar, and every IPv6 literal is a risk vector.
  return net.isIPv6(addr);
}

/**
 * Returns true if an IPv6 address resolved from DNS is private, loopback,
 * link-local, unique-local, or IPv4-mapped to a private range.
 * Used in the DNS resolution path — public AAAA records (e.g. example.com)
 * must NOT be blocked by this function.
 */
function isPrivateIpV6(addr) {
  if (!net.isIPv6(addr)) return false;
  const lower = addr.toLowerCase();
  if (lower === '::1') return true;                              // loopback
  if (lower === '::') return true;                               // unspecified
  if (/^f[cd]/i.test(lower)) return true;                       // unique local  fc00::/7
  if (/^fe[89ab]/i.test(lower)) return true;                    // link-local    fe80::/10
  // IPv4-mapped ::ffff:x.x.x.x — check the embedded IPv4 part
  const v4mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4mapped) return isPrivateIpV4(v4mapped[1]);
  // IPv4-compatible ::x.x.x.x (deprecated but still seen)
  const v4compat = lower.match(/^::(\d+\.\d+\.\d+\.\d+)$/);
  if (v4compat) return isPrivateIpV4(v4compat[1]);
  // Documentation range 2001:db8::/32
  if (/^2001:db8:/i.test(lower)) return true;
  return false;
}

/**
 * Validates a URL string for safe navigation.
 *
 * Returns { ok: true } if the URL may proceed, or
 * { ok: false, reason: string } if it should be blocked.
 *
 * Checks performed (in order):
 *   1. URL parseable as a valid URL object
 *   2. Scheme must be http: or https:
 *   3. Hostname must not be empty
 *   4. Hostname must not be a known private/loopback IPv4 or IPv6 address
 *   5. Hostname must not appear in DENYLIST
 *   6. DNS pre-resolution: resolved IP(s) must not be private/loopback
 *
 * Limitation: Chromium may follow additional HTTP redirects after checkUrl()
 * passes. Those redirects are intercepted separately via CDP
 * Network.requestWillBeSent where feasible. This does not provide complete
 * protection against all DNS-rebinding attacks, but significantly raises
 * the bar. See inline comments in the CDP intercept handler below.
 */
async function checkUrl(rawUrl) {
  // ── 1. Parse ────────────────────────────────────────────────────────────
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: `Malformed URL: ${rawUrl}` };
  }

  // ── 2. Scheme ───────────────────────────────────────────────────────────
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `Blocked scheme '${parsed.protocol}' — only http: and https: are allowed.` };
  }

  const hostname = parsed.hostname.toLowerCase();

  // ── 3. Non-empty hostname ───────────────────────────────────────────────
  if (!hostname) {
    return { ok: false, reason: 'URL has no hostname.' };
  }

  // ── 4. Literal IP checks ────────────────────────────────────────────────
  if (net.isIPv4(hostname) && isPrivateIpV4(hostname)) {
    return { ok: false, reason: `Blocked private/reserved IPv4 address: ${hostname}` };
  }
  if (isBlockedIpV6(hostname)) {
    return { ok: false, reason: `Blocked IPv6 address (not permitted): ${hostname}` };
  }

  // ── 5. Denylist ─────────────────────────────────────────────────────────
  for (const entry of DENYLIST) {
    if (hostname === entry || hostname.endsWith('.' + entry)) {
      return { ok: false, reason: `Blocked: hostname '${hostname}' is on the denylist.` };
    }
  }

  // ── 6. Pre-navigation DNS resolution ───────────────────────────────────
  // Skip DNS lookup for bare IP literals (already checked above).
  if (!net.isIP(hostname)) {
    try {
      const addrs = await dns.lookup(hostname, { all: true });
      for (const { address, family } of addrs) {
        if (family === 4 && isPrivateIpV4(address)) {
          return { ok: false, reason: `Blocked: '${hostname}' resolves to private IPv4 ${address}` };
        }
        // Use isPrivateIpV6 (not isBlockedIpV6) here: public AAAA records
        // for legitimate domains must be allowed through the DNS path.
        if (family === 6 && isPrivateIpV6(address)) {
          return { ok: false, reason: `Blocked: '${hostname}' resolves to private IPv6 ${address}` };
        }
      }
    } catch (dnsErr) {
      // DNS failure (NXDOMAIN, SERVFAIL, etc.) — block the navigation.
      // An unresolvable host cannot be reached, and we should not silently
      // send an unresolvable hostname to Chromium which may try alternative paths.
      return { ok: false, reason: `DNS resolution failed for '${hostname}': ${dnsErr.code ?? dnsErr.message}` };
    }
  }

  return { ok: true };
}

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

    // ── CDP redirect intercept ───────────────────────────────────────────────
    // Catches HTTP redirects that navigate to a private/internal IP AFTER the
    // original URL passed checkUrl(). This is a second line of defence against
    // redirect-based SSRF. It does NOT catch DNS-rebinding that happens after
    // the TCP connection is already established (that requires network-level
    // enforcement outside the container).
    await cdpClient.send('Network.enable', {});
    cdpClient.on('Network.requestWillBeSent', async ({ request, type, redirectResponse }) => {
      // Only evaluate HTTP redirects (redirectResponse != null on redirect hops)
      if (!redirectResponse) return;
      // Only care about document-level navigation redirects
      if (type !== 'Document') return;
      const result = await checkUrl(request.url).catch(() => ({ ok: false, reason: 'redirect check error' }));
      if (!result.ok) {
        console.warn(`[container] Redirect blocked: ${result.reason}`);
        // Abort the navigation and notify the frontend.
        // page.goto() will throw on the next tick; the catch in safeNavigate handles it.
        try { await cdpClient.send('Page.stopLoading'); } catch (_) {}
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'nav_blocked', reason: result.reason }));
        }
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
            let targetUrl = (msg.url ?? '').trim();
            if (!targetUrl) break;
            // Add https:// prefix only if there is no scheme at all
            if (!/^[a-z][a-z0-9+\-.]*:\/\//i.test(targetUrl)) {
              targetUrl = 'https://' + targetUrl;
            }
            const check = await checkUrl(targetUrl);
            if (!check.ok) {
              console.warn(`[container] Navigation blocked — ${check.reason}`);
              if (ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify({ type: 'nav_blocked', reason: check.reason }));
              }
              break;
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

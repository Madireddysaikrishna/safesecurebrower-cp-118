const puppeteer = require('puppeteer-core');
const { WebSocketServer } = require('ws');

const CHROMIUM_PATH = '/usr/bin/chromium';
const WS_PORT = 3001;
const VIEWPORT = { width: 1280, height: 720 };
const START_URL = 'https://google.com';

const BROWSER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  // Attack surface reduction — disable features not needed for plain browsing
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

  let browser = null;
  let cdpClient = null;

  try {
    browser = await puppeteer.launch({
      executablePath: CHROMIUM_PATH,
      headless: true,
      args: BROWSER_ARGS,
    });

    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);

    console.log(`[container] Navigating to ${START_URL}...`);
    await page.goto(START_URL, { waitUntil: 'domcontentloaded' });
    console.log('[container] Page ready. Starting screencast...');

    cdpClient = await page.createCDPSession();

    // Extracted so we can restart it after every navigation
    async function startScreencast() {
      await cdpClient.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 75,
        maxWidth: VIEWPORT.width,
        maxHeight: VIEWPORT.height,
        everyNthFrame: 1,
      });
    }

    await startScreencast();

    cdpClient.on('Page.screencastFrame', async ({ data, sessionId }) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'frame', data }));
      }
      try {
        await cdpClient.send('Page.screencastFrameAck', { sessionId });
      } catch (_) {
        // session may have closed so ignore
      }
    });


    //    I used normalized coordinates (0.0 to 1.0) so the frontend doesn't need to know the container's viewport resolution. I multiplied here.
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
            //  normalized coords to pixel coords
            const px = Math.round(msg.x * VIEWPORT.width);
            const py = Math.round(msg.y * VIEWPORT.height);
            console.log(`[container] Click at pixel (${px}, ${py})`);


            await cdpClient.send('Input.dispatchMouseEvent', {
              type: 'mousePressed', x: px, y: py,
              button: 'left', clickCount: 1,
              modifiers: 0,
            });
            await cdpClient.send('Input.dispatchMouseEvent', {
              type: 'mouseReleased', x: px, y: py,
              button: 'left', clickCount: 1,
              modifiers: 0,
            });
            break;
          }

          case 'mousemove': {
            const px = Math.round(msg.x * VIEWPORT.width);
            const py = Math.round(msg.y * VIEWPORT.height);
            await cdpClient.send('Input.dispatchMouseEvent', {
              type: 'mouseMoved', x: px, y: py,
              button: 'none',
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
            // Auto-prefix https:// so bare domains like 'google.com' work
            let targetUrl = msg.url.trim();
            if (!/^https?:\/\//i.test(targetUrl)) {
              targetUrl = 'https://' + targetUrl;
            }
            console.log(`[container] Navigating to: ${targetUrl}`);
            try { await cdpClient.send('Page.stopScreencast'); } catch (_) {}
            await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
            await startScreencast();
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({ type: 'url_changed', url: page.url() }));
            }
            break;
          }

          case 'back': {
            try { await cdpClient.send('Page.stopScreencast'); } catch (_) {}
            await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
            await startScreencast();
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({ type: 'url_changed', url: page.url() }));
            }
            break;
          }

          case 'forward': {
            try { await cdpClient.send('Page.stopScreencast'); } catch (_) {}
            await page.goForward({ waitUntil: 'domcontentloaded' }).catch(() => {});
            await startScreencast();
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({ type: 'url_changed', url: page.url() }));
            }
            break;
          }

          case 'reload': {
            try { await cdpClient.send('Page.stopScreencast'); } catch (_) {}
            await page.reload({ waitUntil: 'domcontentloaded' });
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
    try {
      if (cdpClient) await cdpClient.send('Page.stopScreencast');
    } catch (_) {}
    try {
      if (browser) await browser.close();
    } catch (_) {}
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

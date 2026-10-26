'use strict';
/**
 * auth-test.js — Authentication test suite for the Vessel backend.
 *
 * Prerequisites:
 *   1. The backend must be running:  node server.js
 *   2. VESSEL_TOKEN must match the value the backend uses.
 *
 * Usage (run from the backend/ directory):
 *   VESSEL_TOKEN=my-secret node auth-test.js
 *
 * Tests:
 *   A. Missing token            -> rejected (Unauthorized)
 *   B. Wrong token              -> rejected (secret not echoed)
 *   C. Empty-string token       -> rejected
 *   D. Non-hello first message  -> connection closed, no data sent
 *   E. Correct token            -> session started, no auth error
 *   F. Forged UUID + wrong token -> rejected on auth before session lookup
 *   G. Non-JSON first message   -> connection closed
 */

const { WebSocket } = require('ws');

const WS_URL = process.env.BACKEND_URL || 'ws://localhost:3000';
const CORRECT_TOKEN = process.env.VESSEL_TOKEN;

if (!CORRECT_TOKEN) {
  console.error('FATAL: set VESSEL_TOKEN to the same value used by the running backend.');
  process.exit(1);
}

let passed = 0, failed = 0;

function check(name, value, predicate) {
  const ok = predicate(value);
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name);
  if (!ok) console.log('       got:', JSON.stringify(value));
  if (ok) passed++; else failed++;
}

/**
 * Open a WS, send a hello message (with the given token and sessionId),
 * collect all incoming messages for waitMs ms, then resolve.
 */
function probeHello({ token, sessionId = null, waitMs = 1500 } = {}) {
  return new Promise((resolve) => {
    const messages = [];
    let done = false;
    const ws = new WebSocket(WS_URL);
    const finish = () => {
      if (done) return;
      done = true;
      resolve({ connected: true, messages });
    };
    ws.on('open', () => { ws.send(JSON.stringify({ type: 'hello', token, sessionId })); });
    ws.on('message', (data) => { try { messages.push(JSON.parse(data.toString())); } catch (_) { } });
    ws.on('close', finish);
    ws.on('error', (err) => { messages.push({ _connectionError: err.message }); finish(); });
    setTimeout(() => { ws.terminate(); finish(); }, waitMs);
  });
}

/**
 * Open a WS, send an arbitrary raw string (possibly non-JSON) as the
 * first message, collect responses for waitMs ms, then resolve.
 */
function probeRaw(payload, waitMs = 1500) {
  return new Promise((resolve) => {
    const messages = [];
    let closed = false, done = false;
    const ws = new WebSocket(WS_URL);
    const finish = () => { if (done) return; done = true; resolve({ messages, closed }); };
    ws.on('open', () => { ws.send(payload); });
    ws.on('message', (data) => { try { messages.push(JSON.parse(data.toString())); } catch (_) { } });
    ws.on('close', () => { closed = true; finish(); });
    ws.on('error', () => finish());
    setTimeout(() => { ws.terminate(); finish(); }, waitMs);
  });
}

async function run() {
  console.log('\n=== Vessel Auth Test Suite ===\n');
  console.log('Backend :', WS_URL);
  console.log('Token   :', '*'.repeat(CORRECT_TOKEN.length), '(' + CORRECT_TOKEN.length + ' chars)\n');

  // ── A. Missing token ──────────────────────────────────────────────────────
  console.log('--- A. Missing token (field absent) ---');
  {
    const r = await probeHello({ token: undefined });
    const e = r.messages.find(m => m.type === 'error');
    check('Rejected — error message received', e, v => !!v);
    check('Error says Unauthorized', e, v => v && /unauthorized/i.test(v.message));
  }

  // ── B. Wrong token ────────────────────────────────────────────────────────
  console.log('\n--- B. Wrong token ---');
  {
    const r = await probeHello({ token: 'completely-wrong-token-xyzzy' });
    const e = r.messages.find(m => m.type === 'error');
    check('Rejected — error message received', e, v => !!v);
    check('Error says Unauthorized', e, v => v && /unauthorized/i.test(v.message));
    check('Error does not echo real secret', e, v => {
      if (!v) return true;
      return !v.message.includes(CORRECT_TOKEN);
    });
  }

  // ── C. Empty-string token ─────────────────────────────────────────────────
  console.log('\n--- C. Empty-string token ---');
  {
    const r = await probeHello({ token: '' });
    const e = r.messages.find(m => m.type === 'error');
    check('Rejected', e, v => !!v);
  }

  // ── D. Non-hello first message ────────────────────────────────────────────
  console.log("\n--- D. First message type != 'hello' (e.g. navigate) ---");
  {
    const r = await probeRaw(
      JSON.stringify({ type: 'navigate', url: 'https://example.com', token: CORRECT_TOKEN })
    );
    check('No messages received', r.messages, arr => arr.length === 0);
    check('Connection closed by server', r.closed, v => v === true);
  }

  // ── E. Correct token — new session ────────────────────────────────────────
  console.log('\n--- E. Correct token (new session) ---');
  {
    const r = await probeHello({ token: CORRECT_TOKEN, waitMs: 4000 });
    const authErr = r.messages.find(m => m.type === 'error' && /unauthorized/i.test(m.message));
    check('No Unauthorized error', authErr, v => !v);
    const ok = r.messages.find(m => m.type === 'status' || m.type === 'frame');
    check('Received status or frame (auth accepted)', ok, v => !!v);
    // The test session will be cleaned up after the 2-minute orphan TTL.
  }

  await new Promise(r => setTimeout(r, 300));

  // ── F. Forged session UUID + wrong token ──────────────────────────────────
  console.log('\n--- F. Forged UUID + wrong token (auth fires before session lookup) ---');
  {
    const r = await probeHello({
      token: 'attacker-token',
      sessionId: '00000000-0000-4000-a000-000000000000',
    });
    const e = r.messages.find(m => m.type === 'error');
    check('Rejected before session lookup', e, v => v && /unauthorized/i.test(v.message));
  }

  // ── G. Non-JSON first message ─────────────────────────────────────────────
  console.log('\n--- G. Non-JSON first message ---');
  {
    const r = await probeRaw('this is not json');
    check('Connection closed', r.closed, v => v === true);
    check('No messages received', r.messages, arr => arr.length === 0);
  }

  console.log('\n=== Results: ' + passed + ' passed, ' + failed + ' failed ===\n');
  if (failed > 0) {
    console.log('Some tests failed. Is the backend running with the same VESSEL_TOKEN?\n');
  }
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error('Fatal:', err.message); process.exit(1); });

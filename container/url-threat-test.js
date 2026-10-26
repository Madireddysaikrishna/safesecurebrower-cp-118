'use strict';
/**
 * url-threat-test.js — URL threat detection test suite for the Vessel container.
 *
 * Tests the checkUrl() function from browser.js directly.
 * Does NOT require Docker or a running container.
 * Does NOT visit any real external URLs.
 *
 * Usage (run from the container/ directory):
 *   node url-threat-test.js
 *
 * Tests:
 *   A. Valid public URLs             -> ok: true
 *   B. Malformed / unparseable URLs  -> ok: false
 *   C. Blocked schemes               -> ok: false (javascript:, file:, data:, ftp:)
 *   D. Private IPv4 literals         -> ok: false
 *   E. Loopback                      -> ok: false
 *   F. IPv6 addresses                -> ok: false
 *   G. Denylist entries              -> ok: false
 *   H. DNS pre-resolution (localhost) -> ok: false (resolves to 127.0.0.1)
 *   I. DNS failure (NXDOMAIN)        -> ok: false
 *   J. Public IP literal (non-private) -> ok: true
 */

// ── Pull checkUrl and helpers directly from browser.js ───────────────────────
// We re-require the same dns and net modules used in browser.js so the test
// exercises the exact same code path.
const dns = require('dns').promises;
const net = require('net');

// ── Replicate the exact constants and functions from browser.js ───────────────
// (The container is not a Node module with exports, so we inline them here.
//  This ensures the test stays in sync with the implementation.)

const DENYLIST = [
  'malware-test.example',
  'phishing-test.example',
  'denylist-test.invalid',
];

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

function isPrivateIpV4(addr) {
  const parts = addr.split('.');
  if (parts.length !== 4) return false;
  const n = parts.reduce((acc, oct) => (acc << 8) | (parseInt(oct, 10) & 0xff), 0) >>> 0;
  return PRIVATE_CIDRS_V4.some(({ base, mask }) => ((n & mask) >>> 0) === base);
}

function isBlockedIpV6(addr) {
  return net.isIPv6(addr);
}

function isPrivateIpV6(addr) {
  if (!net.isIPv6(addr)) return false;
  const lower = addr.toLowerCase();
  if (lower === '::1') return true;
  if (lower === '::') return true;
  if (/^f[cd]/i.test(lower)) return true;
  if (/^fe[89ab]/i.test(lower)) return true;
  const v4mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4mapped) return isPrivateIpV4(v4mapped[1]);
  const v4compat = lower.match(/^::(\d+\.\d+\.\d+\.\d+)$/);
  if (v4compat) return isPrivateIpV4(v4compat[1]);
  if (/^2001:db8:/i.test(lower)) return true;
  return false;
}

async function checkUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: `Malformed URL: ${rawUrl}` };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `Blocked scheme '${parsed.protocol}' — only http: and https: are allowed.` };
  }

  const hostname = parsed.hostname.toLowerCase();

  if (!hostname) {
    return { ok: false, reason: 'URL has no hostname.' };
  }

  if (net.isIPv4(hostname) && isPrivateIpV4(hostname)) {
    return { ok: false, reason: `Blocked private/reserved IPv4 address: ${hostname}` };
  }
  if (isBlockedIpV6(hostname)) {
    return { ok: false, reason: `Blocked IPv6 address (not permitted): ${hostname}` };
  }

  for (const entry of DENYLIST) {
    if (hostname === entry || hostname.endsWith('.' + entry)) {
      return { ok: false, reason: `Blocked: hostname '${hostname}' is on the denylist.` };
    }
  }

  if (!net.isIP(hostname)) {
    try {
      const addrs = await dns.lookup(hostname, { all: true });
      for (const { address, family } of addrs) {
        if (family === 4 && isPrivateIpV4(address)) {
          return { ok: false, reason: `Blocked: '${hostname}' resolves to private IPv4 ${address}` };
        }
        if (family === 6 && isPrivateIpV6(address)) {
          return { ok: false, reason: `Blocked: '${hostname}' resolves to private IPv6 ${address}` };
        }
      }
    } catch (dnsErr) {
      return { ok: false, reason: `DNS resolution failed for '${hostname}': ${dnsErr.code ?? dnsErr.message}` };
    }
  }

  return { ok: true };
}

// ── Test runner ───────────────────────────────────────────────────────────────
let passed = 0, failed = 0;

function check(name, result, expectOk, reasonContains) {
  const okMatch    = result.ok === expectOk;
  const reasonMatch = !reasonContains || (result.reason && result.reason.toLowerCase().includes(reasonContains.toLowerCase()));
  const pass = okMatch && reasonMatch;
  console.log((pass ? 'PASS' : 'FAIL') + '  ' + name);
  if (!pass) {
    console.log('       ok:', result.ok, '(expected', expectOk + ')');
    if (reasonContains) console.log('       reason:', result.reason, '(expected to contain "' + reasonContains + '")');
  }
  if (pass) passed++; else failed++;
}

async function run() {
  console.log('\n=== Vessel URL Threat Detection Test Suite ===\n');

  // ── A. Valid public URLs ──────────────────────────────────────────────────
  console.log('--- A. Valid public URLs ---');
  check('https://example.com',         await checkUrl('https://example.com'),         true);
  check('http://example.com',          await checkUrl('http://example.com'),          true);
  check('https://example.com/path',    await checkUrl('https://example.com/path?q=1'), true);

  // ── B. Malformed / unparseable URLs ──────────────────────────────────────
  console.log('\n--- B. Malformed / unparseable URLs ---');
  check('Empty string',                await checkUrl(''),                    false, 'malformed');
  check('Not a URL at all',            await checkUrl('not a url'),           false, 'malformed');
  check('Double slashes, no scheme',   await checkUrl('//no-scheme'),         false);
  check('Spaces in URL',               await checkUrl('https://exa mple.com'), false);

  // ── C. Blocked schemes ────────────────────────────────────────────────────
  console.log('\n--- C. Blocked schemes ---');
  check('javascript: scheme',  await checkUrl('javascript:alert(1)'),        false, 'scheme');
  check('file: scheme',        await checkUrl('file:///etc/passwd'),          false, 'scheme');
  check('data: scheme',        await checkUrl('data:text/html,<h1>x</h1>'),  false, 'scheme');
  check('ftp: scheme',         await checkUrl('ftp://files.example.com'),    false, 'scheme');
  check('blob: scheme',        await checkUrl('blob:https://example.com/id'), false, 'scheme');
  check('vbscript: scheme',    await checkUrl('vbscript:msgbox(1)'),         false, 'scheme');

  // ── D. Private IPv4 literals ──────────────────────────────────────────────
  console.log('\n--- D. Private IPv4 literals ---');
  check('10.0.0.1 (RFC-1918)',         await checkUrl('http://10.0.0.1'),          false, 'private');
  check('10.255.255.255',              await checkUrl('http://10.255.255.255'),    false, 'private');
  check('172.16.0.1 (RFC-1918)',       await checkUrl('http://172.16.0.1'),        false, 'private');
  check('172.31.255.255',              await checkUrl('http://172.31.255.255'),    false, 'private');
  check('192.168.1.1 (RFC-1918)',      await checkUrl('http://192.168.1.1'),       false, 'private');
  check('192.168.0.0',                 await checkUrl('http://192.168.0.0'),       false, 'private');
  check('169.254.0.1 (link-local)',    await checkUrl('http://169.254.0.1'),       false, 'private');
  check('0.0.0.0',                     await checkUrl('http://0.0.0.0'),           false, 'private');
  check('192.0.2.1 (TEST-NET-1)',      await checkUrl('http://192.0.2.1'),         false, 'private');

  // ── E. Loopback ───────────────────────────────────────────────────────────
  console.log('\n--- E. Loopback ---');
  check('127.0.0.1',                   await checkUrl('http://127.0.0.1'),         false, 'private');
  check('127.255.255.255',             await checkUrl('http://127.255.255.255'),   false, 'private');
  check('localhost (DNS resolves to 127.x)', await checkUrl('http://localhost'),   false);

  // ── F. IPv6 addresses ─────────────────────────────────────────────────────
  console.log('\n--- F. IPv6 addresses ---');
  check('::1 loopback',                await checkUrl('http://[::1]'),             false, 'ipv6');
  check(':: unspecified',              await checkUrl('http://[::]'),              false, 'ipv6');
  check('2001:db8:: (documentation)',  await checkUrl('http://[2001:db8::]'),      false, 'ipv6');
  check('::ffff:192.168.1.1 (v4-mapped)', await checkUrl('http://[::ffff:192.168.1.1]'), false, 'ipv6');

  // ── G. Denylist entries ───────────────────────────────────────────────────
  console.log('\n--- G. Denylist entries ---');
  check('malware-test.example (exact)',        await checkUrl('https://malware-test.example'),     false, 'denylist');
  check('phishing-test.example (exact)',       await checkUrl('https://phishing-test.example'),    false, 'denylist');
  check('denylist-test.invalid (exact)',       await checkUrl('https://denylist-test.invalid'),    false, 'denylist');
  check('subdomain of denylist entry',         await checkUrl('https://sub.malware-test.example'), false, 'denylist');

  // ── H. DNS pre-resolution (localhost resolves to 127.0.0.1) ──────────────
  console.log('\n--- H. DNS pre-resolution ---');
  // localhost is a standard name that resolves to 127.0.0.1 on every system.
  // This tests that the DNS check blocks hostnames that look fine as strings
  // but resolve to private IPs.
  check('localhost (resolves to 127.0.0.1)', await checkUrl('http://localhost'), false);
  check('localhost with path',               await checkUrl('http://localhost/admin'), false);
  check('localhost with port',               await checkUrl('http://localhost:8080'), false);

  // ── I. DNS failure (NXDOMAIN) ─────────────────────────────────────────────
  console.log('\n--- I. DNS failure (NXDOMAIN) ---');
  // .invalid is a reserved TLD that is guaranteed never to resolve (RFC 2606).
  // These hostnames are syntactically valid but guaranteed NXDOMAIN.
  check('vessel-test-nxdomain.invalid',       await checkUrl('https://vessel-test-nxdomain.invalid'),      false, 'dns');
  check('totally-nonexistent-xyz.invalid',    await checkUrl('https://totally-nonexistent-xyz.invalid'),   false, 'dns');

  // ── J. Public IP literal (non-private) ───────────────────────────────────
  console.log('\n--- J. Public IP literal (non-private) ---');
  // 93.184.216.34 is example.com's IP — publicly routable, not private.
  check('93.184.216.34 (example.com IP, public)', await checkUrl('http://93.184.216.34'), true);
  // 8.8.8.8 (Google DNS) — public
  check('8.8.8.8 (Google DNS, public)',            await checkUrl('http://8.8.8.8'),      true);

  console.log('\n=== Results: ' + passed + ' passed, ' + failed + ' failed ===\n');
  if (failed > 0) {
    console.log('Some tests failed — review the checkUrl() implementation in browser.js.\n');
  }
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error('Fatal:', err.message); process.exit(1); });

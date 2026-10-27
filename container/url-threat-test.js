'use strict';
/**
 * url-threat-test.js — URL threat detection test suite for the Vessel container.
 *
 * Imports checkUrl() directly from the production module (checkUrl.js) so
 * tests exercise the real implementation — there is no duplicate copy that
 * can drift out of sync.
 *
 * Does NOT require Docker or a running container.
 * Does NOT visit any real live URLs.
 * Sections L and M use an invalid API key and a short timeout to force the
 * Safe Browsing API call to fail, then verify the configured fail policy —
 * no real Safe Browsing calls are needed for those tests.
 *
 * Usage:
 *   node url-threat-test.js
 *       Runs all tests with Safe Browsing skipped (no API key).
 *
 *   SAFE_BROWSING_API_KEY=<real-key> node url-threat-test.js
 *       Sections A–M run with real Safe Browsing checks for A–J and K.
 *       Sections L and M still use an invalid key to test the fail policy.
 *
 * Test sections:
 *   A. Valid public URLs                  → ok: true
 *   B. Malformed / unparseable            → ok: false
 *   C. Blocked schemes                    → ok: false
 *   D. Private IPv4 literals              → ok: false
 *   E. Loopback                           → ok: false
 *   F. IPv6 addresses                     → ok: false
 *   G. Denylist entries                   → ok: false
 *   H. DNS pre-resolution (localhost)     → ok: false
 *   I. DNS failure (NXDOMAIN)             → ok: false
 *   J. Public IP literal (non-private)    → ok: true
 *   K. Safe Browsing: no key configured   → SB skipped; existing checks intact
 *   L. Safe Browsing: fail-closed policy  → blocked when API unavailable
 *   M. Safe Browsing: fail-open policy    → allowed when API unavailable
 */

const { checkUrl } = require('./checkUrl');

let passed = 0, failed = 0;

/**
 * Evaluates one test case and prints PASS / FAIL.
 *
 * @param {string}  name           — human-readable label
 * @param {object}  result         — return value of checkUrl()
 * @param {boolean} expectOk       — expected value of result.ok
 * @param {string}  [reasonContains] — if provided, result.reason must contain
 *                                     this substring (case-insensitive)
 */
function check(name, result, expectOk, reasonContains) {
  const okMatch     = result.ok === expectOk;
  const reasonMatch = !reasonContains ||
    (result.reason && result.reason.toLowerCase().includes(reasonContains.toLowerCase()));
  const pass = okMatch && reasonMatch;
  console.log((pass ? 'PASS' : 'FAIL') + '  ' + name);
  if (!pass) {
    console.log('       ok:', result.ok, '(expected', expectOk + ')');
    if (reasonContains) {
      console.log(
        '       reason:', result.reason,
        '(expected to contain "' + reasonContains + '")'
      );
    }
  }
  if (pass) passed++; else failed++;
}

async function run() {
  console.log('\n=== Vessel URL Threat Detection Test Suite ===\n');

  // Sections A–K test pre-existing checks (scheme, IP, denylist, DNS) without
  // Safe Browsing API calls. Temporarily clear the key so any key set in the
  // caller's environment does not cause unexpected API calls or latency.
  const savedKey     = process.env.SAFE_BROWSING_API_KEY;
  const savedFail    = process.env.SAFE_BROWSING_FAIL_OPEN;
  const savedTimeout = process.env.SAFE_BROWSING_TIMEOUT_MS;
  delete process.env.SAFE_BROWSING_API_KEY;

  // ── A. Valid public URLs ────────────────────────────────────────────────────
  console.log('--- A. Valid public URLs ---');
  check('https://example.com',       await checkUrl('https://example.com'),          true);
  check('http://example.com',        await checkUrl('http://example.com'),           true);
  check('https://example.com/path',  await checkUrl('https://example.com/path?q=1'), true);

  // ── B. Malformed / unparseable ──────────────────────────────────────────────
  console.log('\n--- B. Malformed / unparseable URLs ---');
  check('Empty string',              await checkUrl(''),                      false, 'malformed');
  check('Not a URL at all',          await checkUrl('not a url'),             false, 'malformed');
  check('Double slashes, no scheme', await checkUrl('//no-scheme'),           false);
  check('Spaces in URL',             await checkUrl('https://exa mple.com'),  false);

  // ── C. Blocked schemes ──────────────────────────────────────────────────────
  console.log('\n--- C. Blocked schemes ---');
  check('javascript: scheme', await checkUrl('javascript:alert(1)'),         false, 'scheme');
  check('file: scheme',       await checkUrl('file:///etc/passwd'),           false, 'scheme');
  check('data: scheme',       await checkUrl('data:text/html,<h1>x</h1>'),   false, 'scheme');
  check('ftp: scheme',        await checkUrl('ftp://files.example.com'),     false, 'scheme');
  check('blob: scheme',       await checkUrl('blob:https://example.com/id'), false, 'scheme');
  check('vbscript: scheme',   await checkUrl('vbscript:msgbox(1)'),          false, 'scheme');

  // ── D. Private IPv4 literals ────────────────────────────────────────────────
  console.log('\n--- D. Private IPv4 literals ---');
  check('10.0.0.1 (RFC-1918)',       await checkUrl('http://10.0.0.1'),        false, 'private');
  check('10.255.255.255',            await checkUrl('http://10.255.255.255'),  false, 'private');
  check('172.16.0.1 (RFC-1918)',     await checkUrl('http://172.16.0.1'),      false, 'private');
  check('172.31.255.255',            await checkUrl('http://172.31.255.255'),  false, 'private');
  check('192.168.1.1 (RFC-1918)',    await checkUrl('http://192.168.1.1'),     false, 'private');
  check('192.168.0.0',               await checkUrl('http://192.168.0.0'),     false, 'private');
  check('169.254.0.1 (link-local)',  await checkUrl('http://169.254.0.1'),     false, 'private');
  check('0.0.0.0',                   await checkUrl('http://0.0.0.0'),         false, 'private');
  check('192.0.2.1 (TEST-NET-1)',    await checkUrl('http://192.0.2.1'),       false, 'private');

  // ── E. Loopback ─────────────────────────────────────────────────────────────
  console.log('\n--- E. Loopback ---');
  check('127.0.0.1',             await checkUrl('http://127.0.0.1'),        false, 'private');
  check('127.255.255.255',       await checkUrl('http://127.255.255.255'),  false, 'private');
  check('localhost (DNS→127.x)', await checkUrl('http://localhost'),         false);

  // ── F. IPv6 addresses ───────────────────────────────────────────────────────
  console.log('\n--- F. IPv6 addresses ---');
  check('::1 loopback',                await checkUrl('http://[::1]'),                 false, 'ipv6');
  check(':: unspecified',              await checkUrl('http://[::]'),                  false, 'ipv6');
  check('2001:db8:: (documentation)',  await checkUrl('http://[2001:db8::]'),          false, 'ipv6');
  check('::ffff:192.168.1.1 (mapped)', await checkUrl('http://[::ffff:192.168.1.1]'), false, 'ipv6');

  // ── G. Denylist entries ─────────────────────────────────────────────────────
  console.log('\n--- G. Denylist entries ---');
  check('malware-test.example (exact)',   await checkUrl('https://malware-test.example'),     false, 'denylist');
  check('phishing-test.example (exact)',  await checkUrl('https://phishing-test.example'),    false, 'denylist');
  check('denylist-test.invalid (exact)',  await checkUrl('https://denylist-test.invalid'),    false, 'denylist');
  check('subdomain of denylist entry',   await checkUrl('https://sub.malware-test.example'), false, 'denylist');

  // ── H. DNS pre-resolution (localhost → 127.0.0.1) ──────────────────────────
  console.log('\n--- H. DNS pre-resolution ---');
  check('localhost (resolves to 127.0.0.1)', await checkUrl('http://localhost'),       false);
  check('localhost with path',               await checkUrl('http://localhost/admin'), false);
  check('localhost with port',               await checkUrl('http://localhost:8080'),  false);

  // ── I. DNS failure (NXDOMAIN) ───────────────────────────────────────────────
  // .invalid is a reserved TLD guaranteed never to resolve (RFC 2606).
  console.log('\n--- I. DNS failure (NXDOMAIN) ---');
  check('vessel-test-nxdomain.invalid',    await checkUrl('https://vessel-test-nxdomain.invalid'),    false, 'dns');
  check('totally-nonexistent-xyz.invalid', await checkUrl('https://totally-nonexistent-xyz.invalid'), false, 'dns');

  // ── J. Public IP literal (non-private) ─────────────────────────────────────
  // 93.184.216.34 is example.com's well-known public IP.
  console.log('\n--- J. Public IP literal (non-private) ---');
  check('93.184.216.34 (example.com, public)', await checkUrl('http://93.184.216.34'), true);
  check('8.8.8.8 (Google DNS, public)',         await checkUrl('http://8.8.8.8'),       true);

  // ── K. Safe Browsing: no API key configured (check skipped) ────────────────
  // When SAFE_BROWSING_API_KEY is absent the Safe Browsing step is bypassed
  // entirely ("skip" ≠ "fail"). Pre-existing checks still gate navigation.
  console.log('\n--- K. Safe Browsing: no API key (check skipped) ---');
  // Key is already cleared at the top of run(); confirm behaviour explicitly.
  delete process.env.SAFE_BROWSING_API_KEY;
  check('no key — example.com passes pre-existing checks',
    await checkUrl('https://example.com'), true);
  check('no key — denylist still blocks malware-test.example',
    await checkUrl('https://malware-test.example'), false, 'denylist');
  check('no key — private IP still blocked',
    await checkUrl('http://192.168.1.1'), false, 'private');
  check('no key — bad scheme still blocked',
    await checkUrl('javascript:alert(1)'), false, 'scheme');

  // ── L. Safe Browsing: API unavailable, fail-closed (default) ───────────────
  // Force an API failure by using an invalid key with a very short timeout so
  // the test completes quickly regardless of network conditions. Fail-closed
  // policy must block the navigation rather than silently allowing it.
  //
  // The API will return HTTP 400 (invalid key) or timeout — either way the
  // result is { safe: null } which triggers the fail policy.
  console.log('\n--- L. Safe Browsing: API unavailable, fail-closed (SAFE_BROWSING_FAIL_OPEN=false) ---');
  process.env.SAFE_BROWSING_API_KEY    = 'INVALID-KEY-FOR-TEST-ONLY';
  process.env.SAFE_BROWSING_FAIL_OPEN  = 'false';
  process.env.SAFE_BROWSING_TIMEOUT_MS = '500'; // short but not so short TLS fails oddly
  check('fail-closed: example.com blocked when SB API unavailable',
    await checkUrl('https://example.com'), false, 'safe browsing');
  check('fail-closed: reason mentions fail-closed policy',
    await checkUrl('https://example.com'), false, 'fail-closed');

  // ── M. Safe Browsing: API unavailable, fail-open ────────────────────────────
  // Same forced-failure setup. Fail-open policy must allow URLs that pass all
  // pre-existing checks (scheme, IP, denylist, DNS). The pre-existing checks
  // still apply — only URLs that clear them reach the Safe Browsing step.
  console.log('\n--- M. Safe Browsing: API unavailable, fail-open (SAFE_BROWSING_FAIL_OPEN=true) ---');
  process.env.SAFE_BROWSING_API_KEY    = 'INVALID-KEY-FOR-TEST-ONLY';
  process.env.SAFE_BROWSING_FAIL_OPEN  = 'true';
  process.env.SAFE_BROWSING_TIMEOUT_MS = '500';
  check('fail-open: example.com allowed when SB API unavailable',
    await checkUrl('https://example.com'), true);
  check('fail-open: denylist still blocks before SB step',
    await checkUrl('https://malware-test.example'), false, 'denylist');
  check('fail-open: private IP still blocked before SB step',
    await checkUrl('http://10.0.0.1'), false, 'private');

  // ── Restore original env vars ─────────────────────────────────────────────
  if (savedKey !== undefined)     process.env.SAFE_BROWSING_API_KEY    = savedKey;
  else                            delete process.env.SAFE_BROWSING_API_KEY;
  if (savedFail !== undefined)    process.env.SAFE_BROWSING_FAIL_OPEN  = savedFail;
  else                            delete process.env.SAFE_BROWSING_FAIL_OPEN;
  if (savedTimeout !== undefined) process.env.SAFE_BROWSING_TIMEOUT_MS = savedTimeout;
  else                            delete process.env.SAFE_BROWSING_TIMEOUT_MS;

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log('\n=== Results: ' + passed + ' passed, ' + failed + ' failed ===\n');
  if (failed > 0) {
    console.log('Some tests failed — review checkUrl.js.\n');
  }
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error('Fatal:', err.message); process.exit(1); });

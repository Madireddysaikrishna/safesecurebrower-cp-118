'use strict';
/**
 * checkUrl.js — URL validation and threat detection for the Vessel container.
 *
 * This is the single source of truth for URL safety decisions. It is
 * required by browser.js (runtime) and url-threat-test.js (tests), so
 * there is no duplicate implementation to drift out of sync.
 *
 * Exports:
 *   checkUrl(rawUrl)        — async → { ok: boolean, reason?: string }
 *   querySafeBrowsing(url)  — async → { safe: boolean|null, ... }
 *
 * ── Environment variables (injected into the container by server.js) ─────────
 *
 *   SAFE_BROWSING_API_KEY
 *     Google Safe Browsing Lookup API v4 key.
 *     When absent the Safe Browsing step is skipped entirely — the URL is
 *     judged only by scheme, IP, denylist, and DNS pre-resolution.
 *
 *   SAFE_BROWSING_FAIL_OPEN   (default: 'false')
 *     Controls behaviour when the API is reachable but returns an error, or
 *     when the request times out. This setting has NO effect when the API
 *     key is absent (skip ≠ fail).
 *       'false' — fail-closed (default / strict): block the navigation.
 *       'true'  — fail-open (permissive): allow navigation but log a warning.
 *
 *   SAFE_BROWSING_TIMEOUT_MS  (default: '3000')
 *     Milliseconds before the HTTPS request to the Safe Browsing API is
 *     abandoned and the fail policy is applied.
 *
 * All environment variables are read at call-time (not module-load-time) so
 * that tests can override process.env between calls without reloading the
 * module.
 */

const dns   = require('dns').promises;
const net   = require('net');
const https = require('https');

// ── Static denylist ───────────────────────────────────────────────────────────
// Exact-hostname or hostname-suffix entries blocked unconditionally, before
// any other check including Safe Browsing. Add operational entries here, or
// extend this array from a file loaded at startup.
const DENYLIST = [
  'malware-test.example',
  'phishing-test.example',
  'denylist-test.invalid',
];

// ── Private / reserved IPv4 CIDR ranges ──────────────────────────────────────
const PRIVATE_CIDRS_V4 = [
  { base: 0x7f000000, mask: 0xff000000 }, // 127.0.0.0/8    loopback
  { base: 0x0a000000, mask: 0xff000000 }, // 10.0.0.0/8     RFC-1918
  { base: 0xac100000, mask: 0xfff00000 }, // 172.16.0.0/12  RFC-1918
  { base: 0xc0a80000, mask: 0xffff0000 }, // 192.168.0.0/16 RFC-1918
  { base: 0xa9fe0000, mask: 0xffff0000 }, // 169.254.0.0/16 link-local
  { base: 0x00000000, mask: 0xffffffff }, // 0.0.0.0        unspecified
  { base: 0xc0000200, mask: 0xffffff00 }, // 192.0.2.0/24   TEST-NET-1
  { base: 0xc6336400, mask: 0xffffff00 }, // 198.51.100.0/24 TEST-NET-2
  { base: 0xcb007100, mask: 0xffffff00 }, // 203.0.113.0/24  TEST-NET-3
];

/**
 * Returns true if the IPv4 dotted-decimal address falls in any private,
 * loopback, or reserved range.
 */
function isPrivateIpV4(addr) {
  const parts = addr.split('.');
  if (parts.length !== 4) return false;
  // Use >>> 0 throughout: JS bitwise ops return signed 32-bit integers, but
  // base constants above 0x7FFFFFFF are stored as positive JS Numbers.
  const n = parts.reduce((acc, oct) => (acc << 8) | (parseInt(oct, 10) & 0xff), 0) >>> 0;
  return PRIVATE_CIDRS_V4.some(({ base, mask }) => ((n & mask) >>> 0) === base);
}

/**
 * Returns true for any IPv6 literal in a URL. We block all IPv6 URL literals
 * because the container has no legitimate use for them and each is a risk
 * vector for SSRF via IPv4-mapped or link-local addresses.
 */
function isBlockedIpV6(addr) {
  return net.isIPv6(addr);
}

/**
 * Returns true for IPv6 addresses that are private, loopback, link-local,
 * unique-local, or IPv4-mapped to a private range.
 * Used ONLY in the DNS resolution path: public AAAA records must NOT be
 * blocked by this function — use isBlockedIpV6 for literal URL hosts.
 */
function isPrivateIpV6(addr) {
  if (!net.isIPv6(addr)) return false;
  const lower = addr.toLowerCase();
  if (lower === '::1') return true;                              // loopback
  if (lower === '::')  return true;                              // unspecified
  if (/^f[cd]/i.test(lower))    return true;                    // fc00::/7  unique-local
  if (/^fe[89ab]/i.test(lower)) return true;                    // fe80::/10 link-local
  const v4mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4mapped) return isPrivateIpV4(v4mapped[1]);
  const v4compat = lower.match(/^::(\d+\.\d+\.\d+\.\d+)$/);
  if (v4compat) return isPrivateIpV4(v4compat[1]);
  if (/^2001:db8:/i.test(lower)) return true;                   // documentation
  return false;
}

// ── Google Safe Browsing ──────────────────────────────────────────────────────
const SB_ENDPOINT     = 'https://safebrowsing.googleapis.com/v4/threatMatches:find';
const SB_THREAT_TYPES = [
  'MALWARE',
  'SOCIAL_ENGINEERING',
  'UNWANTED_SOFTWARE',
  'POTENTIALLY_HARMFUL_APPLICATION',
];

/**
 * Queries the Google Safe Browsing Lookup API v4.
 *
 * All configuration is read from process.env at call-time so that tests
 * can override variables between calls without reloading the module.
 *
 * Returns one of:
 *   { safe: true }                                 — no threats found
 *   { safe: false, threatType, platformType }       — URL is listed
 *   { safe: null,  error: string }                 — API unreachable / key absent
 *
 * The caller (checkUrl) decides how to handle the null case based on the
 * SAFE_BROWSING_FAIL_OPEN policy.
 */
async function querySafeBrowsing(url) {
  const apiKey    = process.env.SAFE_BROWSING_API_KEY    || '';
  const timeoutMs = parseInt(process.env.SAFE_BROWSING_TIMEOUT_MS || '3000', 10);

  if (!apiKey) {
    return { safe: null, error: 'No API key configured — Safe Browsing skipped' };
  }

  const body = JSON.stringify({
    client: { clientId: 'safebrowser-vessel', clientVersion: '1.0.0' },
    threatInfo: {
      threatTypes:      SB_THREAT_TYPES,
      platformTypes:    ['ANY_PLATFORM'],
      threatEntryTypes: ['URL'],
      threatEntries:    [{ url }],
    },
  });

  return new Promise((resolve) => {
    // Build the request URL; encodeURIComponent keeps the key safe in the QS.
    const reqUrl  = `${SB_ENDPOINT}?key=${encodeURIComponent(apiKey)}`;
    const parsed  = new URL(reqUrl);
    const options = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    // Ensure resolve is called exactly once in all paths.
    let settled = false;
    const settle = (result) => { if (!settled) { settled = true; resolve(result); } };

    const timer = setTimeout(() => {
      req.destroy();
      settle({ safe: null, error: `Safe Browsing API timed out after ${timeoutMs} ms` });
    }, timeoutMs);

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        clearTimeout(timer);
        try {
          if (res.statusCode !== 200) {
            settle({ safe: null, error: `Safe Browsing API returned HTTP ${res.statusCode}` });
            return;
          }
          const json = JSON.parse(data);
          // An empty body ({}) means no matches — the URL is safe.
          if (json.matches && json.matches.length > 0) {
            const m = json.matches[0];
            settle({ safe: false, threatType: m.threatType, platformType: m.platformType });
          } else {
            settle({ safe: true });
          }
        } catch (e) {
          settle({ safe: null, error: `Safe Browsing API parse error: ${e.message}` });
        }
      });
    });

    req.on('error', (e) => {
      clearTimeout(timer);
      settle({ safe: null, error: `Safe Browsing API network error: ${e.message}` });
    });

    req.write(body);
    req.end();
  });
}

/**
 * Validates a URL string for safe navigation.
 *
 * Returns { ok: true } if the URL may proceed, or
 * { ok: false, reason: string } if it should be blocked.
 *
 * Checks (in order — earlier checks short-circuit later ones):
 *   1. URL must parse as a valid URL object
 *   2. Scheme must be http: or https:
 *   3. Hostname must not be empty
 *   4. Literal IP: must not be a private/reserved IPv4 or any IPv6
 *   5. Hostname must not match the static denylist (exact or suffix)
 *   6. DNS pre-resolution: resolved IPs must not be private/loopback;
 *      NXDOMAIN and SERVFAIL cause an immediate block
 *   7. Google Safe Browsing (only when SAFE_BROWSING_API_KEY is set):
 *      — confirmed threat  → always block
 *      — API unavailable   → apply SAFE_BROWSING_FAIL_OPEN policy
 *      — no key configured → skip entirely (not a fail, not a block)
 */
async function checkUrl(rawUrl) {
  // ── 1. Parse ──────────────────────────────────────────────────────────────
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: `Malformed URL: ${rawUrl}` };
  }

  // ── 2. Scheme ─────────────────────────────────────────────────────────────
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok:     false,
      reason: `Blocked scheme '${parsed.protocol}' — only http: and https: are allowed.`,
    };
  }

  const hostname = parsed.hostname.toLowerCase();

  // ── 3. Non-empty hostname ──────────────────────────────────────────────────
  if (!hostname) {
    return { ok: false, reason: 'URL has no hostname.' };
  }

  // ── 4. Literal IP checks ───────────────────────────────────────────────────
  if (net.isIPv4(hostname) && isPrivateIpV4(hostname)) {
    return { ok: false, reason: `Blocked private/reserved IPv4 address: ${hostname}` };
  }
  if (isBlockedIpV6(hostname)) {
    return { ok: false, reason: `Blocked IPv6 address (not permitted): ${hostname}` };
  }

  // ── 5. Denylist ────────────────────────────────────────────────────────────
  for (const entry of DENYLIST) {
    if (hostname === entry || hostname.endsWith('.' + entry)) {
      return { ok: false, reason: `Blocked: hostname '${hostname}' is on the denylist.` };
    }
  }

  // ── 6. DNS pre-resolution ──────────────────────────────────────────────────
  // Skip for bare IP literals — already validated in step 4.
  if (!net.isIP(hostname)) {
    try {
      const addrs = await dns.lookup(hostname, { all: true });
      for (const { address, family } of addrs) {
        if (family === 4 && isPrivateIpV4(address)) {
          return {
            ok:     false,
            reason: `Blocked: '${hostname}' resolves to private IPv4 ${address}`,
          };
        }
        // Use isPrivateIpV6 here (not isBlockedIpV6): legitimate public AAAA
        // records (e.g. example.com) must be allowed through the DNS path.
        if (family === 6 && isPrivateIpV6(address)) {
          return {
            ok:     false,
            reason: `Blocked: '${hostname}' resolves to private IPv6 ${address}`,
          };
        }
      }
    } catch (dnsErr) {
      // DNS failure (NXDOMAIN, SERVFAIL, …) — block the navigation.
      // An unresolvable host cannot be reached and must not be forwarded to
      // Chromium, which may try alternative resolution paths.
      return {
        ok:     false,
        reason: `DNS resolution failed for '${hostname}': ${dnsErr.code ?? dnsErr.message}`,
      };
    }
  }

  // ── 7. Google Safe Browsing ────────────────────────────────────────────────
  const apiKey   = process.env.SAFE_BROWSING_API_KEY || '';
  const failOpen = (process.env.SAFE_BROWSING_FAIL_OPEN || 'false').toLowerCase() === 'true';

  if (apiKey) {
    // Only call the API when a key is configured; absence of a key means
    // "skip" — not "fail". This keeps the default behaviour identical to the
    // pre-Safe-Browsing implementation.
    const sbResult = await querySafeBrowsing(rawUrl);

    if (sbResult.safe === false) {
      // Confirmed threat — block regardless of fail policy.
      return {
        ok:     false,
        reason: `Google Safe Browsing: ${sbResult.threatType} detected`,
      };
    }

    if (sbResult.safe === null) {
      // API returned an error or timed out.
      if (!failOpen) {
        // Fail-closed (default): treat an unverifiable URL as unsafe.
        return {
          ok:     false,
          reason: `Safe Browsing check failed (${sbResult.error}) — blocked by fail-closed policy`,
        };
      }
      // Fail-open: log and allow. The pre-existing checks above already ran,
      // so only URLs clear of scheme/IP/denylist/DNS issues reach this point.
      console.warn(
        `[checkUrl] Safe Browsing unavailable (${sbResult.error}) — ` +
        'allowing navigation under fail-open policy'
      );
    }
    // sbResult.safe === true → no action needed, fall through to ok: true.
  }

  return { ok: true };
}

module.exports = { checkUrl, querySafeBrowsing };

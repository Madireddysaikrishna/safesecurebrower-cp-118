'use strict';
const Docker = require('dockerode');
const { execSync } = require('child_process');
const docker = new Docker({ socketPath: '//./pipe/docker_engine' });
const IMAGE = 'browse-container:phase2';
const MEMORY_BYTES = 512 * 1024 * 1024;
const NANO_CPUS = 1.0 * 1e9;
const PIDS_LIMIT = 512;
let passed = 0, failed = 0;

function check(name, value, ok, note) {
  const result = ok(value);
  console.log((result ? 'PASS' : 'FAIL') + '  ' + name + (note ? '  [' + note + ']' : ''));
  if (result) passed++; else failed++;
}
function exec(cid, cmd) {
  try { return execSync('docker exec ' + cid + ' sh -c "' + cmd + '"', { encoding: 'utf8', timeout: 8000 }).trim(); }
  catch (e) { return (e.stderr || e.stdout || e.message || '').trim(); }
}
function execExit(cid, cmd) {
  try { execSync('docker exec ' + cid + ' sh -c "' + cmd + '"', { encoding: 'utf8', timeout: 4000 }); return 0; }
  catch (e) { return e.status || 1; }
}

async function run() {
  console.log('\n=== Vessel Browser Isolation Test ===\n');
  let container = null;
  try {
    try {
      await docker.createNetwork({ Name: 'vessel-isolated', Driver: 'bridge', CheckDuplicate: true,
        Options: { 'com.docker.network.bridge.enable_ip_masquerade': 'true', 'com.docker.network.bridge.enable_icc': 'false' } });
      console.log('[test] Created vessel-isolated network.');
    } catch (e) { if (e.statusCode !== 409) throw e; console.log('[test] vessel-isolated network already exists.'); }

    container = await docker.createContainer({
      Image: IMAGE,
      HostConfig: { AutoRemove: false, NetworkMode: 'vessel-isolated',
        PortBindings: { '3001/tcp': [{ HostPort: '30099' }] },
        Memory: MEMORY_BYTES, MemorySwap: MEMORY_BYTES, NanoCpus: NANO_CPUS, PidsLimit: PIDS_LIMIT, ReadonlyRootfs: false }
    });
    await container.start();
    const id = container.id.slice(0, 12);
    console.log('[test] Container started: ' + id + '\n');
    await new Promise(r => setTimeout(r, 3000));

    const info = await container.inspect();
    const hc = info.HostConfig, state = info.State;

    console.log('--- A. Lifecycle ---');
    check('Container running',       state.Running,  v => v === true);
    check('Not privileged',          hc.Privileged,  v => v === false);

    console.log('\n--- B. User identity ---');
    const whoami = exec(id, 'whoami');
    check('Runs as browser (non-root)', whoami, v => v === 'browser', whoami);
    const uid = exec(id, 'id -u');
    check('UID > 0 (not root)',      uid, v => parseInt(v, 10) > 0, 'uid=' + uid);
    // Extract only hex chars from "CapEff:   0000000000000000"
    const capLine = exec(id, 'grep CapEff /proc/1/status');
    const capHex = (capLine.match(/[0-9a-fA-F]{8,}/) || ['ffffffff'])[0];
    check('CapEff = 0x0 (no effective capabilities)', capHex, v => parseInt(v, 16) === 0, 'CapEff=0x' + capHex);

    console.log('\n--- C. Resource limits ---');
    check('Memory = 512 MB',         hc.Memory,    v => v === MEMORY_BYTES);
    check('MemorySwap = Memory',      hc.MemorySwap,v => v === MEMORY_BYTES);
    check('NanoCpus = 1 core',        hc.NanoCpus,  v => v === NANO_CPUS);
    check('PidsLimit = 512',          hc.PidsLimit,  v => v === PIDS_LIMIT);

    console.log('\n--- D. Network ---');
    check('NetworkMode = vessel-isolated', hc.NetworkMode, v => v === 'vessel-isolated');
    const http = exec(id, 'curl -s --max-time 5 -o /dev/null -w "%{http_code}" https://example.com');
    check('Internet reachable (Chromium needs it)', http, v => v === '200', 'HTTP ' + http);

    console.log('\n--- E. Filesystem ---');
    const exitCode = execExit(id, 'touch /app/canary');
    check('/app not writable by browser user', exitCode, v => v !== 0, 'exit=' + exitCode);

    console.log('\n--- F. Browser location ---');
    let chromiumOnHost = false;
    try { chromiumOnHost = execSync('tasklist /FI "IMAGENAME eq chromium.exe" 2>nul', { encoding: 'utf8', timeout: 3000 }).toLowerCase().includes('chromium.exe'); } catch (_) {}
    check('Chromium NOT running on host', chromiumOnHost, v => v === false);
    const nodeInCtr = exec(id, 'pgrep -a node');
    check('node browser.js runs in container', nodeInCtr, v => v.includes('browser.js'), nodeInCtr);

  } finally {
    if (container) { try { await container.stop({ t: 2 }); } catch (_) {} try { await container.remove(); } catch (_) {} }
  }

  console.log('\n=== Results: ' + passed + ' passed, ' + failed + ' failed ===\n');
  process.exit(failed > 0 ? 1 : 0);
}
run().catch(err => { console.error('Fatal:', err.message); process.exit(1); });

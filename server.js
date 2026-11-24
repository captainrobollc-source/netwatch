// netwatch: logs internet speed and outages from an always-on device.
// No dependencies. Data lives in ./data (kept across Pocket deploys).
'use strict';
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DATA = path.join(__dirname, 'data');
const PUBLIC = path.join(__dirname, 'public');
fs.mkdirSync(DATA, { recursive: true });

const FILES = {
  speed: path.join(DATA, 'speedtests.jsonl'),
  outages: path.join(DATA, 'outages.json'),
  state: path.join(DATA, 'state.json'),
  settings: path.join(DATA, 'settings.json'),
};

const CHECK_EVERY_MS = Number(process.env.CHECK_EVERY_MS || 20_000); // connectivity probe interval
const FAILS_TO_DECLARE_DOWN = 2;    // consecutive failed probes before an outage starts
const PROBES = (process.env.PROBES || '1.1.1.1:443,8.8.8.8:443,9.9.9.9:443')
  .split(',').map(s => { const [h, p] = s.trim().split(':'); return [h, Number(p || 443)]; });
// ---------- persistence ----------
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJSON(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
  fs.renameSync(tmp, file);
}
function readSpeedtests() {
  try {
    return fs.readFileSync(FILES.speed, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch { return []; }
}

const DEFAULT_SETTINGS = { planDown: 0, planUp: 0, intervalMin: 60, gateway: process.env.GATEWAY || '192.168.0.1' };
let settings = { ...DEFAULT_SETTINGS, ...readJSON(FILES.settings, {}) };
let outages = readJSON(FILES.outages, []);
let state = readJSON(FILES.state, { startedAt: Date.now() });
let speedtests = readSpeedtests();

// ---------- alerts through Pocket ----------
async function notify(title, message, level = 'info') {
  console.log(`[alert] ${title}: ${message}`);
  if (!process.env.POCKET_URL || !process.env.POCKET_APP_TOKEN) return;
  try {
    await fetch(`${process.env.POCKET_URL}/api/notify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.POCKET_APP_TOKEN}` },
      body: JSON.stringify({ title, message, level }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) { console.log('[alert] could not send:', e.message); }
}

// ---------- connectivity ----------
// Resolves true if the host answered at all (a refused connection still proves it is reachable).
function tcpReachable(host, port, timeoutMs = 3000) {
  return new Promise(resolve => {
    const s = net.connect({ host, port });
    const done = ok => { s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', e => done(e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET'));
  });
}
async function internetUp() {
  const results = await Promise.all(PROBES.map(([h, p]) => tcpReachable(h, p)));
  return results.some(Boolean);
}

let failStreak = 0;
let current = null;           // open outage while down
let lastCheck = null;
let routerSeenDuringOutage = null;
const openOutage = outages.find(o => !o.end);
if (openOutage) current = openOutage; // app restarted during an outage

async function checkConnectivity() {
  const up = await internetUp();
  lastCheck = Date.now();
  if (up) {
    failStreak = 0;
    if (current) {
      current.end = Date.now();
      current.durationSec = Math.round((current.end - current.start) / 1000);
      writeJSON(FILES.outages, outages);
      const where = current.routerReachable === false ? 'The router was unreachable too, so it was a Wi-Fi or router problem.'
        : current.routerReachable ? 'The router was fine, so the problem was with your provider.' : '';
      const endTime = new Date(current.end).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      notify('Internet is back', `Down for ${fmtDuration(current.durationSec)} (${fmtTime(current.start)} – ${endTime}). ${where}`.trim(), 'warn');
      current = null;
      routerSeenDuringOutage = null;
    }
    return;
  }
  failStreak++;
  if (!current && failStreak >= FAILS_TO_DECLARE_DOWN) {
    current = { start: Date.now() - (failStreak - 1) * CHECK_EVERY_MS, end: null, routerReachable: null };
    outages.push(current);
    console.log('[outage] internet down');
  }
  if (current) {
    const router = await tcpReachable(settings.gateway, 80, 2000) || await tcpReachable(settings.gateway, 53, 2000);
    // Remember if the router answered at any point during the outage.
    if (router) current.routerReachable = true;
    else if (current.routerReachable !== true) current.routerReachable = false;
    writeJSON(FILES.outages, outages);
  }
}

// ---------- speed test (Cloudflare's public speed endpoints) ----------
let testRunning = false;
async function runSpeedtest(trigger = 'scheduled') {
  if (testRunning || current) return null;
  testRunning = true;
  const result = { t: Date.now(), trigger };
  try {
    const out = await new Promise((resolve, reject) => {
      execFile(process.execPath, [path.join(__dirname, 'speedtest.js')], { timeout: 90_000, maxBuffer: 1e6 },
        (err, stdout) => err ? reject(err) : resolve(stdout));
    });
    Object.assign(result, JSON.parse(out));
  } catch (e) {
    result.error = e.killed ? 'Test timed out' : e.message;
  } finally {
    testRunning = false;
  }
  speedtests.push(result);
  fs.appendFileSync(FILES.speed, JSON.stringify(result) + '\n');
  console.log('[speedtest]', JSON.stringify(result));
  checkSlowStreak();
  return result;
}

function checkSlowStreak() {
  if (!settings.planDown) return;
  const last3 = speedtests.filter(s => !s.error).slice(-3);
  if (last3.length < 3 || !last3.every(s => s.down < settings.planDown * 0.5)) return;
  const today = new Date().toDateString();
  if (state.slowAlertDay === today) return;
  state.slowAlertDay = today;
  writeJSON(FILES.state, state);
  const avg = last3.reduce((a, s) => a + s.down, 0) / 3;
  notify('Internet is slow', `Last 3 tests averaged ${avg.toFixed(0)} Mbps, under half of the ${settings.planDown} Mbps you pay for.`, 'warn');
}

let nextTestAt = 0;
function scheduleTests() {
  const last = speedtests.at(-1);
  const due = last ? last.t + settings.intervalMin * 60_000 : Date.now() + 15_000;
  nextTestAt = Math.max(due, Date.now() + 15_000);
}
setInterval(async () => {
  if (Date.now() >= nextTestAt && !testRunning) {
    await runSpeedtest();
    nextTestAt = Date.now() + settings.intervalMin * 60_000;
  }
}, 10_000);

// ---------- helpers ----------
function fmtDuration(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`, !d && !h && `${s}s`].filter(Boolean).join(' ');
}
function fmtTime(t) {
  return new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function summary() {
  const now = Date.now();
  const uptime = days => {
    const from = Math.max(now - days * 864e5, state.startedAt);
    const span = now - from;
    if (span <= 0) return null;
    let down = 0;
    for (const o of outages) {
      const s = Math.max(o.start, from), e = Math.min(o.end || now, now);
      if (e > s) down += e - s;
    }
    return +(100 * (1 - down / span)).toFixed(3);
  };
  const avg = (days, key) => {
    const xs = speedtests.filter(s => !s.error && s.t > now - days * 864e5).map(s => s[key]);
    return xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1) : null;
  };
  const lastUp = outages.filter(o => o.end).at(-1);
  return {
    online: !current,
    since: current ? current.start : (lastUp ? lastUp.end : state.startedAt),
    lastCheck,
    testRunning,
    nextTestAt,
    monitoringSince: state.startedAt,
    settings,
    uptime: { d1: uptime(1), d7: uptime(7), d30: uptime(30) },
    avg: {
      d1: { down: avg(1, 'down'), up: avg(1, 'up'), ping: avg(1, 'pingMs') },
      d7: { down: avg(7, 'down'), up: avg(7, 'up'), ping: avg(7, 'pingMs') },
    },
    last: speedtests.at(-1) || null,
    outageCount30: outages.filter(o => o.start > now - 30 * 864e5).length,
  };
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/healthz') return send(res, 200, 'ok', 'text/plain');
    if (url.pathname === '/api/summary') return send(res, 200, summary());
    if (url.pathname === '/api/speedtests') {
      const days = Math.min(Number(url.searchParams.get('days')) || 7, 365);
      const from = Date.now() - days * 864e5;
      return send(res, 200, speedtests.filter(s => s.t > from));
    }
    if (url.pathname === '/api/outages') return send(res, 200, outages.slice(-200).reverse());
    if (url.pathname === '/api/test' && req.method === 'POST') {
      if (testRunning) return send(res, 409, { error: 'A test is already running' });
      if (current) return send(res, 409, { error: 'The internet is down right now' });
      const r = await runSpeedtest('manual');
      nextTestAt = Date.now() + settings.intervalMin * 60_000;
      return send(res, 200, r);
    }
    if (url.pathname === '/api/settings' && req.method === 'POST') {
      const b = await readBody(req);
      const num = (v, min, max) => Math.min(max, Math.max(min, Number(v) || 0));
      if ('planDown' in b) settings.planDown = num(b.planDown, 0, 100000);
      if ('planUp' in b) settings.planUp = num(b.planUp, 0, 100000);
      if ('intervalMin' in b) settings.intervalMin = num(b.intervalMin, 15, 1440);
      if (typeof b.gateway === 'string' && /^[\w.:-]{1,64}$/.test(b.gateway)) settings.gateway = b.gateway;
      writeJSON(FILES.settings, settings);
      scheduleTests();
      return send(res, 200, settings);
    }
    // static files
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.join(PUBLIC, path.normalize(rel));
    if (!file.startsWith(PUBLIC)) return send(res, 404, 'not found', 'text/plain');
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, 'not found', 'text/plain');
      send(res, 200, data, MIME[path.extname(file)] || 'application/octet-stream');
    });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: e.message });
  }
});

if (!fs.existsSync(FILES.state)) writeJSON(FILES.state, state);
scheduleTests();
checkConnectivity();
setInterval(checkConnectivity, CHECK_EVERY_MS);
server.listen(PORT, HOST, () => console.log(`netwatch listening on ${HOST}:${PORT}`));

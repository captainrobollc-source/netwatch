// Runs one speed test against Cloudflare's public speed endpoints and prints the result as JSON.
// Runs as its own short-lived process so the memory it uses is handed back when it exits.
'use strict';
const CF = 'https://speed.cloudflare.com';

async function measureLatency() {
  const samples = [];
  for (let i = 0; i < 8; i++) {
    const t0 = performance.now();
    const r = await fetch(`${CF}/__down?bytes=0`, { signal: AbortSignal.timeout(5000) });
    await r.arrayBuffer();
    // Take out the time Cloudflare spent handling the request, leaving the network round trip.
    const serverMs = [...(r.headers.get('server-timing') || '').matchAll(/dur=([\d.]+)/g)].reduce((a, m) => a + Number(m[1]), 0);
    if (i > 0) samples.push(Math.max(0.1, performance.now() - t0 - serverMs)); // first one includes the TLS handshake
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  let jitter = 0;
  for (let i = 1; i < samples.length; i++) jitter += Math.abs(samples[i] - samples[i - 1]);
  return { pingMs: +median.toFixed(1), jitterMs: +(jitter / (samples.length - 1)).toFixed(1) };
}

// Runs `streams` parallel workers until maxMs or maxBytes; returns Mbps.
async function measureThroughput(kind, { streams, maxMs, maxBytes }) {
  const ctrl = new AbortController();
  const start = performance.now();
  let bytes = 0;
  const timer = setTimeout(() => ctrl.abort(), maxMs);
  const chunk = kind === 'up' ? Buffer.alloc(4_000_000, 'x') : null;
  const worker = async () => {
    while (!ctrl.signal.aborted && bytes < maxBytes) {
      if (kind === 'down') {
        const r = await fetch(`${CF}/__down?bytes=25000000`, { signal: ctrl.signal });
        for await (const part of r.body) {
          bytes += part.length;
          if (bytes >= maxBytes) { ctrl.abort(); break; }
        }
      } else {
        const r = await fetch(`${CF}/__up`, { method: 'POST', body: chunk, signal: ctrl.signal });
        await r.arrayBuffer();
        bytes += chunk.length;
        if (bytes >= maxBytes) ctrl.abort();
      }
    }
  };
  await Promise.allSettled(Array.from({ length: streams }, worker));
  clearTimeout(timer);
  const secs = (performance.now() - start) / 1000;
  return +((bytes * 8) / secs / 1e6).toFixed(1);
}

(async () => {
  const result = {};
  try {
    Object.assign(result, await measureLatency());
    result.down = await measureThroughput('down', { streams: 4, maxMs: 8000, maxBytes: 100e6 });
    result.up = await measureThroughput('up', { streams: 2, maxMs: 6000, maxBytes: 30e6 });
  } catch (e) {
    result.error = e.message;
  }
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
})();

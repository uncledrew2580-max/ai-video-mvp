#!/usr/bin/env node
// P14-B3: wait for the local workspace UI to answer, then open it in the default
// browser. Backgrounded by "AI Video.cmd" because client/launcher.mjs blocks and
// its mac `open` browser call is a no-op on Windows. Best-effort: any failure is
// silent (the cmd window still shows the URL). No model calls, no paid APIs.
import { spawn } from 'node:child_process';
import http from 'node:http';

const url = process.argv[2] || 'http://127.0.0.1:18788/';
const deadline = Date.now() + 180000; // poll up to 3 min for first boot
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ping(u) {
  return new Promise((resolve) => {
    const req = http.get(u, (r) => { r.resume(); resolve((r.statusCode || 0) > 0 && r.statusCode < 500); });
    req.setTimeout(2000, () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

while (Date.now() < deadline) {
  if (await ping(url)) {
    try {
      // `start "" <url>` opens the default browser without blocking.
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } catch {}
    break;
  }
  await sleep(2000);
}

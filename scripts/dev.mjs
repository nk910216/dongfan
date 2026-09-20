#!/usr/bin/env node
/**
 * Starts the worker and the web server together, for use from a phone.
 *
 * Two processes and two ports is easy to get half right, and the way it
 * goes wrong is silent: `vite` refuses to start when something already
 * holds its port, the shell prints a stack trace nobody reads, and the
 * phone goes on talking to whatever was there before. One dev server left
 * running from the morning will happily serve a build from before the
 * login screen existed -- the browser cannot tell, and neither can you.
 *
 * So this checks the ports first and says who is holding them, prints the
 * address to type into the phone, and stops both halves together.
 *
 * Everything here is local. It never deploys and never reaches a remote
 * database (spec 13.5).
 */

import { execFileSync, spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const WEB_PORT = 5180;
const API_PORT = 8787;

/** Who is listening on a port, if anyone. */
function holder(port) {
  try {
    const pids = execFileSync('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .filter(Boolean);

    if (pids.length === 0) return null;

    const detail = execFileSync('ps', ['-o', 'lstart=,command=', '-p', pids[0]], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    return { pid: pids[0], detail };
  } catch {
    // No listener, or no lsof. Either way there is nothing to report.
    return null;
  }
}

function checkPorts() {
  const busy = [];
  for (const [port, what] of [[WEB_PORT, 'the web server'], [API_PORT, 'the worker']]) {
    const found = holder(port);
    if (found) busy.push({ port, what, ...found });
  }

  if (busy.length === 0) return;

  console.error('\nSomething is already listening:\n');
  for (const entry of busy) {
    console.error(`  port ${entry.port}, where ${entry.what} goes`);
    console.error(`    pid ${entry.pid}  ${entry.detail}\n`);
  }
  console.error('Nothing has been started. An old dev server serves the code it');
  console.error('had when it started, so a phone pointed at it can be several');
  console.error('hours behind and look completely normal.\n');
  console.error(`Stop them with:  kill ${busy.map((entry) => entry.pid).join(' ')}`);
  process.exit(1);
}

/** The address a phone on the same network can reach. */
function lanAddress() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return null;
}

function run(label, command, args) {
  const child = spawn(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });

  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      for (const line of chunk.split('\n')) {
        if (line.trim() !== '') console.log(`${label} ${line}`);
      }
    });
  }

  child.on('exit', (code) => {
    // One half without the other is not worth having: the app would load
    // and every request would fail, which reads as a broken app.
    console.error(`\n${label} exited (${code}). Stopping.`);
    stop(code ?? 1);
  });

  return child;
}

const children = [];
let stopping = false;

function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 200);
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

checkPorts();

// The worker serves packages/web/dist through its assets binding and will
// not start without it. Vite serves the app itself; this build is what
// makes port 8787 a fair approximation of a deployment.
console.log('Building the web assets for the worker...');
execFileSync('npm', ['run', 'build', '-w', '@dongfan/web'], { cwd: ROOT, stdio: 'inherit' });

children.push(run('[api]', 'npm', ['run', 'dev', '-w', '@dongfan/api']));
children.push(run('[web]', 'npm', ['run', 'dev', '-w', '@dongfan/web']));

const lan = lanAddress();
setTimeout(() => {
  console.log('\n──────────────────────────────────────────────');
  console.log(`  On this machine   http://localhost:${WEB_PORT}`);
  if (lan) console.log(`  On your phone     http://${lan}:${WEB_PORT}`);
  else console.log('  On your phone     no network address found');
  console.log('');
  console.log(`  The worker alone  http://localhost:${API_PORT}`);
  console.log('    serves the built assets the way a deployment would,');
  console.log('    so /api/* routing and the SPA fallback can be checked there.');
  console.log('    It listens on this machine only, not on the network.');
  console.log('');
  console.log('  Accounts          npm run users -- list');
  console.log('  New password      npm run users -- password <name>');
  console.log('──────────────────────────────────────────────\n');
}, 6000);

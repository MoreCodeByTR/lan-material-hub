#!/usr/bin/env node

const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const viteBin = path.join(ROOT_DIR, 'node_modules', 'vite', 'bin', 'vite.js');

function getLanAddresses() {
  const addresses = [];
  const networks = os.networkInterfaces();

  for (const entries of Object.values(networks)) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (entry.address.startsWith('169.254.')) continue;
      addresses.push(entry.address);
    }
  }

  return addresses;
}

function pipeLines(stream, onLine) {
  const reader = readline.createInterface({ input: stream });
  reader.on('line', onLine);
  return reader;
}

function parsePort(line) {
  const match = line.match(/https?:\/\/[^\s:]+:(\d+)/);
  return match ? Number(match[1]) : null;
}

function startApi() {
  return new Promise((resolve, reject) => {
    const api = spawn(process.execPath, ['server.js'], {
      cwd: ROOT_DIR,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let resolved = false;

    const handleLine = (line, isError = false) => {
      const port = parsePort(line);
      if (!resolved && port) {
        resolved = true;
        resolve({ api, port });
      }
      const output = isError ? process.stderr : process.stdout;
      output.write(`[api] ${line}\n`);
    };

    pipeLines(api.stdout, (line) => handleLine(line));
    pipeLines(api.stderr, (line) => handleLine(line, true));

    api.on('exit', (code) => {
      if (!resolved) reject(new Error(`API server exited with code ${code}`));
    });
  });
}

function startVite(apiPort) {
  const vite = spawn(process.execPath, [viteBin, '--host', '0.0.0.0'], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      API_TARGET: `http://localhost:${apiPort}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const filterViteLine = (line, isError = false) => {
    if (/Local:/i.test(line) || /localhost/i.test(line)) return;
    if (/169\.254\./.test(line)) return;
    const output = isError ? process.stderr : process.stdout;
    output.write(`[web] ${line}\n`);
  };

  pipeLines(vite.stdout, (line) => filterViteLine(line));
  pipeLines(vite.stderr, (line) => filterViteLine(line, true));
  return vite;
}

function stop(child) {
  if (!child || child.killed) return;
  child.kill('SIGTERM');
}

async function main() {
  const { api, port } = await startApi();
  const vite = startVite(port);

  const vitePort = process.env.VITE_PORT || 5173;
  const networkUrls = getLanAddresses().map((address) => `http://${address}:${vitePort}`);
  console.log('[web] LAN Material Hub dev page');
  console.log(`[web] - http://localhost:${vitePort}`);
  if (networkUrls.length > 0) {
    for (const url of networkUrls) console.log(`[web] - ${url}`);
  }

  const shutdown = () => {
    stop(vite);
    stop(api);
  };

  process.on('SIGINT', () => {
    shutdown();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    shutdown();
    process.exit(143);
  });

  api.on('exit', (code) => {
    stop(vite);
    process.exit(code || 0);
  });
  vite.on('exit', (code) => {
    stop(api);
    process.exit(code || 0);
  });
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

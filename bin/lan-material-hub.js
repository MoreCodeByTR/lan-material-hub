#!/usr/bin/env node

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const SERVER_ENTRY = path.join(ROOT_DIR, 'server.js');
const HOME_DIR = path.resolve(process.env.LAN_MATERIAL_HUB_HOME || path.join(os.homedir(), '.lan-material-hub'));
const PID_FILE = path.resolve(process.env.LAN_MATERIAL_HUB_PID_FILE || path.join(HOME_DIR, 'lan-material-hub.pid'));
const LOG_FILE = path.resolve(process.env.LAN_MATERIAL_HUB_LOG_FILE || path.join(HOME_DIR, 'lan-material-hub.log'));

function usage() {
  console.log(`LAN Material Hub

Usage:
  lan-material-hub start [--nickname <name>]
  lan-material-hub stop
  lan-material-hub status

Environment:
  PORT                  起始端口，默认 7788
  PORT_RETRY_LIMIT      端口被占用时向后重试次数，默认 20
  HOST                  监听地址，默认 0.0.0.0
  DATA_DIR              素材保存目录
  LAN_MATERIAL_HUB_NICKNAME 站点昵称
  LAN_MATERIAL_HUB_HOME PID 和日志目录`);
}

function readPidInfo() {
  try {
    const content = fs.readFileSync(PID_FILE, 'utf8');
    try {
      return JSON.parse(content);
    } catch (_error) {
      return { pid: Number(content.trim()) };
    }
  } catch (_error) {
    return null;
  }
}

function isRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function removePidFile() {
  await fsp.unlink(PID_FILE).catch(() => undefined);
}

async function fileSize(filePath) {
  try {
    const stat = await fsp.stat(filePath);
    return stat.size;
  } catch (_error) {
    return 0;
  }
}

async function readNewLogLines(offset) {
  try {
    const handle = await fsp.open(LOG_FILE, 'r');
    try {
      const stat = await handle.stat();
      const length = Math.max(0, stat.size - offset);
      if (length === 0) return [];

      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, offset);
      return buffer.toString('utf8').split(/\r?\n/).filter(Boolean);
    } finally {
      await handle.close();
    }
  } catch (_error) {
    return [];
  }
}

async function waitForStartupLines(offset, timeout = 5000) {
  const started = Date.now();
  let lines = [];

  while (Date.now() - started < timeout) {
    lines = await readNewLogLines(offset);
    if (lines.some((line) => line.startsWith('Data directory:'))) return lines;
    if (lines.some((line) => line.startsWith('Failed to start:'))) return lines;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  return lines;
}

function parseStartOptions(args) {
  const options = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--nickname' || arg === '--name' || arg === '--site-name' || arg === '-n') {
      options.nickname = args[index + 1] || '';
      index += 1;
    } else if (arg.startsWith('--nickname=')) {
      options.nickname = arg.slice('--nickname='.length);
    } else if (arg.startsWith('--name=')) {
      options.nickname = arg.slice('--name='.length);
    } else if (arg.startsWith('--site-name=')) {
      options.nickname = arg.slice('--site-name='.length);
    }
  }

  return options;
}

async function start(options = {}) {
  await fsp.mkdir(HOME_DIR, { recursive: true });

  const previous = readPidInfo();
  if (previous?.pid && isRunning(previous.pid)) {
    console.log(`LAN Material Hub is already running, pid ${previous.pid}`);
    console.log(`Log file: ${previous.logFile || LOG_FILE}`);
    return;
  }

  await removePidFile();

  const logOffset = await fileSize(LOG_FILE);
  const out = fs.openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: ROOT_DIR,
    detached: true,
    env: {
      ...process.env,
      LAN_MATERIAL_HUB_MANAGED: '1',
      LAN_MATERIAL_HUB_NICKNAME: options.nickname || process.env.LAN_MATERIAL_HUB_NICKNAME || '',
    },
    stdio: ['ignore', out, out],
  });

  child.unref();
  fs.writeFileSync(PID_FILE, JSON.stringify({
    pid: child.pid,
    startedAt: new Date().toISOString(),
    cwd: ROOT_DIR,
    logFile: LOG_FILE,
  }, null, 2));

  console.log(`LAN Material Hub started, pid ${child.pid}`);
  const startupLines = await waitForStartupLines(logOffset);
  for (const line of startupLines) console.log(line);
  console.log(`Log file: ${LOG_FILE}`);
}

async function stop() {
  const current = readPidInfo();
  if (!current?.pid) {
    console.log('LAN Material Hub is not running');
    return;
  }

  if (!isRunning(current.pid)) {
    await removePidFile();
    console.log('LAN Material Hub is not running');
    return;
  }

  process.kill(current.pid, 'SIGTERM');

  const started = Date.now();
  while (Date.now() - started < 5000) {
    if (!isRunning(current.pid)) {
      await removePidFile();
      console.log('LAN Material Hub stopped');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  process.kill(current.pid, 'SIGKILL');
  await removePidFile();
  console.log('LAN Material Hub stopped');
}

async function status() {
  const current = readPidInfo();
  if (current?.pid && isRunning(current.pid)) {
    console.log(`LAN Material Hub is running, pid ${current.pid}`);
    console.log(`Log file: ${current.logFile || LOG_FILE}`);
    return;
  }

  if (current?.pid) await removePidFile();
  console.log('LAN Material Hub is not running');
}

async function main() {
  const command = process.argv[2];
  const args = process.argv.slice(3);

  if (command === 'start') {
    await start(parseStartOptions(args));
  } else if (command === 'stop') {
    await stop();
  } else if (command === 'status') {
    await status();
  } else {
    usage();
    process.exit(command ? 1 : 0);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

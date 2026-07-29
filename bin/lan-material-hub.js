#!/usr/bin/env node

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const packageJson = require('../package.json');

const ROOT_DIR = path.resolve(__dirname, '..');
const SERVER_ENTRY = path.join(ROOT_DIR, 'server.js');
const HOME_DIR = path.resolve(process.env.LAN_MATERIAL_HUB_HOME || path.join(os.homedir(), '.lan-material-hub'));
const PID_FILE = path.resolve(process.env.LAN_MATERIAL_HUB_PID_FILE || path.join(HOME_DIR, 'lan-material-hub.pid'));
const LOG_FILE = path.resolve(process.env.LAN_MATERIAL_HUB_LOG_FILE || path.join(HOME_DIR, 'lan-material-hub.log'));
const COLORS_ENABLED = !process.env.NO_COLOR && (process.stdout.isTTY || process.env.FORCE_COLOR);
const COLOR = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  gray: '\x1b[90m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
};

function color(name, text) {
  if (!COLORS_ENABLED) return text;
  return `${COLOR[name] || ''}${text}${COLOR.reset}`;
}

function infoLabel() {
  return color('green', '[i]');
}

function warnLabel() {
  return color('yellow', '[!]');
}

function errorLabel() {
  return color('red', '[x]');
}

function commandLabel() {
  return `${color('green', '›')} ${color('green', 'lan-material-hub start')}`;
}

function isLocalUrl(value) {
  try {
    const url = new URL(value);
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  } catch (_error) {
    return false;
  }
}

function startupSummary(lines) {
  const summary = {
    dataDir: '',
    failed: '',
    migrated: '',
    nickname: '',
    portSwitch: '',
    urls: [],
    warnings: [],
    other: [],
  };

  for (const line of lines) {
    if (line.startsWith('LAN Material Hub is running:')) {
      summary.nickname = line.slice('LAN Material Hub is running:'.length).trim();
    } else if (line.startsWith('- ')) {
      summary.urls.push(line.slice(2).trim());
    } else if (line.startsWith('Data directory:')) {
      summary.dataDir = line.slice('Data directory:'.length).trim();
    } else if (line.startsWith('Requested port ')) {
      summary.portSwitch = line;
    } else if (line.startsWith('Migrated data directory:')) {
      summary.migrated = line.slice('Migrated data directory:'.length).trim();
    } else if (line.startsWith('Port ') || line.startsWith('Failed to start:')) {
      if (line.startsWith('Failed to start:')) summary.failed = line;
      else summary.warnings.push(line);
    } else {
      summary.other.push(line);
    }
  }

  return summary;
}

function printStartupOutput(pid, lines) {
  const summary = startupSummary(lines);
  const version = packageJson.version ? `@${packageJson.version}` : '';

  console.log(`${color('gray', 'Log file:')} ${LOG_FILE}`);
  console.log(commandLabel());

  if (summary.failed) {
    console.log(`${errorLabel()} ${color('red', summary.failed)}`);
    return;
  }

  console.log(`${infoLabel()} ${color('green', `LAN Material Hub${version} started`)} ${color('gray', `(pid ${pid})`)}`);
  if (summary.nickname) {
    console.log(`${infoLabel()} Site: ${color('bold', summary.nickname)}`);
  }
  if (summary.portSwitch) {
    console.log(`${warnLabel()} ${color('yellow', summary.portSwitch)}`);
  }
  for (const warning of summary.warnings) {
    console.log(`${warnLabel()} ${color('yellow', warning)}`);
  }
  if (summary.migrated) {
    console.log(`${infoLabel()} Data migrated: ${summary.migrated}`);
  }
  if (summary.urls.length > 0) {
    console.log(`${infoLabel()} Use your device to visit:`);
    for (const url of summary.urls) {
      console.log(`    ${color(isLocalUrl(url) ? 'cyan' : 'green', url)}`);
    }
    console.log(`${warnLabel()} If mobile devices cannot open the network URL, check Wi-Fi and firewall settings.`);
  }
  if (summary.dataDir) {
    console.log(`${infoLabel()} Data directory: ${summary.dataDir}`);
  }
  for (const line of summary.other) {
    console.log(`${infoLabel()} ${line}`);
  }
}

function usage() {
  console.log(`LAN Material Hub

Usage:
  lan-material-hub start
  lan-material-hub stop
  lan-material-hub status

Environment:
  PORT                  起始端口，默认 7788
  PORT_RETRY_LIMIT      端口被占用时向后重试次数，默认 20
  HOST                  监听地址，默认 0.0.0.0
  DATA_DIR              素材保存目录
  LAN_MATERIAL_HUB_NICKNAME 站点昵称
  LAN_MATERIAL_HUB_HOME PID、日志和默认素材目录`);
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

async function start() {
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
  const childEnv = {
    ...process.env,
    LAN_MATERIAL_HUB_MANAGED: '1',
  };
  delete childEnv.FORCE_COLOR;

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: ROOT_DIR,
    detached: true,
    env: childEnv,
    stdio: ['ignore', out, out],
  });

  child.unref();
  fs.writeFileSync(PID_FILE, JSON.stringify({
    pid: child.pid,
    startedAt: new Date().toISOString(),
    cwd: ROOT_DIR,
    logFile: LOG_FILE,
  }, null, 2));

  const startupLines = await waitForStartupLines(logOffset);
  printStartupOutput(child.pid, startupLines);
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
    if (args.length > 0) {
      usage();
      process.exit(1);
    }
    await start();
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

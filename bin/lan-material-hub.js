#!/usr/bin/env node

const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const packageJson = require('../package.json');

const ROOT_DIR = path.resolve(__dirname, '..');
const SERVER_ENTRY = path.join(ROOT_DIR, 'server.js');
const HOME_DIR = path.resolve(process.env.LAN_MATERIAL_HUB_HOME || path.join(os.homedir(), '.lan-material-hub'));
const PID_FILE = path.resolve(process.env.LAN_MATERIAL_HUB_PID_FILE || path.join(HOME_DIR, 'lan-material-hub.pid'));
const LOG_FILE = path.resolve(process.env.LAN_MATERIAL_HUB_LOG_FILE || path.join(HOME_DIR, 'lan-material-hub.log'));
const UPDATE_CHECK_TIMEOUT = readPositiveInteger(process.env.LAN_MATERIAL_HUB_UPDATE_CHECK_TIMEOUT, 1500);
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

function readPositiveInteger(value, fallback) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) return fallback;
  return number;
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

function updateLabel() {
  return color('yellow', '[update]');
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

function emptyStartupSummary() {
  return startupSummary([]);
}

function startupSummaryFromPidInfo(info) {
  const summary = emptyStartupSummary();
  if (!info || typeof info !== 'object') return summary;

  summary.dataDir = typeof info.dataDir === 'string' ? info.dataDir : '';
  summary.nickname = typeof info.nickname === 'string' ? info.nickname : '';
  summary.portSwitch = typeof info.portSwitch === 'string' ? info.portSwitch : '';
  summary.urls = Array.isArray(info.urls)
    ? info.urls.filter((url) => typeof url === 'string' && url.trim())
    : [];

  return summary;
}

function mergeStartupSummaries(primary, fallback) {
  return {
    dataDir: primary.dataDir || fallback.dataDir,
    failed: primary.failed || fallback.failed,
    migrated: primary.migrated || fallback.migrated,
    nickname: primary.nickname || fallback.nickname,
    portSwitch: primary.portSwitch || fallback.portSwitch,
    urls: primary.urls.length > 0 ? primary.urls : fallback.urls,
    warnings: primary.warnings.length > 0 ? primary.warnings : fallback.warnings,
    other: primary.other.length > 0 ? primary.other : fallback.other,
  };
}

function latestStartupLines(lines) {
  let startIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].startsWith('LAN Material Hub is running:')) {
      startIndex = index;
      break;
    }
  }
  if (startIndex === -1) return [];

  const block = [];
  for (const line of lines.slice(startIndex)) {
    block.push(line);
    if (line.startsWith('Data directory:')) break;
  }
  return block;
}

function startupInfoFromSummary(summary) {
  return {
    dataDir: summary.dataDir,
    nickname: summary.nickname,
    portSwitch: summary.portSwitch,
    urls: summary.urls,
  };
}

function printVisitUrls(urls) {
  if (urls.length === 0) return;

  console.log(`${infoLabel()} Use your device to visit:`);
  for (const url of urls) {
    console.log(`    ${color(isLocalUrl(url) ? 'cyan' : 'green', url)}`);
  }
  console.log(`${warnLabel()} If mobile devices cannot open the network URL, check Wi-Fi and firewall settings.`);
}

function printStartupDetails(summary) {
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
  printVisitUrls(summary.urls);
  if (summary.dataDir) {
    console.log(`${infoLabel()} Data directory: ${summary.dataDir}`);
  }
  for (const line of summary.other) {
    console.log(`${infoLabel()} ${line}`);
  }
}

function printStartupOutput(pid, summary) {
  const version = packageJson.version ? `@${packageJson.version}` : '';

  console.log(`${color('gray', 'Log file:')} ${LOG_FILE}`);
  console.log(commandLabel());

  if (summary.failed) {
    console.log(`${errorLabel()} ${color('red', summary.failed)}`);
    return;
  }

  console.log(`${infoLabel()} ${color('green', `LAN Material Hub${version} started`)} ${color('gray', `(pid ${pid})`)}`);
  printStartupDetails(summary);
}

function printRunningOutput(pid, logFile, summary, message = 'LAN Material Hub is already running') {
  console.log(`${message}, pid ${pid}`);
  console.log(`Log file: ${logFile}`);
  printStartupDetails(summary);
}

function npmRegistryPackageUrl() {
  const registry = process.env.LAN_MATERIAL_HUB_NPM_REGISTRY
    || process.env.npm_config_registry
    || process.env.NPM_CONFIG_REGISTRY
    || 'https://registry.npmjs.org/';
  const baseUrl = registry.endsWith('/') ? registry : `${registry}/`;
  return new URL(`./${encodeURIComponent(packageJson.name)}`, baseUrl).toString();
}

function debugUpdateCheck(error) {
  if (process.env.LAN_MATERIAL_HUB_DEBUG_UPDATE_CHECK !== '1') return;
  console.warn(`更新检查已跳过：${error.message || error}`);
}

function requestJson(url, timeout = UPDATE_CHECK_TIMEOUT, redirects = 2) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const transport = parsedUrl.protocol === 'http:' ? http : https;
    const request = transport.get(parsedUrl, {
      headers: {
        Accept: 'application/vnd.npm.install-v1+json, application/json',
        'User-Agent': `${packageJson.name || 'lan-material-hub'}/${packageJson.version || '0.0.0'}`,
      },
      timeout,
    }, (response) => {
      const location = response.headers.location;
      if (
        location
        && response.statusCode >= 300
        && response.statusCode < 400
        && redirects > 0
      ) {
        response.resume();
        resolve(requestJson(new URL(location, parsedUrl).toString(), timeout, redirects - 1));
        return;
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`npm registry responded with ${response.statusCode}`));
        return;
      }

      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
        if (body.length > 256 * 1024) {
          request.destroy(new Error('npm registry response is too large'));
        }
      });
      response.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });

    request.on('timeout', () => {
      request.destroy(new Error('npm update check timed out'));
    });
    request.on('error', reject);
  });
}

function parseSemver(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    String(version || '').trim(),
  );
  if (!match) return null;

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function comparePrerelease(left, right) {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;

  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart == null) return -1;
    if (rightPart == null) return 1;
    if (leftPart === rightPart) continue;

    const leftIsNumeric = /^\d+$/.test(leftPart);
    const rightIsNumeric = /^\d+$/.test(rightPart);
    if (leftIsNumeric && rightIsNumeric) return Number(leftPart) > Number(rightPart) ? 1 : -1;
    if (leftIsNumeric) return -1;
    if (rightIsNumeric) return 1;
    return leftPart > rightPart ? 1 : -1;
  }

  return 0;
}

function compareSemver(leftVersion, rightVersion) {
  const left = parseSemver(leftVersion);
  const right = parseSemver(rightVersion);
  if (!left || !right) return 0;

  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
  }

  return comparePrerelease(left.prerelease, right.prerelease);
}

async function latestVersionUpdateNotice() {
  try {
    if (!packageJson.name || !packageJson.version) return '';

    const metadata = await requestJson(npmRegistryPackageUrl());
    const latestVersion = metadata?.['dist-tags']?.latest;
    if (!latestVersion || compareSemver(latestVersion, packageJson.version) <= 0) return '';

    return `${updateLabel()} 发现新版本：${packageJson.name}@${latestVersion}。执行 npm install -g ${packageJson.name}@latest 更新。`;
  } catch (error) {
    debugUpdateCheck(error);
    return '';
  }
}

async function printUpdateNotice(noticePromise) {
  const notice = await noticePromise;
  if (notice) console.log(notice);
}

function usage() {
  console.log(`LAN Material Hub

Usage:
  lan-material-hub start
  lan-material-hub stop
  lan-material-hub status
  lan-material-hub --version

Environment:
  PORT                  起始端口，默认 7788
  PORT_RETRY_LIMIT      端口被占用时向后重试次数，默认 20
  HOST                  监听地址，默认 0.0.0.0
  DATA_DIR              素材保存目录
  LAN_MATERIAL_HUB_NICKNAME 站点昵称
  LAN_MATERIAL_HUB_HOME PID、日志和默认素材目录`);
}

function printVersion() {
  console.log(packageJson.version || '0.0.0');
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

function writePidInfo(info) {
  fs.writeFileSync(PID_FILE, JSON.stringify(info, null, 2));
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

async function readRecentLogLines(logFile, maxBytes = 128 * 1024) {
  try {
    const handle = await fsp.open(logFile, 'r');
    try {
      const stat = await handle.stat();
      const length = Math.min(stat.size, maxBytes);
      if (length === 0) return [];

      const offset = stat.size - length;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, offset);

      let text = buffer.toString('utf8');
      if (offset > 0) {
        const firstLineBreak = text.indexOf('\n');
        text = firstLineBreak === -1 ? '' : text.slice(firstLineBreak + 1);
      }
      return text.split(/\r?\n/).filter(Boolean);
    } finally {
      await handle.close();
    }
  } catch (_error) {
    return [];
  }
}

async function readLatestStartupSummary(logFile) {
  const lines = await readRecentLogLines(logFile);
  return startupSummary(latestStartupLines(lines));
}

async function runningSummary(pidInfo) {
  const logFile = pidInfo.logFile || LOG_FILE;
  const pidSummary = startupSummaryFromPidInfo(pidInfo);
  const logSummary = await readLatestStartupSummary(logFile);
  return mergeStartupSummaries(pidSummary, logSummary);
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
  const updateNoticePromise = latestVersionUpdateNotice();

  const previous = readPidInfo();
  if (previous?.pid && isRunning(previous.pid)) {
    printRunningOutput(previous.pid, previous.logFile || LOG_FILE, await runningSummary(previous));
    await printUpdateNotice(updateNoticePromise);
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
  const pidInfo = {
    pid: child.pid,
    startedAt: new Date().toISOString(),
    cwd: ROOT_DIR,
    logFile: LOG_FILE,
  };
  writePidInfo(pidInfo);

  const startupLines = await waitForStartupLines(logOffset);
  const summary = startupSummary(startupLines);
  writePidInfo({
    ...pidInfo,
    ...startupInfoFromSummary(summary),
  });
  printStartupOutput(child.pid, summary);
  if (!summary.failed) await printUpdateNotice(updateNoticePromise);
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
    printRunningOutput(
      current.pid,
      current.logFile || LOG_FILE,
      await runningSummary(current),
      'LAN Material Hub is running',
    );
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
  } else if ((command === '--version' || command === '-v') && args.length === 0) {
    printVersion();
  } else {
    usage();
    process.exit(command ? 1 : 0);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

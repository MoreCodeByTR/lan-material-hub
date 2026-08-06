const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');

const express = require('express');
const mime = require('mime-types');
const multer = require('multer');
const QRCode = require('qrcode');
const { WebSocketServer } = require('ws');
const packageJson = require('./package.json');

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const LEGACY_DATA_DIR = path.join(ROOT_DIR, 'data');
const APP_HOME_DIR = path.resolve(
  process.env.LAN_MATERIAL_HUB_HOME || path.join(os.homedir(), '.lan-material-hub'),
);
const USE_MANAGED_HOME = process.env.LAN_MATERIAL_HUB_MANAGED === '1';
const DEFAULT_DATA_DIR = USE_MANAGED_HOME
  ? path.join(APP_HOME_DIR, 'data')
  : LEGACY_DATA_DIR;
const DATA_DIR = path.resolve(process.env.DATA_DIR || DEFAULT_DATA_DIR);
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const META_FILE = path.join(DATA_DIR, 'items.json');
const CATEGORY_FILE = path.join(DATA_DIR, 'categories.json');
const START_PORT = readPort(process.env.PORT, 7788);
const PORT_RETRY_LIMIT = readPositiveInteger(process.env.PORT_RETRY_LIMIT, 20);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE || 1024 * 1024 * 1024);
const SITE_NICKNAME = cleanText(
  process.env.LAN_MATERIAL_HUB_NICKNAME || process.env.SITE_NICKNAME,
  80,
) || '素材中转站';
const SERVER_STARTED_AT = nowIso();

let items = [];
let categories = [];
let saveQueue = Promise.resolve();
let saveCategoryQueue = Promise.resolve();
let currentPort = START_PORT;
const linkedDevices = new Map();

function readPort(value, fallback) {
  if (value == null || value === '') return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) return fallback;
  return port;
}

function readPositiveInteger(value, fallback) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) return fallback;
  return number;
}

function nowIso() {
  return new Date().toISOString();
}

function createId() {
  return crypto.randomUUID();
}

function cleanText(value, max = 4000) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

function cleanCategoryName(value) {
  return cleanText(value, 40).replace(/\s+/g, ' ');
}

function limitText(value, max = 4000) {
  if (typeof value !== 'string') return '';
  return value.slice(0, max);
}

function normalizeIds(value) {
  let list = [];

  if (Array.isArray(value)) {
    list = value;
  } else if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return [];

    try {
      const parsed = JSON.parse(text);
      list = Array.isArray(parsed) ? parsed : [parsed];
    } catch (_error) {
      list = text.split(',');
    }
  } else if (value != null) {
    list = [value];
  }

  return [...new Set(
    list
      .map((id) => cleanText(String(id), 100))
      .filter(Boolean),
  )];
}

function safeOriginalName(name) {
  const base = path.basename(name || 'file');
  return base.replace(/[\\/:*?"<>|]/g, '_').slice(0, 240) || 'file';
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || '';
}

function cleanIp(value) {
  return String(value || '').replace(/^::ffff:/, '') || '';
}

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

function getLocalUrl() {
  return `http://localhost:${currentPort}`;
}

function getUrls() {
  const lanUrls = getLanAddresses().map((address) => `http://${address}:${currentPort}`);
  return lanUrls.length > 0 ? lanUrls : [getLocalUrl()];
}

function primaryLanUrl() {
  return getUrls()[0] || getLocalUrl();
}

function getSiteInfo() {
  return {
    name: 'lan-material-hub',
    nickname: SITE_NICKNAME,
    version: packageJson.version || '',
  };
}

function getServerDeviceInfo() {
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    node: process.version,
    pid: process.pid,
    uptime: Math.round(process.uptime()),
    startedAt: SERVER_STARTED_AT,
    dataDir: DATA_DIR,
    host: HOST,
    port: currentPort,
  };
}

function cleanClientInfo(value) {
  const input = value && typeof value === 'object' ? value : {};
  return {
    deviceName: cleanText(input.deviceName, 80),
    browser: cleanText(input.browser, 80),
    os: cleanText(input.os, 80),
    userAgent: cleanText(input.userAgent, 300),
    language: cleanText(input.language, 40),
    screen: cleanText(input.screen, 40),
    timezone: cleanText(input.timezone, 80),
    pageUrl: cleanText(input.pageUrl, 300),
  };
}

function publicLinkedDevices() {
  return [...linkedDevices.values()]
    .sort((a, b) => new Date(a.connectedAt) - new Date(b.connectedAt))
    .map((device) => ({ ...device }));
}

function parseByteRange(rangeHeader, size) {
  if (!rangeHeader) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
  if (!match) return { invalid: true };

  const [, startText, endText] = match;
  if (!startText && !endText) return { invalid: true };

  let start;
  let end;

  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { invalid: true };
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = Number(startText);
    end = endText ? Number(endText) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return { invalid: true };
    if (start < 0 || end < 0 || start > end || start >= size) return { invalid: true };
    end = Math.min(end, size - 1);
  }

  return { start, end };
}

function pipeFile(filePath, res, options) {
  fs.createReadStream(filePath, options)
    .on('error', (error) => {
      if (res.headersSent) {
        res.destroy(error);
        return;
      }
      res.status(error.code === 'ENOENT' ? 404 : 500).json({
        error: error.code === 'ENOENT' ? '文件不存在' : error.message,
      });
    })
    .pipe(res);
}

async function ensureStorage() {
  await migrateLegacyManagedData();
  await fsp.mkdir(UPLOAD_DIR, { recursive: true });
  try {
    const content = await fsp.readFile(META_FILE, 'utf8');
    const parsed = JSON.parse(content);
    items = Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('Failed to read metadata, starting with an empty list:', error.message);
    }
    items = [];
    await saveItems();
  }

  await loadCategories();
}

async function migrateLegacyManagedData() {
  if (process.env.DATA_DIR || !USE_MANAGED_HOME || DATA_DIR === LEGACY_DATA_DIR) return;

  const [targetExists, legacyExists] = await Promise.all([
    fsp.access(DATA_DIR).then(() => true, () => false),
    fsp.access(LEGACY_DATA_DIR).then(() => true, () => false),
  ]);
  if (targetExists || !legacyExists) return;

  await fsp.mkdir(path.dirname(DATA_DIR), { recursive: true });
  await fsp.cp(LEGACY_DATA_DIR, DATA_DIR, { recursive: true });
  console.log(`Migrated data directory: ${LEGACY_DATA_DIR} -> ${DATA_DIR}`);
}

async function saveItems() {
  saveQueue = saveQueue.catch(() => undefined).then(async () => {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const tempFile = `${META_FILE}.${process.pid}.${createId()}.tmp`;
    await fsp.writeFile(tempFile, JSON.stringify(items, null, 2), 'utf8');
    await fsp.rename(tempFile, META_FILE);
  });
  return saveQueue;
}

async function loadCategories() {
  try {
    const content = await fsp.readFile(CATEGORY_FILE, 'utf8');
    const parsed = JSON.parse(content);
    categories = normalizeCategories(Array.isArray(parsed) ? parsed : []);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('Failed to read categories, starting with an empty list:', error.message);
    }
    categories = [];
    await saveCategories();
  }
}

async function saveCategories() {
  saveCategoryQueue = saveCategoryQueue.catch(() => undefined).then(async () => {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const tempFile = `${CATEGORY_FILE}.${process.pid}.${createId()}.tmp`;
    await fsp.writeFile(tempFile, JSON.stringify(categories, null, 2), 'utf8');
    await fsp.rename(tempFile, CATEGORY_FILE);
  });
  return saveCategoryQueue;
}

function normalizeCategories(list) {
  const seenIds = new Set();
  const seenNames = new Set();
  const normalized = [];

  for (const entry of list) {
    const input = entry && typeof entry === 'object' ? entry : {};
    const name = cleanCategoryName(input.name);
    if (!name) continue;

    const nameKey = name.toLowerCase();
    if (seenNames.has(nameKey)) continue;

    let id = cleanText(input.id, 100) || createId();
    if (seenIds.has(id)) id = createId();

    const createdAt = cleanText(input.createdAt, 40) || nowIso();
    seenIds.add(id);
    seenNames.add(nameKey);
    normalized.push({ id, name, createdAt });
  }

  return normalized;
}

function toPublicCategory(category) {
  return {
    id: category.id,
    name: category.name,
    createdAt: category.createdAt,
  };
}

function publicCategories() {
  return [...categories]
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    .map(toPublicCategory);
}

function cleanExistingCategoryIds(value) {
  const validIds = new Set(categories.map((category) => category.id));
  return normalizeIds(value).filter((id) => validIds.has(id));
}

function itemCategoryIds(item) {
  return cleanExistingCategoryIds(item.categoryIds);
}

function itemCategories(item) {
  const ids = new Set(itemCategoryIds(item));
  return categories
    .filter((category) => ids.has(category.id))
    .map(toPublicCategory);
}

function toPublicItem(item) {
  const categoryIds = itemCategoryIds(item);
  const base = {
    id: item.id,
    type: item.type,
    title: item.title,
    note: item.note || '',
    categoryIds,
    categories: itemCategories(item),
    createdAt: item.createdAt,
    source: item.source || '',
  };

  if (item.type === 'text') {
    return {
      ...base,
      text: item.text,
      size: Buffer.byteLength(item.text || '', 'utf8'),
      rawUrl: `/api/items/${item.id}/raw`,
      downloadUrl: `/api/items/${item.id}/download`,
    };
  }

  return {
    ...base,
    fileName: item.fileName,
    mime: item.mime || 'application/octet-stream',
    size: item.size || 0,
    rawUrl: `/api/items/${item.id}/raw`,
    downloadUrl: `/api/items/${item.id}/download`,
  };
}

function sortNewestFirst(list) {
  return [...list].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function findItem(id) {
  return items.find((item) => item.id === id);
}

async function removeItemsByIds(ids) {
  const targetIds = new Set(normalizeIds(ids));
  if (targetIds.size === 0) return [];

  const keep = [];
  const removed = [];

  for (const item of items) {
    if (targetIds.has(item.id)) removed.push(item);
    else keep.push(item);
  }

  if (removed.length === 0) return [];

  for (const item of removed) {
    if (item.type === 'file' && item.storedName) {
      await fsp.unlink(path.join(UPLOAD_DIR, item.storedName)).catch(() => undefined);
    }
  }

  items = keep;
  await saveItems();
  return removed;
}

function itemMatchesQuery(item, query) {
  if (!query) return true;
  const haystack = [
    item.title,
    item.note,
    item.text,
    item.fileName,
    item.mime,
    item.source,
    ...itemCategories(item).map((category) => category.name),
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();

  return haystack.includes(query);
}

function itemMatchesCategories(item, categoryIds) {
  if (categoryIds.length === 0) return true;
  const ids = new Set(itemCategoryIds(item));
  return categoryIds.some((id) => ids.has(id));
}

function fallbackItemTitle(item) {
  if (item.type === 'text') {
    return (item.text || '').trim().split('\n')[0].slice(0, 80) || '文本素材';
  }
  return item.fileName || '未命名素材';
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '');
      cb(null, `${Date.now()}-${createId()}${ext}`);
    },
  }),
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 50,
  },
});

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(DIST_DIR, { etag: true, maxAge: '1h' }));
app.use(express.static(PUBLIC_DIR, { etag: true, maxAge: '1h' }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('error', (error) => {
  if (error.code !== 'EADDRINUSE') {
    console.error('WebSocket server error:', error);
  }
});

function broadcast(message) {
  const payload = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) {
      client.send(payload);
    }
  }
}

wss.on('connection', (socket, req) => {
  const clientId = createId();
  const connectedAt = nowIso();
  linkedDevices.set(clientId, {
    id: clientId,
    ip: cleanIp(getClientIp(req)),
    connectedAt,
    lastSeenAt: connectedAt,
  });

  socket.send(JSON.stringify({
    type: 'hello',
    clientId,
    site: getSiteInfo(),
    urls: getUrls(),
    at: nowIso(),
  }));
  broadcast({ type: 'clients:updated', linkedDevices: publicLinkedDevices() });

  socket.on('message', (data) => {
    try {
      const message = JSON.parse(String(data));
      if (message.type !== 'client:hello') return;

      const current = linkedDevices.get(clientId);
      if (!current) return;
      linkedDevices.set(clientId, {
        ...current,
        ...cleanClientInfo(message.client),
        lastSeenAt: nowIso(),
      });
      broadcast({ type: 'clients:updated', linkedDevices: publicLinkedDevices() });
    } catch (_error) {
      // Ignore malformed websocket messages from clients.
    }
  });

  socket.on('close', () => {
    linkedDevices.delete(clientId);
    broadcast({ type: 'clients:updated', linkedDevices: publicLinkedDevices() });
  });
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, at: nowIso() });
});

app.get('/api/info', (_req, res) => {
  res.json({
    name: 'lan-material-hub',
    site: getSiteInfo(),
    port: currentPort,
    startPort: START_PORT,
    dataDir: DATA_DIR,
    maxFileSize: MAX_FILE_SIZE,
    urls: getUrls(),
    primaryUrl: primaryLanUrl(),
    serverDevice: getServerDeviceInfo(),
    linkedDevices: publicLinkedDevices(),
  });
});

app.get('/api/categories', (_req, res) => {
  res.json({ categories: publicCategories() });
});

app.post('/api/categories', async (req, res, next) => {
  try {
    const name = cleanCategoryName(req.body?.name);
    if (!name) {
      res.status(400).json({ error: '分类名称不能为空' });
      return;
    }

    const existing = categories.find((category) => category.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      res.json({ category: toPublicCategory(existing), categories: publicCategories() });
      return;
    }

    const category = {
      id: createId(),
      name,
      createdAt: nowIso(),
    };
    categories.push(category);
    await saveCategories();

    const publicList = publicCategories();
    broadcast({ type: 'categories:updated', categories: publicList });
    res.status(201).json({ category: toPublicCategory(category), categories: publicList });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/categories/:id', async (req, res, next) => {
  try {
    const category = categories.find((entry) => entry.id === req.params.id);
    if (!category) {
      res.status(404).json({ error: '分类不存在' });
      return;
    }

    const name = cleanCategoryName(req.body?.name);
    if (!name) {
      res.status(400).json({ error: '分类名称不能为空' });
      return;
    }

    const duplicated = categories.find(
      (entry) => entry.id !== category.id && entry.name.toLowerCase() === name.toLowerCase(),
    );
    if (duplicated) {
      res.status(409).json({ error: '分类已存在' });
      return;
    }

    category.name = name;
    await saveCategories();

    const publicList = publicCategories();
    broadcast({ type: 'categories:updated', categories: publicList });
    res.json({ category: toPublicCategory(category), categories: publicList });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/categories/:id', async (req, res, next) => {
  try {
    const index = categories.findIndex((entry) => entry.id === req.params.id);
    if (index === -1) {
      res.status(404).json({ error: '分类不存在' });
      return;
    }

    const [removed] = categories.splice(index, 1);
    const affectedItems = [];
    for (const item of items) {
      const nextCategoryIds = normalizeIds(item.categoryIds).filter((id) => id !== removed.id);
      if (nextCategoryIds.length === normalizeIds(item.categoryIds).length) continue;
      item.categoryIds = nextCategoryIds;
      affectedItems.push(item);
    }

    await saveCategories();
    if (affectedItems.length > 0) await saveItems();

    const publicList = publicCategories();
    const publicItems = affectedItems.map(toPublicItem);
    broadcast({ type: 'categories:updated', categories: publicList });
    if (publicItems.length > 0) broadcast({ type: 'items:updated', items: publicItems });
    res.json({
      ok: true,
      category: toPublicCategory(removed),
      categories: publicList,
      items: publicItems,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/qr.svg', async (req, res, next) => {
  try {
    const url = cleanText(req.query.url, 500) || primaryLanUrl();
    const svg = await QRCode.toString(url, {
      type: 'svg',
      margin: 1,
      width: 220,
      color: {
        dark: '#17201e',
        light: '#ffffff',
      },
    });
    res.type('image/svg+xml').send(svg);
  } catch (error) {
    next(error);
  }
});

app.get('/api/items', (req, res) => {
  const query = cleanText(req.query.q, 200).toLowerCase();
  const type = cleanText(req.query.type, 20);
  const categoryIds = cleanExistingCategoryIds(req.query.categoryIds || req.query.categoryId);
  const limit = Math.min(Number(req.query.limit || 200), 500);

  const filtered = sortNewestFirst(items)
    .filter((item) => (type && type !== 'all' ? item.type === type : true))
    .filter((item) => itemMatchesCategories(item, categoryIds))
    .filter((item) => itemMatchesQuery(item, query));

  res.json({
    count: filtered.length,
    items: filtered.slice(0, limit).map(toPublicItem),
  });
});

app.post('/api/items', upload.array('files', 50), async (req, res, next) => {
  try {
    const title = cleanText(req.body.title, 200);
    const note = cleanText(req.body.note, 2000);
    const text = limitText(req.body.text, 200000);
    const categoryIds = cleanExistingCategoryIds(req.body.categoryIds);
    const source = getClientIp(req);
    const created = [];

    if (text.trim()) {
      const textItem = {
        id: createId(),
        type: 'text',
        title: title || text.trim().split('\n')[0].slice(0, 80) || '文本素材',
        text,
        note,
        categoryIds,
        source,
        createdAt: nowIso(),
      };
      items.push(textItem);
      created.push(textItem);
    }

    for (const file of req.files || []) {
      const fileName = safeOriginalName(file.originalname);
      const guessedMime = mime.lookup(fileName);
      const detectedMime = file.mimetype && file.mimetype !== 'application/octet-stream'
        ? file.mimetype
        : guessedMime || file.mimetype || 'application/octet-stream';
      const fileItem = {
        id: createId(),
        type: 'file',
        title: title || fileName,
        note,
        fileName,
        storedName: file.filename,
        mime: detectedMime,
        size: file.size,
        categoryIds,
        source,
        createdAt: nowIso(),
      };
      items.push(fileItem);
      created.push(fileItem);
    }

    if (created.length === 0) {
      res.status(400).json({ error: '没有收到文件或文本' });
      return;
    }

    await saveItems();
    const publicItems = created.map(toPublicItem);
    broadcast({ type: 'items:created', items: publicItems });
    res.status(201).json({ items: publicItems });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/items/:id', async (req, res, next) => {
  try {
    const item = findItem(req.params.id);
    if (!item) {
      res.status(404).json({ error: '素材不存在' });
      return;
    }

    const body = req.body || {};
    const canUpdate = ['title', 'note', 'categoryIds'].some((field) => (
      Object.prototype.hasOwnProperty.call(body, field)
    ));

    if (!canUpdate) {
      res.status(400).json({ error: '没有可更新的字段' });
      return;
    }

    if (Object.prototype.hasOwnProperty.call(body, 'title')) {
      item.title = cleanText(body.title, 200) || fallbackItemTitle(item);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'note')) {
      item.note = cleanText(body.note, 2000);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'categoryIds')) {
      item.categoryIds = cleanExistingCategoryIds(body.categoryIds);
    }
    await saveItems();

    const publicItem = toPublicItem(item);
    broadcast({ type: 'items:updated', item: publicItem });
    res.json({ item: publicItem });
  } catch (error) {
    next(error);
  }
});

app.post('/api/items/delete', async (req, res, next) => {
  try {
    const body = req.body || {};
    const targetIds = body.all ? items.map((item) => item.id) : normalizeIds(body.ids);
    if (!body.all && targetIds.length === 0) {
      res.status(400).json({ error: '请选择要删除的素材' });
      return;
    }

    const removed = await removeItemsByIds(targetIds);
    const ids = removed.map((item) => item.id);
    broadcast({ type: 'items:cleared', ids });
    res.json({ ok: true, removed: removed.length, ids });
  } catch (error) {
    next(error);
  }
});

app.get('/api/items/:id/raw', async (req, res, next) => {
  const item = findItem(req.params.id);
  if (!item) {
    res.status(404).json({ error: '素材不存在' });
    return;
  }

  if (item.type === 'text') {
    res.type('text/plain; charset=utf-8').send(item.text || '');
    return;
  }

  const filePath = path.join(UPLOAD_DIR, item.storedName);
  try {
    const stat = await fsp.stat(filePath);
    const contentType = item.mime || mime.lookup(item.fileName) || 'application/octet-stream';
    const disposition = `inline; filename*=UTF-8''${encodeURIComponent(item.fileName)}`;
    const range = parseByteRange(req.headers.range, stat.size);

    res.type(contentType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Disposition', disposition);

    if (range?.invalid) {
      res.setHeader('Content-Range', `bytes */${stat.size}`);
      res.status(416).end();
      return;
    }

    if (range) {
      const chunkSize = range.end - range.start + 1;
      res.status(206);
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`);
      res.setHeader('Content-Length', chunkSize);
      pipeFile(filePath, res, { start: range.start, end: range.end });
      return;
    }

    res.setHeader('Content-Length', stat.size);
    pipeFile(filePath, res);
  } catch (error) {
    if (error.code === 'ENOENT') {
      res.status(404).json({ error: '文件不存在' });
      return;
    }
    next(error);
  }
});

app.get('/api/items/:id/download', (req, res) => {
  const item = findItem(req.params.id);
  if (!item) {
    res.status(404).json({ error: '素材不存在' });
    return;
  }

  if (item.type === 'text') {
    const fileName = `${safeOriginalName(item.title || '文本素材')}.txt`;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    res.send(item.text || '');
    return;
  }

  const filePath = path.join(UPLOAD_DIR, item.storedName);
  res.download(filePath, item.fileName);
});

app.delete('/api/items/:id', async (req, res, next) => {
  try {
    const removed = await removeItemsByIds([req.params.id]);
    if (removed.length === 0) {
      res.status(404).json({ error: '素材不存在' });
      return;
    }

    broadcast({ type: 'items:deleted', id: removed[0].id });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/clear', async (req, res, next) => {
  try {
    const body = req.body || {};
    const days = Number(body.days || req.query.days || 0);
    if (!Number.isFinite(days) || days <= 0) {
      res.status(400).json({ error: 'days 必须大于 0' });
      return;
    }

    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const keep = [];
    const removed = [];

    for (const item of items) {
      if (new Date(item.createdAt).getTime() < cutoff) removed.push(item);
      else keep.push(item);
    }

    for (const item of removed) {
      if (item.type === 'file' && item.storedName) {
        await fsp.unlink(path.join(UPLOAD_DIR, item.storedName)).catch(() => undefined);
      }
    }

    items = keep;
    await saveItems();
    broadcast({ type: 'items:cleared', ids: removed.map((item) => item.id) });
    res.json({ ok: true, removed: removed.length });
  } catch (error) {
    next(error);
  }
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) {
    next();
    return;
  }

  const indexFile = path.join(DIST_DIR, 'index.html');
  res.sendFile(indexFile, (error) => {
    if (!error) return;
    res.status(404).send('Frontend is not built. Run npm run build first.');
  });
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    const message = error.code === 'LIMIT_FILE_SIZE'
      ? `文件超过限制，当前上限 ${Math.round(MAX_FILE_SIZE / 1024 / 1024)} MB`
      : error.message;
    res.status(400).json({ error: message });
    return;
  }

  console.error(error);
  res.status(500).json({ error: error.message || '服务异常' });
});

function listenOnPort(port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      currentPort = typeof address === 'object' && address ? address.port : port;
      resolve();
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, HOST);
  });
}

function logServerStarted() {
  const urls = [getLocalUrl(), ...getUrls().filter((url) => url !== getLocalUrl())];
  console.log(`LAN Material Hub is running: ${SITE_NICKNAME}`);
  if (currentPort !== START_PORT) {
    console.log(`Requested port ${START_PORT} was unavailable, switched to ${currentPort}`);
  }
  for (const url of urls) console.log(`- ${url}`);
  console.log(`Data directory: ${DATA_DIR}`);
}

async function startServer() {
  await ensureStorage();

  let port = START_PORT;
  const maxAttempts = START_PORT === 0 ? 1 : PORT_RETRY_LIMIT + 1;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      await listenOnPort(port);
      logServerStarted();
      return;
    } catch (error) {
      const nextPort = port + 1;
      const canRetry = error.code === 'EADDRINUSE'
        && START_PORT !== 0
        && attempt < maxAttempts - 1
        && nextPort <= 65535;

      if (!canRetry) throw error;

      console.warn(`Port ${port} is in use, trying ${nextPort}...`);
      port = nextPort;
    }
  }
}

startServer().catch((error) => {
  console.error('Failed to start:', error);
  process.exit(1);
});

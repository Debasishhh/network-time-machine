// Network Time Machine — background service worker
//
// Always listens to chrome.webRequest (independent of DevTools being open),
// keeps a rolling in-memory + chrome.storage.session buffer of requests,
// and prunes anything older than the configured retention window.

const DEFAULT_SETTINGS = { retentionMinutes: 5, paused: false };
const MAX_ENTRIES = 4000;
const MAX_HEADER_VALUE_LEN = 2000;
const SAVE_DEBOUNCE_MS = 800;

let log = [];          // array of records, ordered oldest -> newest
let index = new Map(); // requestId -> record (same object references as in `log`)
let settings = { ...DEFAULT_SETTINGS };
let saveTimer = null;
let loaded = false;

// ---------- persistence ----------

async function loadState() {
  const [s, l] = await Promise.all([
    chrome.storage.local.get({ settings: DEFAULT_SETTINGS }),
    chrome.storage.session.get({ nlog: [] })
  ]);
  settings = { ...DEFAULT_SETTINGS, ...s.settings };
  log = Array.isArray(l.nlog) ? l.nlog : [];
  index = new Map(log.map(r => [r.id, r]));
  loaded = true;
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.session.set({ nlog: log }).catch(() => {});
  }, SAVE_DEBOUNCE_MS);
}

async function ensureLoaded() {
  if (!loaded) await loadState();
}

// ---------- pruning ----------

function prune() {
  const cutoff = Date.now() - settings.retentionMinutes * 60 * 1000;
  if (log.length && log[0].startTime >= cutoff && log.length <= MAX_ENTRIES) return;
  log = log.filter(r => r.startTime >= cutoff);
  if (log.length > MAX_ENTRIES) log = log.slice(log.length - MAX_ENTRIES);
  index = new Map(log.map(r => [r.id, r]));
}

chrome.alarms.create('nlog-prune', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'nlog-prune') return;
  await ensureLoaded();
  prune();
  scheduleSave();
});

// ---------- helpers ----------

function truncateHeaders(headers) {
  if (!headers) return null;
  return headers.map(h => ({
    name: h.name,
    value: h.value !== undefined
      ? (h.value.length > MAX_HEADER_VALUE_LEN ? h.value.slice(0, MAX_HEADER_VALUE_LEN) + '…' : h.value)
      : (h.binaryValue ? '[binary]' : '')
  }));
}

function findRecord(requestId) {
  return index.get(requestId) || null;
}

// ---------- webRequest listeners ----------

chrome.webRequest.onBeforeRequest.addListener(
  async (details) => {
    await ensureLoaded();
    if (settings.paused) return;
    const rec = {
      id: details.requestId,
      url: details.url,
      method: details.method,
      type: details.type,
      tabId: details.tabId,
      initiator: details.initiator || '',
      startTime: details.timeStamp,
      endTime: null,
      duration: null,
      status: null,
      statusLine: null,
      fromCache: false,
      error: null,
      reqHeaders: null,
      resHeaders: null
    };
    log.push(rec);
    index.set(rec.id, rec);
    if (log.length > MAX_ENTRIES) prune();
    scheduleSave();
  },
  { urls: ['<all_urls>'] }
);

chrome.webRequest.onBeforeSendHeaders.addListener(
  async (details) => {
    await ensureLoaded();
    const rec = findRecord(details.requestId);
    if (rec) {
      rec.reqHeaders = truncateHeaders(details.requestHeaders);
      scheduleSave();
    }
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders']
);

chrome.webRequest.onHeadersReceived.addListener(
  async (details) => {
    await ensureLoaded();
    const rec = findRecord(details.requestId);
    if (rec) {
      rec.status = details.statusCode;
      rec.statusLine = details.statusLine;
      rec.resHeaders = truncateHeaders(details.responseHeaders);
      scheduleSave();
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

chrome.webRequest.onCompleted.addListener(
  async (details) => {
    await ensureLoaded();
    const rec = findRecord(details.requestId);
    if (rec) {
      rec.status = details.statusCode;
      rec.statusLine = details.statusLine;
      rec.fromCache = !!details.fromCache;
      rec.endTime = details.timeStamp;
      rec.duration = Math.max(0, Math.round(details.timeStamp - rec.startTime));
      scheduleSave();
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

chrome.webRequest.onErrorOccurred.addListener(
  async (details) => {
    await ensureLoaded();
    const rec = findRecord(details.requestId);
    if (rec) {
      rec.error = details.error;
      rec.endTime = details.timeStamp;
      rec.duration = Math.max(0, Math.round(details.timeStamp - rec.startTime));
      scheduleSave();
    }
  },
  { urls: ['<all_urls>'] }
);

// ---------- messaging with popup ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    await ensureLoaded();
    switch (msg?.type) {
      case 'getLog': {
        prune();
        sendResponse({ log, settings });
        break;
      }
      case 'clearLog': {
        log = [];
        index.clear();
        await chrome.storage.session.set({ nlog: [] });
        sendResponse({ ok: true });
        break;
      }
      case 'setSettings': {
        settings = { ...settings, ...msg.settings };
        await chrome.storage.local.set({ settings });
        prune();
        scheduleSave();
        sendResponse({ ok: true, settings });
        break;
      }
      default:
        sendResponse({ error: 'unknown message' });
    }
  })();
  return true; // async response
});

// initial load on service worker startup
loadState();

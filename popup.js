let state = { log: [], settings: { retentionMinutes: 5, paused: false } };
let currentTabId = null;
let refreshTimer = null;
let errorsOnly = false;

const $ = (sel) => document.querySelector(sel);

async function getCurrentTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ? tab.id : null;
}

function sendMessage(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

async function refresh() {
  const res = await sendMessage({ type: 'getLog' });
  if (res) state = res;
  render();
}

function domainOf(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

function pathOf(url) {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch { return url; }
}

function methodClass(method) {
  const m = (method || '').toUpperCase();
  return ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(m) ? `method-${m}` : 'method-OTHER';
}

function isError(rec) {
  return !!rec.error || (rec.status != null && rec.status >= 400);
}

function statusInfo(rec) {
  if (rec.error) return { cls: 'status-error', label: 'ERR' };
  if (rec.status == null) return { cls: 'status-pending', label: '…' };
  const s = rec.status;
  if (s >= 200 && s < 300) return { cls: 'status-2xx', label: String(s) };
  if (s >= 300 && s < 400) return { cls: 'status-3xx', label: String(s) };
  if (s >= 400 && s < 500) return { cls: 'status-4xx', label: String(s) };
  return { cls: 'status-5xx', label: String(s) };
}

function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

function getFilters() {
  return {
    search: $('#search').value.trim().toLowerCase(),
    tabScope: $('#tabFilter').value,
    type: $('#typeFilter').value,
    rangeSec: parseInt($('#rangeFilter').value, 10)
  };
}

function filteredLog() {
  const f = getFilters();
  const cutoff = Date.now() - f.rangeSec * 1000;
  return state.log
    .filter(r => r.startTime >= cutoff)
    .filter(r => f.tabScope === 'all' || r.tabId === currentTabId)
    .filter(r => f.type === 'all' || r.type === f.type)
    .filter(r => !errorsOnly || isError(r))
    .filter(r => {
      if (!f.search) return true;
      const hay = `${r.url} ${r.method} ${r.status || ''}`.toLowerCase();
      return hay.includes(f.search);
    })
    .sort((a, b) => b.startTime - a.startTime);
}

function render() {
  const pulse = $('#statusDot');
  pulse.classList.toggle('paused', !!state.settings.paused);
  $('#pauseBtn').textContent = state.settings.paused ? '▶' : '⏸';
  $('#pauseBtn').title = state.settings.paused ? 'Resume capture' : 'Pause capture';
  $('#retentionInput').value = state.settings.retentionMinutes;

  $('#errorsOnlyBtn').classList.toggle('active', errorsOnly);

  // Error badge reflects errors within the current time range, regardless of other filters
  const f = getFilters();
  const cutoff = Date.now() - f.rangeSec * 1000;
  const errorCount = state.log.filter(r => r.startTime >= cutoff && isError(r)).length;
  const badge = $('#errorBadge');
  if (errorCount > 0) {
    badge.textContent = errorCount > 99 ? '99+' : String(errorCount);
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }

  const rows = filteredLog();
  const rowErrorCount = rows.filter(isError).length;
  $('#summary').innerHTML = `${rows.length} request${rows.length === 1 ? '' : 's'} shown` +
    (rowErrorCount > 0 ? ` · <span class="err-count">${rowErrorCount} failed</span>` : '');

  const list = $('#list');
  list.innerHTML = '';

  if (rows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = state.log.length === 0
      ? 'No requests captured yet. Browse a page and they\'ll show up here automatically.'
      : (errorsOnly ? 'No failed requests in this window. Good sign.' : 'No requests match the current filters.');
    list.appendChild(empty);
    return;
  }

  for (const rec of rows) {
    const row = document.createElement('div');
    const err = isError(rec);
    row.className = 'row' + (err ? ' row-error' : '');

    const badgeEl = document.createElement('span');
    badgeEl.className = `badge ${methodClass(rec.method)}`;
    badgeEl.textContent = rec.method;

    const st = statusInfo(rec);
    const status = document.createElement('span');
    status.className = `status ${st.cls}`;
    status.textContent = st.label;

    const urlWrap = document.createElement('span');
    urlWrap.className = 'row-url';
    urlWrap.innerHTML = `<span class="row-domain">${domainOf(rec.url)}</span>${pathOf(rec.url)}`;

    const meta = document.createElement('span');
    meta.className = 'row-meta';
    const dur = rec.duration != null ? `${rec.duration}ms` : '';
    meta.textContent = `${timeAgo(rec.startTime)}${dur ? ' · ' + dur : ''}`;

    if (err) {
      const errIcon = document.createElement('span');
      errIcon.className = 'err-icon';
      errIcon.textContent = '⚠';
      row.append(errIcon);
    }

    row.append(badgeEl, status, urlWrap, meta);
    row.addEventListener('click', () => showDetail(rec));
    list.appendChild(row);
  }
}

function headerRows(headers) {
  if (!headers || headers.length === 0) return '<div class="kv"><div class="key">(none)</div><div class="val"></div></div>';
  return `<div class="kv">${headers.map(h =>
    `<div class="key">${escapeHtml(h.name)}</div><div class="val">${escapeHtml(h.value)}</div>`
  ).join('')}</div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function showDetail(rec) {
  $('#detailTitle').textContent = `${rec.method} ${rec.url}`;
  const err = isError(rec);
  const body = $('#detailBody');
  body.innerHTML = `
    <h4>Overview</h4>
    <div class="kv">
      <div class="key">Status</div><div class="val ${err ? 'err-val' : ''}">${rec.error ? 'Error: ' + escapeHtml(rec.error) : (rec.status ?? 'pending')} ${rec.statusLine ? escapeHtml(rec.statusLine) : ''}</div>
      <div class="key">Type</div><div class="val">${escapeHtml(rec.type)}</div>
      <div class="key">Started</div><div class="val">${new Date(rec.startTime).toLocaleTimeString()}</div>
      <div class="key">Duration</div><div class="val">${rec.duration != null ? rec.duration + ' ms' : '—'}</div>
      <div class="key">From cache</div><div class="val">${rec.fromCache ? 'yes' : 'no'}</div>
      <div class="key">Initiator</div><div class="val">${escapeHtml(rec.initiator || '—')}</div>
    </div>
    <h4>Request headers</h4>
    ${headerRows(rec.reqHeaders)}
    <h4>Response headers</h4>
    ${headerRows(rec.resHeaders)}
  `;
  $('#detail').classList.remove('hidden');
}

function hideDetail() {
  $('#detail').classList.add('hidden');
}

async function init() {
  currentTabId = await getCurrentTabId();
  await refresh();

  $('#search').addEventListener('input', render);
  $('#tabFilter').addEventListener('change', render);
  $('#typeFilter').addEventListener('change', render);
  $('#rangeFilter').addEventListener('change', render);
  $('#closeDetail').addEventListener('click', hideDetail);

  $('#errorsOnlyBtn').addEventListener('click', () => {
    errorsOnly = !errorsOnly;
    render();
  });

  $('#pauseBtn').addEventListener('click', async () => {
    const res = await sendMessage({ type: 'setSettings', settings: { paused: !state.settings.paused } });
    if (res?.settings) state.settings = res.settings;
    render();
  });

  $('#clearBtn').addEventListener('click', async () => {
    await sendMessage({ type: 'clearLog' });
    await refresh();
  });

  $('#retentionInput').addEventListener('change', async (e) => {
    let val = parseInt(e.target.value, 10);
    if (isNaN(val) || val < 1) val = 1;
    if (val > 120) val = 120;
    e.target.value = val;
    const res = await sendMessage({ type: 'setSettings', settings: { retentionMinutes: val } });
    if (res?.settings) state.settings = res.settings;
    await refresh();
  });

  refreshTimer = setInterval(refresh, 2000);
}

document.addEventListener('DOMContentLoaded', init);
window.addEventListener('unload', () => refreshTimer && clearInterval(refreshTimer));

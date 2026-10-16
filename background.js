// Service worker: fetches stylesheets the page may not read through the CSSOM
// (cross-origin without CORS), and handles the keyboard shortcut.

const MAX_IMPORT_DEPTH = 3;

async function fetchCss(url, depth = 0) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  let text = await res.text();

  // make url(...) absolute so the text can be re-parsed in the page's context
  text = text.replace(/url\(\s*(['"]?)(?!data:|#|about:)([^'")]+?)\1\s*\)/gi, (m, q, u) => {
    try {
      return 'url("' + new URL(u.trim(), url).href + '")';
    } catch (e) {
      return m;
    }
  });

  if (depth < MAX_IMPORT_DEPTH && /@import/i.test(text)) {
    const re = /@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1\s*\)?[^;]*;/gi;
    const parts = [];
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      parts.push(text.slice(last, m.index));
      try {
        parts.push(await fetchCss(new URL(m[2], url).href, depth + 1));
      } catch (e) {}
      last = m.index + m[0].length;
    }
    parts.push(text.slice(last));
    text = parts.join('\n');
  }
  return text;
}

importScripts('content/pixels.js');

const imageCache = new Map();

// true when the image is dark ink on transparency (logo/icon that vanishes on dark pages)
async function analyzeImage(url) {
  if (imageCache.has(url)) return imageCache.get(url);
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const type = res.headers.get('content-type') || '';
  let inv;
  if (/svg/i.test(type) || /\.svg(\?|#|$)/i.test(url)) {
    inv = globalThis.__UD.analyzeSvg(await res.text());
  } else {
    const bmp = await createImageBitmap(await res.blob());
    const canvas = new OffscreenCanvas(48, 48);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, 48, 48);
    inv = globalThis.__UD.analyzePixels(ctx.getImageData(0, 0, 48, 48).data);
    bmp.close();
  }
  if (imageCache.size > 500) imageCache.clear();
  imageCache.set(url, inv);
  return inv;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'check-update') {
    checkUpdate().then(sendResponse);
    return true;
  }
  if (!msg || typeof msg.url !== 'string') return;
  if (msg.type === 'css') {
    fetchCss(msg.url).then(
      (text) => sendResponse({ ok: true, text }),
      () => sendResponse({ ok: false })
    );
    return true;
  }
  if (msg.type === 'img') {
    analyzeImage(msg.url).then(
      (inv) => sendResponse({ ok: true, inv }),
      () => sendResponse({ ok: false })
    );
    return true;
  }
});

// ---- update check (GitHub releases) -----------------------------------------

const REPO = 'ignatovmax1/universal-dark';
const ALARM = 'check-update';

const parseVer = (v) => String(v).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
function isNewer(a, b) {
  const x = parseVer(a);
  const y = parseVer(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

async function checkUpdate() {
  const { ghToken = '' } = await chrome.storage.local.get('ghToken');
  const headers = { Accept: 'application/vnd.github+json' };
  if (ghToken) headers.Authorization = 'Bearer ' + ghToken;
  let update = null;
  let error = '';
  try {
    const res = await fetch('https://api.github.com/repos/' + REPO + '/releases/latest', { headers, cache: 'no-store' });
    if (res.status === 404) error = ghToken ? 'Релизов пока нет' : 'Репозиторий приватный: добавьте токен GitHub в настройках';
    else if (!res.ok) error = 'GitHub ответил ' + res.status;
    else {
      const rel = await res.json();
      const current = chrome.runtime.getManifest().version;
      if (isNewer(rel.tag_name, current)) {
        update = { version: String(rel.tag_name).replace(/^v/i, ''), url: rel.html_url, notes: (rel.body || '').slice(0, 500) };
      }
    }
  } catch (e) {
    error = 'Нет связи с GitHub';
  }
  await chrome.storage.local.set({ update, updateError: error, updateChecked: Date.now() });
  return { update, error };
}

function ensureAlarm() {
  chrome.alarms.get(ALARM, (a) => {
    if (!a) chrome.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: 12 * 60 });
  });
}
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) checkUpdate();
});

// ---- badge --------------------------------------------------------------------

async function updateBadge() {
  const { enabled = true, update = null } = await chrome.storage.local.get(['enabled', 'update']);
  const text = !enabled ? 'OFF' : update ? 'NEW' : '';
  await chrome.action.setBadgeBackgroundColor({ color: !enabled ? '#555555' : '#0f7b0f' });
  await chrome.action.setBadgeText({ text });
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle') return;
  const { enabled = true } = await chrome.storage.local.get('enabled');
  await chrome.storage.local.set({ enabled: !enabled });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.enabled || changes.update) updateBadge();
  if (changes.ghToken) checkUpdate();
});
chrome.runtime.onStartup.addListener(() => {
  updateBadge();
  ensureAlarm();
});
chrome.runtime.onInstalled.addListener(() => {
  updateBadge();
  ensureAlarm();
  checkUpdate();
});

const DEFAULTS = { enabled: true, followSystem: true, disabledHosts: [], update: null, updateError: '', updateChecked: 0, ghToken: '' };
const $ = (id) => document.getElementById(id);

async function currentHost() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const url = new URL(tab.url);
    return /^https?:$|^file:$/.test(url.protocol) ? url.hostname : '';
  } catch (e) {
    return '';
  }
}

(async () => {
  const s = await chrome.storage.local.get(DEFAULTS);
  const host = await currentHost();

  $('ver').textContent = 'v' + chrome.runtime.getManifest().version;
  $('token').value = s.ghToken;
  const showUpdate = (st) => {
    const a = $('update');
    if (st.update) {
      a.hidden = false;
      a.href = st.update.url;
      a.textContent = 'Доступна версия ' + st.update.version + ': скачать';
    } else a.hidden = true;
    const t = st.updateChecked ? new Date(st.updateChecked).toLocaleString('ru-RU') : '';
    $('status').textContent = st.updateError || (st.update ? '' : t ? 'Установлена последняя версия (проверено ' + t + ')' : '');
  };
  showUpdate(s);

  $('check').addEventListener('click', async () => {
    $('status').textContent = 'Проверяю…';
    await chrome.runtime.sendMessage({ type: 'check-update' });
    showUpdate(await chrome.storage.local.get(DEFAULTS));
  });
  let tokenTimer = 0;
  $('token').addEventListener('input', (e) => {
    clearTimeout(tokenTimer);
    tokenTimer = setTimeout(() => chrome.storage.local.set({ ghToken: e.target.value.trim() }), 500);
  });

  $('enabled').checked = s.enabled;
  $('followSystem').checked = s.followSystem;
  if (host) {
    $('host').textContent = host;
    $('siteOff').checked = s.disabledHosts.includes(host);
  } else {
    $('siteOff').disabled = true;
  }

  $('enabled').addEventListener('change', (e) => chrome.storage.local.set({ enabled: e.target.checked }));
  $('followSystem').addEventListener('change', (e) => chrome.storage.local.set({ followSystem: e.target.checked }));
  $('siteOff').addEventListener('change', async (e) => {
    const { disabledHosts } = await chrome.storage.local.get(DEFAULTS);
    const set = new Set(disabledHosts);
    if (e.target.checked) set.add(host);
    else set.delete(host);
    chrome.storage.local.set({ disabledHosts: [...set] });
  });
})();

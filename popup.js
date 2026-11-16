const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const NATIVE_HOST = 'com.x.follower.tracker';

let changesCache = { new: [], lost: [] };
let currentActive = null;
let accountsList = [];
let nativeReady = null; // null=未確認, true/false

function showStatus(msg, isError = false) {
  const el = $('#status');
  el.textContent = msg;
  el.style.color = isError ? '#f4212e' : '#71767b';
}

function formatDate(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  const diff = (Date.now() - d) / 1000;
  if (diff < 60) return 'たった今';
  if (diff < 3600) return Math.floor(diff / 60) + '分前';
  if (diff < 86400) return Math.floor(diff / 3600) + '時間前';
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function timestampForFilename(d = new Date()) {
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    '_' +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

/** JSONファイル名用（日本語可・禁止文字のみ除去） */
function fileSafeLabel(name) {
  let s = String(name || '').trim();
  s = s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  s = s.replace(/\s+/g, ' ').trim();
  return s || 'account';
}

async function getAccountLabel(key) {
  const data = await chrome.storage.local.get(['accounts']);
  const acc = data.accounts?.[key];
  return acc?.label || acc?.current?.label || key;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ----- Native Messaging -----
function nativeSend(msg) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST, msg, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response) {
          reject(new Error('native host から応答がありません'));
          return;
        }
        resolve(response);
      });
    } catch (e) {
      reject(e);
    }
  });
}

async function checkNative() {
  try {
    const res = await nativeSend({ action: 'ping' });
    nativeReady = !!(res && res.ok);
    updateFolderLabel(res);
    return nativeReady;
  } catch (e) {
    nativeReady = false;
    updateFolderLabel(null, e.message);
    return false;
  }
}

function updateFolderLabel(pingRes, errMsg) {
  const el = $('#folderLabel');
  if (!el) return;
  if (pingRes && pingRes.ok) {
    el.textContent = `JSONフォルダ: ${pingRes.jsonDir || 'json/'}`;
    el.classList.add('set');
  } else {
    el.textContent = errMsg
      ? `Native Host未接続: ${errMsg}`
      : 'Native Host未接続（セットアップ.bat を実行し、IDを登録してください）';
    el.classList.remove('set');
  }
}

// ----- アカウントUI -----
async function loadAccounts() {
  const data = await chrome.storage.local.get(['accounts', 'activeAccount']);
  const accounts = data.accounts || {};
  accountsList = Object.keys(accounts).sort();
  currentActive = data.activeAccount || accountsList[0] || null;

  const select = $('#accountSelect');
  select.innerHTML = '';

  if (accountsList.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '（アカウントなし）';
    select.appendChild(opt);
  } else {
    accountsList.forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      const acc = accounts[name];
      const count = acc?.current?.count ?? 0;
      const label = acc?.label || acc?.current?.label || name;
      opt.textContent = `${label} (${count.toLocaleString()}人)`;
      if (name === currentActive) opt.selected = true;
      select.appendChild(opt);
    });
  }
  return { accounts, active: currentActive };
}

async function loadDashboard() {
  const { accounts, active } = await loadAccounts();
  currentActive = active;

  if (!active || !accounts[active]) {
    $('#savedCount').textContent = '0';
    $('#newCount').textContent = '0';
    $('#lostCount').textContent = '0';
    $('#lastUpdate').textContent = '-';
    changesCache = { new: [], lost: [] };
    showStatus('まだデータがありません。Xにログインして「フルスキャン開始」を押してください');
    renderList('new');
    return;
  }

  const acc = accounts[active];
  const current = acc.current;
  const changes = acc.changes || { new: [], lost: [] };
  changesCache = changes;

  $('#savedCount').textContent = current?.count?.toLocaleString() || '0';
  $('#newCount').textContent = (changes.new || []).length;
  $('#lostCount').textContent = (changes.lost || []).length;
  $('#lastUpdate').textContent = current?.timestamp ? formatDate(current.timestamp) : '-';

  const shown = acc?.label || current?.label || current?.username || active;
  showStatus(`「${shown}」のデータを表示中（${current?.count || 0}人）`);
  renderList($('.tab.active')?.dataset.tab || 'new');
}

function renderList(type) {
  const list = $('#userList');
  list.innerHTML = '';
  const items = type === 'new' ? (changesCache.new || []) : (changesCache.lost || []);
  if (items.length === 0) {
    list.innerHTML = `<li class="empty">${type === 'new' ? '新規フォロワーはまだありません' : '解除はまだありません'}</li>`;
    return;
  }
  items.slice(0, 200).forEach(item => {
    const u = item.user || item;
    const li = document.createElement('li');
    const avatar = u.avatar
      ? `<img src="${u.avatar}" alt="" loading="lazy" />`
      : `<div style="width:40px;height:40px;border-radius:50%;background:#2f3336;flex-shrink:0"></div>`;
    const badge = type === 'new' ? '<span class="badge new">NEW</span>' : '<span class="badge lost">解除</span>';
    li.innerHTML = `
      ${avatar}
      <div class="user-info">
        <div class="name">${escapeHtml(u.displayName || u.username)}</div>
        <div class="username">@${escapeHtml(u.username)}</div>
      </div>
      ${badge}
    `;
    li.addEventListener('click', () => {
      li.style.background = '#1d9bf044';
      setTimeout(() => { li.style.background = ''; }, 200);
      if (u.profileUrl) chrome.tabs.create({ url: u.profileUrl, active: true });
    });
    list.appendChild(li);
  });
}

function updateProgress(progress, text) {
  const bar = $('#progress');
  const fill = $('#progressBar');
  const txt = $('#progressText');
  if (progress < 0) {
    bar.style.display = 'none';
    return;
  }
  bar.style.display = 'block';
  fill.style.width = progress + '%';
  txt.textContent = text || (progress + '%');
}

function normalizeImportData(raw) {
  if (raw.accounts && typeof raw.accounts === 'object') {
    const accounts = {};
    for (const [k, v] of Object.entries(raw.accounts)) {
      if (!v || typeof v !== 'object') continue;
      const key = (k || '').toLowerCase().replace(/^@/, '');
      if (!key) continue;
      accounts[key] = {
        current: v.current || null,
        changes: v.changes || { new: [], lost: [] }
      };
    }
    return {
      accounts,
      activeAccount: (raw.activeAccount || Object.keys(accounts)[0] || null)
    };
  }

  if (raw.current || raw.changes) {
    let username =
      (raw.current && raw.current.username) ||
      raw.username ||
      raw.screenName ||
      'imported';
    username = String(username).toLowerCase().replace(/^@/, '');
    if (username === 'me' || !username) username = 'imported';
    const label = raw.label || raw.current?.label || null;
    const entry = {
      current: raw.current || null,
      changes: raw.changes || { new: [], lost: [] }
    };
    if (label) {
      entry.label = label;
      if (entry.current) entry.current.label = label;
    }
    return {
      accounts: {
        [username]: entry
      },
      activeAccount: username
    };
  }
  throw new Error('認識できないJSON形式です');
}

async function applyImport(normalized) {
  const importKeys = Object.keys(normalized.accounts);
  if (importKeys.length === 0) throw new Error('アカウントデータがありません');

  const existing = await chrome.storage.local.get(['accounts', 'activeAccount']);
  const accounts = existing.accounts || {};
  const overlap = importKeys.filter(k => accounts[k]);

  let mode = 'merge';
  if (overlap.length > 0) {
    const msg =
      `既にデータがあるアカウント:\n` +
      overlap.map(k => `  @${k}`).join('\n') +
      `\n\nOK=上書き / キャンセル=既存優先でマージ`;
    mode = confirm(msg) ? 'overwrite' : 'merge';
  } else {
    if (!confirm(`${importKeys.length}アカウントを読み込みます\n` + importKeys.map(k => `  @${k}`).join('\n'))) {
      return false;
    }
  }

  for (const key of importKeys) {
    if (mode === 'overwrite' || !accounts[key]) {
      accounts[key] = normalized.accounts[key];
    }
  }

  const active =
    normalized.activeAccount && accounts[normalized.activeAccount]
      ? normalized.activeAccount
      : (existing.activeAccount && accounts[existing.activeAccount]
        ? existing.activeAccount
        : importKeys[0]);

  await chrome.storage.local.set({ accounts, activeAccount: active });
  await loadDashboard();
  showStatus(`${importKeys.length}アカウントを読み込みました`);
  return true;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'scanStatus') {
    showStatus(msg.status, !!msg.error);
    if (msg.progress >= 0) updateProgress(msg.progress, msg.status);
    if (msg.done) {
      loadDashboard();
      $('#btnFullScan').disabled = false;
      $('#btnQuick').disabled = false;
      $('#btnStop').disabled = true;
    }
  }
});

$('#accountSelect').addEventListener('change', async (e) => {
  const name = e.target.value;
  if (!name) return;
  await chrome.runtime.sendMessage({ action: 'setActiveAccount', screenName: name });
  currentActive = name;
  await loadDashboard();
});

$('#btnDetect').addEventListener('click', async () => {
  showStatus('ログイン中のアカウントを確認中...（x.com を開いた状態で）');
  const res = await chrome.runtime.sendMessage({ action: 'detectLogin' });
  if (!res?.ok) {
    showStatus(res?.error || '検出失敗', true);
    return;
  }
  if (res.isPlaceholder) {
    showStatus(
      `IDのみ取得: @${res.screenName}。x.com を開いて再検出するか、名前を手入力してください`,
      true
    );
  } else {
    showStatus(`現在ログイン中: @${res.screenName}` + (res.migrated ? '（旧IDデータを移行しました）' : ''));
  }
  await loadDashboard();
});

$('#btnRename').addEventListener('click', async () => {
  if (!currentActive) {
    showStatus('対象アカウントがありません', true);
    return;
  }
  const data = await chrome.storage.local.get(['accounts']);
  const acc = data.accounts?.[currentActive];
  const currentLabel = acc?.label || acc?.current?.label || '';
  const input = prompt(
    `リストに表示する名前（日本語・漢字可）\n※内部キーは変わりません: ${currentActive}`,
    currentLabel || ''
  );
  if (input == null) return;
  const label = input.trim();
  if (!label) {
    showStatus('表示名が空です', true);
    return;
  }
  const res = await chrome.runtime.sendMessage({
    action: 'setAccountLabel',
    key: currentActive,
    label
  });
  if (!res?.ok) {
    showStatus(res?.error || '名前変更失敗', true);
    return;
  }
  await loadDashboard();
  showStatus(`表示名を「${res.label}」にしました`);
});

$('#btnDeleteAccount').addEventListener('click', async () => {
  if (!currentActive) {
    showStatus('削除するアカウントがありません', true);
    return;
  }
  if (!confirm(`@${currentActive} の保存データを削除しますか？`)) return;
  const deleted = currentActive;
  await chrome.runtime.sendMessage({ action: 'deleteAccount', screenName: currentActive });
  await loadDashboard();
  showStatus(`@${deleted} を削除しました`);
});

$('#btnFullScan').addEventListener('click', async () => {
  if (!confirm('数万人規模の場合、15〜40分程度かかる場合があります。\n現在ログイン中のアカウントをフルスキャンしますか？')) return;
  $('#btnFullScan').disabled = true;
  $('#btnQuick').disabled = true;
  $('#btnStop').disabled = false;
  showStatus('フルスキャン開始...');
  updateProgress(0, '開始中...');
  await chrome.runtime.sendMessage({ action: 'startFullScan' });
});

$('#btnQuick').addEventListener('click', async () => {
  if (!confirm('最新数ページだけ取得して新規を検出します（解除検出は不完全）。開始しますか？')) return;
  $('#btnFullScan').disabled = true;
  $('#btnQuick').disabled = true;
  $('#btnStop').disabled = false;
  showStatus('クイックスキャン開始...');
  updateProgress(0, '開始中...');
  await chrome.runtime.sendMessage({ action: 'startQuickScan', maxPages: 5 });
});

$('#btnStop').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ action: 'stopScan' });
  $('#btnFullScan').disabled = false;
  $('#btnQuick').disabled = false;
  $('#btnStop').disabled = true;
});

$$('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    renderList(tab.dataset.tab);
  });
});

$('#btnCheckNative').addEventListener('click', async () => {
  showStatus('Native Host 接続確認中...');
  const ok = await checkNative();
  if (ok) showStatus('Native Host 接続OK（拡張機能フォルダ内 json に保存します）');
  else showStatus('接続失敗。セットアップ.bat 実行と extension ID 登録を確認してください', true);
});

// 選択中アカウント出力 → 拡張機能フォルダ/json/
$('#btnExportOne').addEventListener('click', async () => {
  if (!currentActive) {
    showStatus('エクスポートするアカウントがありません', true);
    return;
  }
  try {
    if (nativeReady === null) await checkNative();
    if (!nativeReady) {
      showStatus('Native Host 未接続。セットアップ.bat を実行してください', true);
      return;
    }
    const data = await chrome.storage.local.get(['accounts']);
    const acc = data.accounts?.[currentActive];
    if (!acc) {
      showStatus('データが見つかりません', true);
      return;
    }
    const ts = timestampForFilename();
    const label = acc.label || acc.current?.label || currentActive;
    const filename = `${fileSafeLabel(label)}_${ts}.json`;
    const payload = {
      _format: 'x-follower-tracker-single',
      _version: 2,
      username: currentActive,
      label: label,
      current: acc.current,
      changes: acc.changes,
      exportedAt: new Date().toISOString()
    };
    const res = await nativeSend({ action: 'write', filename, data: payload });
    if (!res.ok) throw new Error(res.error || 'write failed');
    showStatus(`保存しました: json/${filename}`);
  } catch (e) {
    showStatus(`保存失敗: ${e.message}`, true);
  }
});

// 全アカウント出力
$('#btnExportAll').addEventListener('click', async () => {
  try {
    if (nativeReady === null) await checkNative();
    if (!nativeReady) {
      showStatus('Native Host 未接続。セットアップ.bat を実行してください', true);
      return;
    }
    const data = await chrome.storage.local.get(['accounts', 'activeAccount']);
    if (!data.accounts || Object.keys(data.accounts).length === 0) {
      showStatus('エクスポートするデータがありません', true);
      return;
    }
    const ts = timestampForFilename();
    const filename = `all_${ts}.json`;
    const payload = {
      _format: 'x-follower-tracker-multi',
      _version: 2,
      activeAccount: data.activeAccount || null,
      accounts: data.accounts,
      exportedAt: new Date().toISOString()
    };
    const res = await nativeSend({ action: 'write', filename, data: payload });
    if (!res.ok) throw new Error(res.error || 'write failed');
    showStatus(`全${Object.keys(data.accounts).length}アカウントを保存: json/${filename}`);
  } catch (e) {
    showStatus(`保存失敗: ${e.message}`, true);
  }
});

// 任意ファイル読込（フォールバック）
$('#btnImport').addEventListener('click', () => {
  $('#importFile').click();
});

$('#importFile').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    const raw = JSON.parse(await file.text());
    const normalized = normalizeImportData(raw);
    await applyImport(normalized);
  } catch (err) {
    showStatus(`読込失敗: ${err.message}`, true);
  }
});

// json フォルダ内の最新を読込
$('#btnImportLatest').addEventListener('click', async () => {
  try {
    if (nativeReady === null) await checkNative();
    if (!nativeReady) {
      showStatus('Native Host 未接続。セットアップ.bat を実行してください', true);
      return;
    }
    const prefixes = [];
    if (currentActive) {
      prefixes.push(currentActive);
      const lab = await getAccountLabel(currentActive);
      if (lab && lab !== currentActive) prefixes.push(lab);
      prefixes.push(fileSafeLabel(lab || currentActive));
    }
    const res = await nativeSend({ action: 'readLatest', prefixes });
    if (!res.ok) throw new Error(res.error || 'readLatest failed');

    if (!confirm(`最新ファイルを読み込みますか？\n\n${res.filename}`)) return;

    const normalized = normalizeImportData(res.data);
    // JSON内の label、なければファイル名から（表示名_日時.json）
    let label = res.data?.label || null;
    if (!label && res.filename) {
      const m = String(res.filename).match(/^(.+)_(\d{8})_(\d{6})\.json$/i);
      if (m && m[1] && m[1].toLowerCase() !== 'all') label = m[1];
    }
    if (label) {
      for (const k of Object.keys(normalized.accounts)) {
        normalized.accounts[k].label = label;
        if (normalized.accounts[k].current) {
          normalized.accounts[k].current.label = label;
        }
      }
    }
    await applyImport(normalized);
  } catch (e) {
    showStatus(`最新読込失敗: ${e.message}`, true);
  }
});

$('#btnClear').addEventListener('click', async () => {
  if (!confirm('全アカウントの保存データと履歴をすべて削除しますか？')) return;
  await chrome.storage.local.clear();
  await loadDashboard();
  showStatus('全データを削除しました');
});

// 初期化
(async () => {
  await loadDashboard();
  $('#btnStop').disabled = true;
  await checkNative();
})();

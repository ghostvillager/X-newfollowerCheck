const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

let changesCache = { new: [], lost: [] };

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
  return `${d.getMonth()+1}/${d.getDate()} ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
}

async function loadDashboard() {
  const data = await chrome.storage.local.get(['current', 'changes']);
  const current = data.current;
  const changes = data.changes || { new: [], lost: [] };
  changesCache = changes;

  $('#savedCount').textContent = current?.count?.toLocaleString() || '0';
  $('#newCount').textContent = (changes.new || []).length;
  $('#lostCount').textContent = (changes.lost || []).length;
  $('#lastUpdate').textContent = current?.timestamp ? formatDate(current.timestamp) : '-';

  if (current) {
    showStatus(`@${current.username || 'me'} のデータを保持中（${current.count}人）`);
  } else {
    showStatus('まだデータがありません。「フルスキャン開始」を押してください');
  }
  renderList('new');
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
        <div class="name">${u.displayName || u.username}</div>
        <div class="username">@${u.username}</div>
      </div>
      ${badge}
    `;

    li.addEventListener('click', () => {
      // 一時的なハイライト
      li.style.background = '#1d9bf044';
      setTimeout(() => { li.style.background = ''; }, 200);

      // プロフィールを新しいタブで開く
      if (u.profileUrl) {
        chrome.tabs.create({ url: u.profileUrl, active: true });
      }
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

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'scanStatus') {
    showStatus(msg.status, !!msg.error);
    if (msg.progress >= 0) updateProgress(msg.progress, msg.status);
    if (msg.done) {
      loadDashboard();
      $('#btnFullScan').disabled = false;
      $('#btnStop').disabled = true;
    }
  }
});

$('#btnFullScan').addEventListener('click', async () => {
  if (!confirm('数万人規模の場合、15〜40分程度かかる場合があります。開始しますか？')) return;
  $('#btnFullScan').disabled = true;
  $('#btnStop').disabled = false;
  showStatus('スキャン開始...');
  updateProgress(0, '開始中...');
  await chrome.runtime.sendMessage({ action: 'startFullScan' });
});

$('#btnStop').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ action: 'stopScan' });
  $('#btnFullScan').disabled = false;
  $('#btnStop').disabled = true;
});

$$('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    renderList(tab.dataset.tab);
  });
});

$('#btnExport').addEventListener('click', async () => {
  const data = await chrome.storage.local.get(null);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `x-followers-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

$('#btnClear').addEventListener('click', async () => {
  if (!confirm('保存データと履歴をすべて削除しますか？')) return;
  await chrome.storage.local.clear();
  loadDashboard();
});

loadDashboard();
$('#btnStop').disabled = true;

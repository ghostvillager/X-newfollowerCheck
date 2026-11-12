(() => {
  'use strict';

  const CURRENT_KEY = 'xft_current';
  const PREV_KEY = 'xft_prev';
  const CHANGES_KEY = 'xft_changes';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  let currentTab = null;
  let changesCache = { new: [], lost: [] };

  function showToast(msg, isError = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.toggle('error', isError);
    t.classList.remove('hidden');
    setTimeout(() => t.classList.add('hidden'), 2800);
  }

  function formatDate(ts) {
    if (!ts) return '-';
    const d = new Date(ts);
    const now = new Date();
    const diff = (now - d) / 1000;
    if (diff < 60) return 'たった今';
    if (diff < 3600) return Math.floor(diff / 60) + '分前';
    if (diff < 86400) return Math.floor(diff / 3600) + '時間前';
    return `${d.getMonth()+1}/${d.getDate()} ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  async function loadDashboard() {
    const data = await chrome.storage.local.get([CURRENT_KEY, CHANGES_KEY]);
    const current = data[CURRENT_KEY];
    const changes = data[CHANGES_KEY] || { new: [], lost: [] };
    changesCache = changes;

    const newCount = (changes.new || []).length;
    const lostCount = (changes.lost || []).length;

    $('#dashNew').textContent = newCount;
    $('#dashLost').textContent = lostCount;
    $('#newCount').textContent = newCount;
    $('#lostCount').textContent = lostCount;

    if (current && current.users) {
      $('#savedCount').textContent = current.users.length.toLocaleString();
      $('#lastUpdate').textContent = formatDate(current.timestamp);
      if (current.username) {
        $('#pageStatus').textContent = `@${current.username} のデータを保持中`;
      }
    } else {
      $('#savedCount').textContent = '0';
      $('#lastUpdate').textContent = '未保存';
      $('#pageStatus').textContent = '「データを更新する」を押すと取得を開始します（Xにログイン済みである必要があります）';
    }
    renderList('new');
  }

  function renderList(type) {
    const list = $('#userList');
    list.innerHTML = '';
    const items = type === 'new' ? (changesCache.new || []) : (changesCache.lost || []);

    if (items.length === 0) {
      list.innerHTML = `<li class="empty">${type === 'new' ? '新規フォロワーはまだありません' : '解除されたフォロワーはまだありません'}<br><small>「データを更新する」で最新を取得してください</small></li>`;
      return;
    }

    items.slice(0, 120).forEach(item => {
      const u = item.user || item;
      const date = item.date ? formatDate(item.date) : '';
      const li = document.createElement('li');
      const avatar = u.avatar
        ? `<img src="${u.avatar}" alt="" loading="lazy" />`
        : `<div style="width:32px;height:32px;border-radius:50%;background:#2f3336;flex-shrink:0"></div>`;
      const badge = type === 'new'
        ? '<span class="badge new">NEW</span>'
        : '<span class="badge lost">解除</span>';
      li.innerHTML = `
        ${avatar}
        <div class="user-meta">
          <a href="${u.profileUrl || 'https://x.com/' + u.username}" target="_blank" rel="noopener">
            <div class="name">${escapeHtml(u.displayName || u.username)}</div>
            <div class="handle">@${escapeHtml(u.username)}</div>
          </a>
          ${date ? `<div class="date-tag">${date}</div>` : ''}
        </div>
        ${badge}
      `;
      list.appendChild(li);
    });
  }

  // One-click update via background (no need to open followers page)
  async function oneClickUpdate() {
    const btn = $('#btnUpdate');
    btn.disabled = true;
    btn.textContent = '取得中...';
    showToast('ログインセッションでフォロワーを取得しています...');

    try {
      const res = await chrome.runtime.sendMessage({ action: 'oneClickUpdate', maxUsers: 4000 });
      if (!res || !res.ok) {
        // Fallback: try page-based scan if tab is on followers
        if (res?.needPage) {
          showToast('自動取得に失敗。フォロワーページを開いて「表示分だけ」を試してください', true);
          $('#pageStatus').textContent = res.error || '自動取得失敗。ページから更新してください';
        } else {
          showToast(res?.error || '更新に失敗しました', true);
        }
        return;
      }
      await loadDashboard();
      const msg = `更新完了 ${res.count}人 / 今回 新規+${res.addedThisTime || 0} 解除+${res.removedThisTime || 0}`;
      showToast(msg);
      $('#pageStatus').textContent = `@${res.username || ''} を更新しました`;
    } catch (e) {
      console.error(e);
      showToast(e.message || 'エラーが発生しました', true);
    } finally {
      btn.disabled = false;
      btn.textContent = 'データを更新する';
    }
  }

  // Fallback: page scrape
  async function pageScan(mode) {
    currentTab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (!currentTab) {
      showToast('アクティブなタブがありません', true);
      return;
    }
    const url = currentTab.url || '';
    if (!/x\.com\/[^/]+\/followers|twitter\.com\/[^/]+\/followers/.test(url)) {
      showToast('フォロワー一覧ページを開いてから押してください', true);
      return;
    }

    const btns = [$('#btnUpdate'), $('#btnScanLoaded'), $('#btnAutoScan')];
    btns.forEach(b => { if (b) b.disabled = true; });
    showToast(mode === 'auto' ? 'ページをスクロールして取得中...' : '表示分を取得中...');

    try {
      try {
        await chrome.tabs.sendMessage(currentTab.id, { action: 'ping' });
      } catch {
        await chrome.scripting.executeScript({ target: { tabId: currentTab.id }, files: ['js/content.js'] });
        await new Promise(r => setTimeout(r, 400));
      }
      const action = mode === 'auto' ? 'autoScan' : 'extractLoaded';
      const res = await chrome.tabs.sendMessage(currentTab.id, { action, maxScrolls: 70 });
      if (!res || !res.ok) throw new Error(res?.error || '取得失敗');

      // Commit via storage (reuse same logic as background)
      const data = await chrome.storage.local.get([CURRENT_KEY, CHANGES_KEY]);
      const prev = data[CURRENT_KEY] || null;
      const changes = data[CHANGES_KEY] || { new: [], lost: [] };
      const users = res.users || [];
      const snapshot = {
        username: (url.match(/x\.com\/([^/]+)\/followers/) || [])[1] || 'unknown',
        users,
        count: users.length,
        timestamp: Date.now()
      };
      if (prev && prev.users) {
        const oldMap = new Map(prev.users.map(u => [u.username.toLowerCase(), u]));
        const newMap = new Map(users.map(u => [u.username.toLowerCase(), u]));
        const now = Date.now();
        for (const [k, u] of newMap) if (!oldMap.has(k)) changes.new.unshift({ user: u, date: now });
        for (const [k, u] of oldMap) if (!newMap.has(k)) changes.lost.unshift({ user: u, date: now });
        if (changes.new.length > 400) changes.new.length = 400;
        if (changes.lost.length > 400) changes.lost.length = 400;
      }
      await chrome.storage.local.set({ [PREV_KEY]: prev, [CURRENT_KEY]: snapshot, [CHANGES_KEY]: changes });
      await loadDashboard();
      showToast(`ページから更新: ${users.length}人`);
    } catch (e) {
      showToast(e.message || 'エラー', true);
    } finally {
      btns.forEach(b => { if (b) b.disabled = false; });
    }
  }

  // Events
  $('#btnUpdate').addEventListener('click', () => oneClickUpdate());
  $('#btnScanLoaded').addEventListener('click', () => pageScan('loaded'));
  $('#btnAutoScan').addEventListener('click', () => {
    if (!confirm('フォロワーページ上で自動スクロール取得しますか？')) return;
    pageScan('auto');
  });

  $$('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      renderList(tab.dataset.tab);
    });
  });

  $('#btnExport').addEventListener('click', async () => {
    const data = await chrome.storage.local.get([CURRENT_KEY, CHANGES_KEY, PREV_KEY]);
    if (!data[CURRENT_KEY] && !(data[CHANGES_KEY]?.new?.length)) {
      showToast('データがありません', true);
      return;
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `x-followers-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('エクスポートしました');
  });

  $('#btnClear').addEventListener('click', async () => {
    if (!confirm('すべての保存データと履歴を削除しますか？')) return;
    await chrome.storage.local.remove([CURRENT_KEY, PREV_KEY, CHANGES_KEY]);
    changesCache = { new: [], lost: [] };
    await loadDashboard();
    showToast('削除しました');
  });

  (async () => {
    await loadDashboard();
    // Enable main button always (one-click)
    $('#btnUpdate').disabled = false;
  })();
})();

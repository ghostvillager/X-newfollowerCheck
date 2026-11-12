(() => {
  'use strict';

  const CURRENT_KEY = 'xft_current';
  const PREV_KEY = 'xft_prev';
  const CHANGES_KEY = 'xft_changes';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  let changesCache = { new: [], lost: [] };

  function showToast(msg, isError = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.toggle('error', isError);
    t.classList.remove('hidden');
    setTimeout(() => t.classList.add('hidden'), 3000);
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

  function isFollowersLikeUrl(url) {
    return /x\.com\/[^/]+\/(followers|verified_followers|following)|twitter\.com\/[^/]+\/(followers|verified_followers|following)/.test(url || '');
  }

  function usernameFromUrl(url) {
    const m = (url || '').match(/(?:x|twitter)\.com\/([^/]+)\/(?:followers|verified_followers|following)/);
    return m ? m[1] : null;
  }

  async function loadDashboard() {
    const data = await chrome.storage.local.get([CURRENT_KEY, CHANGES_KEY]);
    const current = data[CURRENT_KEY];
    const changes = data[CHANGES_KEY] || { new: [], lost: [] };
    changesCache = changes;

    $('#dashNew').textContent = (changes.new || []).length;
    $('#dashLost').textContent = (changes.lost || []).length;
    $('#newCount').textContent = (changes.new || []).length;
    $('#lostCount').textContent = (changes.lost || []).length;

    if (current && current.users) {
      $('#savedCount').textContent = current.users.length.toLocaleString();
      $('#lastUpdate').textContent = formatDate(current.timestamp);
      $('#pageStatus').textContent = current.username
        ? `@${current.username} のデータを保持中（${current.users.length}人）`
        : `データを保持中（${current.users.length}人）`;
    } else {
      $('#savedCount').textContent = '0';
      $('#lastUpdate').textContent = '未保存';
      $('#pageStatus').textContent = 'フォロワー一覧ページを開いて「表示分だけ」または「ページ自動取得」を押してください';
    }
    renderList('new');
  }

  function renderList(type) {
    const list = $('#userList');
    list.innerHTML = '';
    const items = type === 'new' ? (changesCache.new || []) : (changesCache.lost || []);
    if (items.length === 0) {
      list.innerHTML = `<li class="empty">${type === 'new' ? '新規はまだありません' : '解除はまだありません'}<br><small>ページから更新するとここに出ます</small></li>`;
      return;
    }
    items.slice(0, 120).forEach(item => {
      const u = item.user || item;
      const date = item.date ? formatDate(item.date) : '';
      const li = document.createElement('li');
      const avatar = u.avatar
        ? `<img src="${u.avatar}" alt="" loading="lazy" />`
        : `<div style="width:32px;height:32px;border-radius:50%;background:#2f3336;flex-shrink:0"></div>`;
      const badge = type === 'new' ? '<span class="badge new">NEW</span>' : '<span class="badge lost">解除</span>';
      li.innerHTML = `
        ${avatar}
        <div class="user-meta">
          <a href="${u.profileUrl || 'https://x.com/' + u.username}" target="_blank" rel="noopener">
            <div class="name">${escapeHtml(u.displayName || u.username)}</div>
            <div class="handle">@${escapeHtml(u.username)}</div>
          </a>
          ${date ? `<div class="date-tag">${date}</div>` : ''}
        </div>
        ${badge}`;
      list.appendChild(li);
    });
  }

  async function pageScan(mode) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab) {
      showToast('タブが見つかりません', true);
      return;
    }
    if (!isFollowersLikeUrl(tab.url)) {
      showToast('フォロワー（または認証済みフォロワー）の一覧ページを開いてください', true);
      $('#pageStatus').textContent = '例: x.com/自分のID/followers を開いてから押す';
      return;
    }

    const btns = [$('#btnUpdate'), $('#btnScanLoaded'), $('#btnAutoScan')];
    btns.forEach(b => { if (b) b.disabled = true; });
    showToast(mode === 'auto' ? 'スクロールして取得中…（そのまま待ってください）' : '表示中のユーザーを取得中…');

    try {
      try {
        await chrome.tabs.sendMessage(tab.id, { action: 'ping' });
      } catch {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['js/content.js'] });
        await new Promise(r => setTimeout(r, 500));
      }

      const res = await chrome.tabs.sendMessage(tab.id, {
        action: mode === 'auto' ? 'autoScan' : 'extractLoaded',
        maxScrolls: 90
      });
      if (!res || !res.ok) throw new Error(res?.error || '取得に失敗しました');

      const users = res.users || [];
      if (users.length === 0) {
        showToast('ユーザーが0件でした。少しスクロールしてから再度「表示分だけ」を押してください', true);
        return;
      }

      const uname = usernameFromUrl(tab.url) || 'unknown';
      const data = await chrome.storage.local.get([CURRENT_KEY, CHANGES_KEY]);
      const prev = data[CURRENT_KEY] || null;
      const changes = data[CHANGES_KEY] || { new: [], lost: [] };

      const snapshot = {
        username: uname,
        users,
        count: users.length,
        timestamp: Date.now()
      };

      let added = 0, removed = 0;
      if (prev && prev.users && prev.users.length) {
        const oldMap = new Map(prev.users.map(u => [u.username.toLowerCase(), u]));
        const newMap = new Map(users.map(u => [u.username.toLowerCase(), u]));
        const now = Date.now();
        for (const [k, u] of newMap) {
          if (!oldMap.has(k)) {
            changes.new.unshift({ user: u, date: now });
            added++;
          }
        }
        for (const [k, u] of oldMap) {
          if (!newMap.has(k)) {
            changes.lost.unshift({ user: u, date: now });
            removed++;
          }
        }
        if (changes.new.length > 400) changes.new.length = 400;
        if (changes.lost.length > 400) changes.lost.length = 400;
      }

      await chrome.storage.local.set({
        [PREV_KEY]: prev,
        [CURRENT_KEY]: snapshot,
        [CHANGES_KEY]: changes
      });

      await loadDashboard();
      const msg = prev
        ? `保存 ${users.length}人 / 今回 新規+${added} 解除+${removed}`
        : `初回保存: ${users.length}人（次回更新から差分が出ます）`;
      showToast(msg);
    } catch (e) {
      console.error(e);
      showToast(e.message || 'エラー', true);
    } finally {
      btns.forEach(b => { if (b) b.disabled = false; });
    }
  }

  // One-click is secondary now; main path is page scan
  async function oneClickUpdate() {
    showToast('自動取得は不安定なため、下の「表示分だけ」か「ページ自動取得」を使ってください', true);
    $('#pageStatus').textContent = 'フォロワー一覧を開いた状態で「表示分だけ」または「ページ自動取得」を押してください';
  }

  $('#btnUpdate').addEventListener('click', () => oneClickUpdate());
  $('#btnScanLoaded').addEventListener('click', () => pageScan('loaded'));
  $('#btnAutoScan').addEventListener('click', () => {
    if (!confirm('ページを下に自動スクロールしてフォロワーを集めます。実行しますか？')) return;
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
    if (!confirm('保存データと履歴をすべて削除しますか？')) return;
    await chrome.storage.local.remove([CURRENT_KEY, PREV_KEY, CHANGES_KEY]);
    changesCache = { new: [], lost: [] };
    await loadDashboard();
    showToast('削除しました');
  });

  (async () => {
    await loadDashboard();
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (tab && isFollowersLikeUrl(tab.url)) {
      $('#pageStatus').textContent = 'このページから取得できます。「表示分だけ」または「ページ自動取得」を押してください';
      $('#btnScanLoaded').disabled = false;
      $('#btnAutoScan').disabled = false;
    }
  })();
})();

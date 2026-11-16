// X Follower Tracker - Large Scale via internal REST v1.1
// Multi-account support

const BEARER = 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

let scanning = false;
let abortController = null;

function apiHeaders(ct0) {
  return {
    'Authorization': BEARER,
    'X-Csrf-Token': ct0,
    'X-Twitter-Active-User': 'yes',
    'X-Twitter-Auth-Type': 'OAuth2Session',
    'X-Twitter-Client-Language': 'ja',
    'Content-Type': 'application/json'
  };
}

async function getAuth() {
  const cookies = await chrome.cookies.getAll({ domain: '.x.com' });
  const ct0 = cookies.find(c => c.name === 'ct0')?.value;
  const authToken = cookies.find(c => c.name === 'auth_token')?.value;
  if (!ct0 || !authToken) {
    throw new Error('Xにログインしていません。x.comを開いてログインしてください。');
  }

  let userId = null;
  let screenName = null;

  // 1. twid クッキーからユーザーID
  const twid = cookies.find(c => c.name === 'twid')?.value;
  if (twid) {
    const match = decodeURIComponent(twid).match(/u[=%](\d+)/);
    if (match) userId = match[1];
  }

  // 2. verify_credentials
  try {
    const resp = await fetch('https://x.com/i/api/1.1/account/verify_credentials.json?include_entities=false&skip_status=true', {
      headers: apiHeaders(ct0),
      credentials: 'include'
    });
    if (resp.ok) {
      const data = await resp.json();
      userId = data.id_str || userId;
      if (data.screen_name) screenName = data.screen_name;
    } else {
      console.warn('verify_credentials status', resp.status);
    }
  } catch (e) {
    console.warn('verify_credentials failed', e);
  }

  // 3. users/show.json?user_id=
  if (userId && !screenName) {
    try {
      const resp = await fetch(`https://x.com/i/api/1.1/users/show.json?user_id=${userId}`, {
        headers: apiHeaders(ct0),
        credentials: 'include'
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data.screen_name) screenName = data.screen_name;
        userId = data.id_str || userId;
      }
    } catch (e) {
      console.warn('users/show failed', e);
    }
  }

  // 4. account/settings.json（screen_name を返すことがある）
  if (!screenName) {
    try {
      const resp = await fetch('https://x.com/i/api/1.1/account/settings.json', {
        headers: apiHeaders(ct0),
        credentials: 'include'
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data.screen_name) screenName = data.screen_name;
      }
    } catch (e) {
      console.warn('account/settings failed', e);
    }
  }

  if (!userId) {
    throw new Error('ユーザーIDの取得に失敗しました。x.comを再読み込みしてからもう一度お試しください。');
  }
  if (!screenName) {
    // 最終手段（後でリネーム可能な仮名）
    screenName = `id_${userId}`;
  }

  return { ct0, userId, screenName, bearer: BEARER };
}

/** id_数字 キーのデータを正式な screen_name へ移行 */
async function migrateAccountKey(userId, screenName) {
  const key = screenName.toLowerCase();
  const legacy = `id_${userId}`.toLowerCase();
  if (key === legacy) return;

  const data = await chrome.storage.local.get(['accounts', 'activeAccount']);
  const accounts = data.accounts || {};
  if (accounts[legacy] && !accounts[key]) {
    accounts[key] = accounts[legacy];
    if (accounts[key].current) {
      accounts[key].current.username = screenName;
    }
    delete accounts[legacy];
    const active = (data.activeAccount || '').toLowerCase() === legacy ? key : data.activeAccount;
    await chrome.storage.local.set({ accounts, activeAccount: active });
  }
}


/** リスト表示用ラベルのみ変更（内部キー維持・日本語可） */
async function setAccountLabel(accountKey, label) {
  const key = String(accountKey || '').toLowerCase().replace(/^@/, '');
  const labelText = String(label || '').trim();
  if (!key) throw new Error('アカウントが指定されていません');
  if (!labelText) throw new Error('表示名が空です');
  if (labelText.length > 40) throw new Error('表示名は40文字以内にしてください');

  const data = await chrome.storage.local.get(['accounts']);
  const accounts = data.accounts || {};
  if (!accounts[key]) throw new Error('元データがありません: ' + key);

  accounts[key].label = labelText;
  if (accounts[key].current) accounts[key].current.label = labelText;
  await chrome.storage.local.set({ accounts });
  return { key, label: labelText };
}

async function fetchFollowersPage(userId, cursor, ct0) {
  const params = new URLSearchParams({
    user_id: userId,
    count: '200',
    skip_status: 'true',
    include_user_entities: 'false'
  });
  if (cursor && cursor !== '-1' && cursor !== '0') {
    params.set('cursor', cursor);
  }

  const resp = await fetch(`https://x.com/i/api/1.1/followers/list.json?${params}`, {
    headers: {
      'Authorization': BEARER,
      'X-Csrf-Token': ct0,
      'X-Twitter-Active-User': 'yes',
      'X-Twitter-Auth-Type': 'OAuth2Session'
    },
    credentials: 'include'
  });

  if (resp.status === 429) throw new Error('RATE_LIMIT');
  if (!resp.ok) throw new Error(`APIエラー: ${resp.status}`);
  return resp.json();
}

async function getAccountData(screenName) {
  const key = screenName.toLowerCase();
  const data = await chrome.storage.local.get(['accounts']);
  const accounts = data.accounts || {};
  return accounts[key] || null;
}

async function saveAccountData(screenName, accountData) {
  const key = screenName.toLowerCase();
  const data = await chrome.storage.local.get(['accounts', 'activeAccount']);
  const accounts = data.accounts || {};
  // 既存の表示名ラベルを維持
  const prevLabel = accounts[key]?.label || accounts[key]?.current?.label;
  if (prevLabel) {
    accountData.label = prevLabel;
    if (accountData.current) accountData.current.label = prevLabel;
  }
  accounts[key] = accountData;
  await chrome.storage.local.set({
    accounts,
    activeAccount: key
  });
}

async function fullScan(maxPages = 0) {
  // maxPages = 0 なら全ページ、>0 なら指定ページ数で打ち切り（クイック用）
  if (scanning) return;
  scanning = true;
  abortController = new AbortController();

  try {
    const { ct0, userId, screenName } = await getAuth();
    await migrateAccountKey(userId, screenName);
    const allUsers = new Map();
    let cursor = null;
    let page = 0;
    let consecutiveEmpty = 0;

    chrome.runtime.sendMessage({
      type: 'scanStatus',
      status: `@${screenName} のスキャン開始...`,
      progress: 0,
      screenName
    });

    while (scanning) {
      page++;
      if (maxPages > 0 && page > maxPages) break;

      try {
        const data = await fetchFollowersPage(userId, cursor, ct0);
        const users = data.users || [];

        if (users.length === 0) {
          consecutiveEmpty++;
          if (consecutiveEmpty >= 2) break;
        } else {
          consecutiveEmpty = 0;
          for (const u of users) {
            const key = (u.screen_name || '').toLowerCase();
            if (key) {
              allUsers.set(key, {
                username: u.screen_name,
                displayName: u.name || u.screen_name,
                id: u.id_str,
                avatar: u.profile_image_url_https || '',
                bio: (u.description || '').slice(0, 200),
                profileUrl: `https://x.com/${u.screen_name}`,
                followersCount: u.followers_count,
                followingCount: u.friends_count
              });
            }
          }
        }

        const nextCursor = data.next_cursor_str || data.next_cursor;
        cursor = nextCursor != null ? String(nextCursor) : null;

        const progress = maxPages > 0
          ? Math.min(99, Math.round((page / maxPages) * 100))
          : Math.min(99, page * 2); // 大雑把

        chrome.runtime.sendMessage({
          type: 'scanStatus',
          status: `@${screenName} ${allUsers.size}人取得中... (p${page})`,
          progress,
          count: allUsers.size,
          screenName
        });

        if (!cursor || cursor === '0' || cursor === '-1') break;

        await new Promise(r => setTimeout(r, 1200 + Math.random() * 800));
      } catch (e) {
        if (e.message === 'RATE_LIMIT') {
          chrome.runtime.sendMessage({
            type: 'scanStatus',
            status: 'レート制限中... 60秒待機',
            progress: -1,
            screenName
          });
          await new Promise(r => setTimeout(r, 60000));
          continue;
        }
        throw e;
      }
    }

    // 差分計算（アカウント単位）
    const prevData = await getAccountData(screenName);
    const previous = prevData?.current?.users || [];
    const prevMap = new Map(previous.map(u => [u.username.toLowerCase(), u]));
    const currMap = allUsers;

    const now = Date.now();
    const changes = { new: [], lost: [] };

    // フルスキャン時のみ lost を正確に計算。クイック時は new のみ（不完全なので lost は触らない）
    if (maxPages === 0) {
      for (const [k, u] of currMap) {
        if (!prevMap.has(k)) changes.new.push({ user: u, date: now });
      }
      for (const [k, u] of prevMap) {
        if (!currMap.has(k)) changes.lost.push({ user: u, date: now });
      }
    } else {
      // クイック: 取得できた範囲の新規だけ
      for (const [k, u] of currMap) {
        if (!prevMap.has(k)) changes.new.push({ user: u, date: now });
      }
      // lost は前回のものを維持
      if (prevData?.changes?.lost) {
        changes.lost = prevData.changes.lost;
      }
    }

    // 上限
    if (changes.new.length > 500) changes.new = changes.new.slice(0, 500);
    if (changes.lost.length > 500) changes.lost = changes.lost.slice(0, 500);

    // クイックの場合は users をマージ（既存 + 今回取得分）
    let usersArray;
    if (maxPages === 0) {
      usersArray = Array.from(allUsers.values());
    } else {
      // 既存をベースに上書き
      const merged = new Map(prevMap);
      for (const [k, u] of allUsers) merged.set(k, u);
      usersArray = Array.from(merged.values());
    }

    await saveAccountData(screenName, {
      current: {
        users: usersArray,
        count: usersArray.length,
        timestamp: now,
        username: screenName,
        userId
      },
      changes
    });

    chrome.runtime.sendMessage({
      type: 'scanStatus',
      status: `完了: @${screenName} ${usersArray.length}人`,
      progress: 100,
      count: usersArray.length,
      done: true,
      screenName
    });
  } catch (e) {
    chrome.runtime.sendMessage({
      type: 'scanStatus',
      status: `エラー: ${e.message}`,
      progress: -1,
      error: true
    });
  } finally {
    scanning = false;
  }
}

function stopScan() {
  scanning = false;
  if (abortController) abortController.abort();
  chrome.runtime.sendMessage({ type: 'scanStatus', status: '停止しました', progress: -1 });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'startFullScan') {
    fullScan(0);
    sendResponse({ ok: true });
  } else if (msg.action === 'startQuickScan') {
    // 最新数ページだけ（新規検出用）
    fullScan(msg.maxPages || 5);
    sendResponse({ ok: true });
  } else if (msg.action === 'stopScan') {
    stopScan();
    sendResponse({ ok: true });
  } else if (msg.action === 'getStatus') {
    sendResponse({ scanning });
  } else if (msg.action === 'detectLogin') {
    (async () => {
      try {
        const auth = await getAuth();
        const migrated = await migrateAccountKey(auth.userId, auth.screenName);
        sendResponse({
          ok: true,
          screenName: auth.screenName,
          userId: auth.userId,
          migrated,
          isPlaceholder: String(auth.screenName).toLowerCase().startsWith('id_')
        });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  } else if (msg.action === 'setAccountLabel') {
    setAccountLabel(msg.key, msg.label).then(r => {
      sendResponse({ ok: true, ...r });
    }).catch(e => {
      sendResponse({ ok: false, error: e.message });
    });
    return true;
  } else if (msg.action === 'setActiveAccount') {
    chrome.storage.local.set({ activeAccount: (msg.screenName || '').toLowerCase() })
      .then(() => sendResponse({ ok: true }));
    return true;
  } else if (msg.action === 'deleteAccount') {
    const key = (msg.screenName || '').toLowerCase();
    chrome.storage.local.get(['accounts', 'activeAccount']).then(data => {
      const accounts = data.accounts || {};
      delete accounts[key];
      const update = { accounts };
      if ((data.activeAccount || '').toLowerCase() === key) {
        const keys = Object.keys(accounts);
        update.activeAccount = keys[0] || null;
      }
      return chrome.storage.local.set(update);
    }).then(() => sendResponse({ ok: true }));
    return true;
  }
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('X Follower Tracker (Multi-account) installed');
});

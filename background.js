// X Follower Tracker - Large Scale via internal REST v1.1
// Uses https://x.com/i/api/1.1/followers/list.json

const BEARER = 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

let scanning = false;
let abortController = null;

async function getAuth() {
  const cookies = await chrome.cookies.getAll({ domain: '.x.com' });
  const ct0 = cookies.find(c => c.name === 'ct0')?.value;
  const authToken = cookies.find(c => c.name === 'auth_token')?.value;
  if (!ct0 || !authToken) throw new Error('Xにログインしていません。x.comを開いてログインしてください。');

  // 1. twid クッキーからユーザーIDを取得（最も確実）
  let userId = null;
  const twid = cookies.find(c => c.name === 'twid')?.value;
  if (twid) {
    // twid は "u%3D1234567890" または "u=1234567890" 形式
    const match = decodeURIComponent(twid).match(/u[=%](\d+)/);
    if (match) userId = match[1];
  }

  // 2. フォールバック: verify_credentials
  if (!userId) {
    try {
      const resp = await fetch('https://x.com/i/api/1.1/account/verify_credentials.json', {
        headers: {
          'Authorization': BEARER,
          'X-Csrf-Token': ct0,
          'X-Twitter-Active-User': 'yes',
          'X-Twitter-Auth-Type': 'OAuth2Session'
        },
        credentials: 'include'
      });
      if (resp.ok) {
        const data = await resp.json();
        userId = data.id_str;
      }
    } catch (e) {
      console.warn('verify_credentials failed', e);
    }
  }

  if (!userId) throw new Error('ユーザーIDの取得に失敗しました。x.comを再読み込みしてからもう一度お試しください。');
  return { ct0, userId, bearer: BEARER };
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

  if (resp.status === 429) {
    throw new Error('RATE_LIMIT');
  }
  if (!resp.ok) {
    throw new Error(`APIエラー: ${resp.status}`);
  }
  return resp.json();
}

async function fullScan() {
  if (scanning) return;
  scanning = true;
  abortController = new AbortController();

  try {
    const { ct0, userId } = await getAuth();
    const allUsers = new Map();
    let cursor = null;
    let page = 0;
    let consecutiveEmpty = 0;

    chrome.runtime.sendMessage({ type: 'scanStatus', status: '開始しました...', progress: 0 });

    while (scanning) {
      page++;
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

        cursor = data.next_cursor_str;
        const progress = Math.min(99, Math.floor((allUsers.size / 1000) * 10)); // rough
        chrome.runtime.sendMessage({
          type: 'scanStatus',
          status: `${allUsers.size}人取得中... (ページ${page})`,
          progress,
          count: allUsers.size
        });

        if (!cursor || cursor === '0' || cursor === '-1') break;

        // Delay to avoid rate limit
        await new Promise(r => setTimeout(r, 1200 + Math.random() * 800));
      } catch (e) {
        if (e.message === 'RATE_LIMIT') {
          chrome.runtime.sendMessage({ type: 'scanStatus', status: 'レート制限中... 60秒待機', progress: -1 });
          await new Promise(r => setTimeout(r, 60000));
          continue;
        }
        throw e;
      }
    }

    // Save snapshot and compute diff
    const usersArray = Array.from(allUsers.values());
    const prev = await chrome.storage.local.get(['current']);
    const previous = prev.current?.users || [];
    const prevMap = new Map(previous.map(u => [u.username.toLowerCase(), u]));
    const currMap = allUsers;

    const now = Date.now();
    const changes = { new: [], lost: [] };

    for (const [k, u] of currMap) {
      if (!prevMap.has(k)) changes.new.push({ user: u, date: now });
    }
    for (const [k, u] of prevMap) {
      if (!currMap.has(k)) changes.lost.push({ user: u, date: now });
    }

    // Keep only recent changes
    if (changes.new.length > 500) changes.new = changes.new.slice(0, 500);
    if (changes.lost.length > 500) changes.lost = changes.lost.slice(0, 500);

    await chrome.storage.local.set({
      current: {
        users: usersArray,
        count: usersArray.length,
        timestamp: now,
        username: 'me'
      },
      changes
    });

    chrome.runtime.sendMessage({
      type: 'scanStatus',
      status: `完了: ${usersArray.length}人`,
      progress: 100,
      count: usersArray.length,
      done: true
    });
  } catch (e) {
    chrome.runtime.sendMessage({ type: 'scanStatus', status: `エラー: ${e.message}`, progress: -1, error: true });
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
    fullScan();
    sendResponse({ ok: true });
  } else if (msg.action === 'stopScan') {
    stopScan();
    sendResponse({ ok: true });
  } else if (msg.action === 'getStatus') {
    sendResponse({ scanning });
  }
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('X Follower Tracker (Large Scale) installed');
});

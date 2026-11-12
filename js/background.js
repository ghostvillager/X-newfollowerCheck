// Background service worker - one-click update using session cookies + GraphQL
const CURRENT_KEY = 'xft_current';
const PREV_KEY = 'xft_prev';
const CHANGES_KEY = 'xft_changes';

chrome.runtime.onInstalled.addListener(() => {
  console.log('X Follower Tracker v1.2 installed');
});

// ---------- Cookie / CSRF helpers ----------
async function getCookie(name) {
  try {
    const c = await chrome.cookies.get({ url: 'https://x.com', name });
    return c ? c.value : null;
  } catch {
    return null;
  }
}

async function getCsrf() {
  return (await getCookie('ct0')) || '';
}

async function getAuthToken() {
  return (await getCookie('auth_token')) || '';
}

// ---------- Resolve own username / userId ----------
async function resolveOwnAccount() {
  const csrf = await getCsrf();
  if (!csrf) throw new Error('Xにログインしていません。x.com にログインしてから再試行してください。');

  // Try settings/account or home timeline bootstrap
  const headers = {
    'authorization': 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
    'x-csrf-token': csrf,
    'x-twitter-auth-type': 'OAuth2Session',
    'x-twitter-active-user': 'yes',
    'x-twitter-client-language': 'en',
    'content-type': 'application/json',
  };

  // Method 1: Account settings endpoint
  try {
    const r = await fetch('https://api.x.com/1.1/account/settings.json', {
      method: 'GET',
      headers,
      credentials: 'include'
    });
    if (r.ok) {
      const j = await r.json();
      if (j.screen_name) {
        // Need numeric id - fetch user by screen name
        const id = await resolveUserId(j.screen_name, headers);
        return { username: j.screen_name, userId: id };
      }
    }
  } catch (e) {}

  // Method 2: Verify credentials
  try {
    const r = await fetch('https://api.x.com/1.1/account/verify_credentials.json', {
      method: 'GET',
      headers,
      credentials: 'include'
    });
    if (r.ok) {
      const j = await r.json();
      if (j.screen_name && j.id_str) {
        return { username: j.screen_name, userId: j.id_str };
      }
    }
  } catch (e) {}

  throw new Error('ログイン中のアカウントを特定できませんでした。x.com を一度開いてから再試行してください。');
}

async function resolveUserId(screenName, headers) {
  // Simple GraphQL UserByScreenName (queryId may rotate - try common ones)
  const queryIds = [
    'G3KFOPve6ehykKkL3sEo-w', // common recent
    'sLVLyyYjPM-BV_j-_0OUgA',
    'xc8f1g7BYqr6V0iplNXBkA',
  ];
  for (const qid of queryIds) {
    try {
      const variables = encodeURIComponent(JSON.stringify({
        screen_name: screenName,
        withSafetyModeUserFields: true
      }));
      const features = encodeURIComponent(JSON.stringify({
        hidden_profile_subscriptions_enabled: true,
        rweb_tipjar_consumption_enabled: true,
        responsive_web_graphql_exclude_directive_enabled: true,
        verified_phone_label_enabled: false,
        subscriptions_verification_info_is_identity_verified_enabled: true,
        subscriptions_verification_info_verified_since_enabled: true,
        highlights_tweets_tab_ui_enabled: true,
        responsive_web_twitter_article_notes_tab_enabled: true,
        subscriptions_feature_can_gift_premium: true,
        creator_subscriptions_tweet_preview_api_enabled: true,
        responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
        responsive_web_graphql_timeline_navigation_enabled: true
      }));
      const url = `https://x.com/i/api/graphql/${qid}/UserByScreenName?variables=${variables}&features=${features}`;
      const r = await fetch(url, { headers: { ...headers, 'content-type': 'application/json' }, credentials: 'include' });
      if (r.ok) {
        const j = await r.json();
        const id = j?.data?.user?.result?.rest_id;
        if (id) return id;
      }
    } catch (_) {}
  }
  // Fallback: use screen name only (some endpoints accept it)
  return null;
}

// ---------- Fetch followers via GraphQL (paginated) ----------
async function fetchAllFollowers(userId, username, maxUsers = 5000) {
  const csrf = await getCsrf();
  const headers = {
    'authorization': 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
    'x-csrf-token': csrf,
    'x-twitter-auth-type': 'OAuth2Session',
    'x-twitter-active-user': 'yes',
    'x-twitter-client-language': 'en',
    'content-type': 'application/json',
  };

  // Common Followers queryIds (they rotate; try several)
  const queryIds = [
    'PD9nX-YnYrHFQxHcCjZQ_w',
    '3vlcZvqHkMhS4OjxrHTGpw',
    'iMxZDzpqC2FGWt99BPQ1Bw',
    'yl69cW2YebFpI5fPVAkj9w',
  ];

  let queryId = queryIds[0];
  const allUsers = new Map();
  let cursor = null;
  let pages = 0;
  const maxPages = 80;

  while (pages < maxPages && allUsers.size < maxUsers) {
    const variables = {
      userId: userId,
      count: 100,
      includePromotedContent: false,
    };
    if (cursor) variables.cursor = cursor;

    const features = {
      rweb_tipjar_consumption_enabled: true,
      responsive_web_graphql_exclude_directive_enabled: true,
      verified_phone_label_enabled: false,
      creator_subscriptions_tweet_preview_api_enabled: true,
      responsive_web_graphql_timeline_navigation_enabled: true,
      responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
      communities_web_enable_tweet_community_results_fetch: true,
      c9s_tweet_anatomy_moderator_badge_enabled: true,
      articles_preview_enabled: true,
      responsive_web_edit_tweet_api_enabled: true,
      graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
      view_counts_everywhere_api_enabled: true,
      longform_notetweets_consumption_enabled: true,
      responsive_web_twitter_article_tweet_consumption_enabled: true,
      tweet_awards_web_tipping_enabled: false,
      creator_subscriptions_quote_tweet_preview_enabled: false,
      freedom_of_speech_not_reach_fetch_enabled: true,
      standardized_nudges_misinfo: true,
      tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
      rweb_video_timestamps_enabled: true,
      longform_notetweets_rich_text_read_enabled: true,
      longform_notetweets_inline_media_enabled: true,
      responsive_web_enhance_cards_enabled: false
    };

    let success = false;
    let data = null;

    for (const qid of (pages === 0 ? queryIds : [queryId])) {
      try {
        const url = `https://x.com/i/api/graphql/${qid}/Followers?variables=${encodeURIComponent(JSON.stringify(variables))}&features=${encodeURIComponent(JSON.stringify(features))}`;
        const r = await fetch(url, { headers, credentials: 'include' });
        if (r.status === 404 || r.status === 400) continue;
        if (!r.ok) {
          if (r.status === 429) throw new Error('レート制限に達しました。しばらく待ってから再試行してください。');
          continue;
        }
        data = await r.json();
        queryId = qid;
        success = true;
        break;
      } catch (e) {
        if (e.message.includes('レート')) throw e;
      }
    }

    if (!success || !data) {
      if (allUsers.size > 0) break; // partial is ok
      throw new Error('フォロワー一覧の取得に失敗しました。Xの仕様変更の可能性があります。フォロワーページを開いて「表示分だけ」で更新してください。');
    }

    // Parse timeline instructions
    const instructions = data?.data?.user?.result?.timeline?.timeline?.instructions
      || data?.data?.user?.result?.timeline_v2?.timeline?.instructions
      || [];

    let nextCursor = null;
    for (const inst of instructions) {
      if (inst.type === 'TimelineAddEntries' || inst.entries) {
        const entries = inst.entries || [];
        for (const entry of entries) {
          const content = entry.content;
          if (content?.entryType === 'TimelineTimelineCursor' && content.cursorType === 'Bottom') {
            nextCursor = content.value;
          }
          const userResult = content?.itemContent?.user_results?.result
            || content?.itemContent?.user_results?.result?.result;
          if (userResult && (userResult.__typename === 'User' || userResult.legacy)) {
            const legacy = userResult.legacy || {};
            const screen = legacy.screen_name || userResult.screen_name;
            if (screen) {
              allUsers.set(screen.toLowerCase(), {
                username: screen,
                displayName: legacy.name || screen,
                bio: (legacy.description || '').slice(0, 200),
                avatar: legacy.profile_image_url_https || '',
                profileUrl: 'https://x.com/' + screen,
                followersCount: legacy.followers_count,
                followingCount: legacy.friends_count,
                followsYou: !!(legacy.followed_by),
                scrapedAt: Date.now()
              });
            }
          }
        }
      }
    }

    pages++;
    if (!nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;

    // polite delay
    await new Promise(r => setTimeout(r, 400 + Math.random() * 300));
  }

  return Array.from(allUsers.values());
}

// ---------- Commit snapshot + diff ----------
async function commitSnapshot(users, username) {
  const data = await chrome.storage.local.get([CURRENT_KEY, CHANGES_KEY]);
  const prev = data[CURRENT_KEY] || null;
  const changes = data[CHANGES_KEY] || { new: [], lost: [] };

  const snapshot = {
    username,
    users,
    count: users.length,
    timestamp: Date.now()
  };

  if (prev && prev.users && prev.users.length > 0) {
    const oldMap = new Map(prev.users.map(u => [u.username.toLowerCase(), u]));
    const newMap = new Map(users.map(u => [u.username.toLowerCase(), u]));
    const now = Date.now();
    for (const [k, u] of newMap) {
      if (!oldMap.has(k)) changes.new.unshift({ user: u, date: now });
    }
    for (const [k, u] of oldMap) {
      if (!newMap.has(k)) changes.lost.unshift({ user: u, date: now });
    }
    if (changes.new.length > 400) changes.new.length = 400;
    if (changes.lost.length > 400) changes.lost.length = 400;
  }

  await chrome.storage.local.set({
    [PREV_KEY]: prev,
    [CURRENT_KEY]: snapshot,
    [CHANGES_KEY]: changes
  });

  return {
    count: users.length,
    newCount: changes.new.length,
    lostCount: changes.lost.length,
    addedThisTime: prev ? users.filter(u => !prev.users.some(p => p.username.toLowerCase() === u.username.toLowerCase())).length : 0,
    removedThisTime: prev ? prev.users.filter(p => !users.some(u => u.username.toLowerCase() === p.username.toLowerCase())).length : 0
  };
}

// ---------- Message handler ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'oneClickUpdate') {
    (async () => {
      try {
        const account = await resolveOwnAccount();
        if (!account.userId) {
          // try to get id another way - open a tab approach fallback is handled in popup
          sendResponse({ ok: false, error: 'ユーザーIDの取得に失敗。フォロワーページを開いて「表示分だけ」を使ってください。', needPage: true });
          return;
        }
        const users = await fetchAllFollowers(account.userId, account.username, msg.maxUsers || 3000);
        if (users.length === 0) {
          sendResponse({ ok: false, error: 'フォロワーを0件取得しました。権限または仕様変更の可能性があります。' });
          return;
        }
        const result = await commitSnapshot(users, account.username);
        sendResponse({ ok: true, ...result, username: account.username });
      } catch (e) {
        sendResponse({ ok: false, error: e.message || String(e), needPage: true });
      }
    })();
    return true; // async
  }

  if (msg.action === 'passiveUsers') {
    return false;
  }

  return false;
});

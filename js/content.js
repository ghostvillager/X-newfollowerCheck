// Content script - passive capture + on-demand scan
(function () {
  'use strict';

  // ---------- GraphQL interceptor (passive) ----------
  function injectInterceptor() {
    const script = document.createElement('script');
    script.textContent = `
      (function() {
        const originalFetch = window.fetch;
        window.fetch = async function(...args) {
          const response = await originalFetch.apply(this, args);
          try {
            const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
            if (url.includes('/graphql/') && (url.includes('Followers') || url.includes('Following') || url.includes('BlueVerifiedFollowers'))) {
              const clone = response.clone();
              clone.json().then(data => {
                window.dispatchEvent(new CustomEvent('XFT_GRAPHQL', {
                  detail: { url, data, ts: Date.now() }
                }));
              }).catch(() => {});
            }
          } catch (e) {}
          return response;
        };
      })();
    `;
    (document.head || document.documentElement).appendChild(script);
    script.remove();
  }

  if (document.documentElement) {
    injectInterceptor();
  } else {
    document.addEventListener('DOMContentLoaded', injectInterceptor, { once: true });
  }

  window.addEventListener('XFT_GRAPHQL', (e) => {
    try {
      const { data } = e.detail || {};
      const users = extractUsersFromGraphQL(data);
      if (users.length > 0) {
        chrome.runtime.sendMessage({
          action: 'passiveUsers',
          users,
          source: 'graphql',
          url: location.href
        }).catch(() => {});
      }
    } catch (_) {}
  });

  function extractUsersFromGraphQL(data) {
    const users = [];
    const seen = new Set();
    function walk(obj) {
      if (!obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) { obj.forEach(walk); return; }
      if (obj.__typename === 'User' || (obj.rest_id && obj.legacy && obj.legacy.screen_name)) {
        const legacy = obj.legacy || {};
        const screen = legacy.screen_name || obj.screen_name;
        if (screen && !seen.has(screen.toLowerCase())) {
          seen.add(screen.toLowerCase());
          users.push({
            username: screen,
            displayName: legacy.name || screen,
            bio: (legacy.description || '').slice(0, 200),
            avatar: legacy.profile_image_url_https || '',
            profileUrl: 'https://x.com/' + screen,
            followersCount: legacy.followers_count,
            followingCount: legacy.friends_count,
            followsYou: !!(obj.legacy && obj.legacy.followed_by),
            scrapedAt: Date.now()
          });
        }
      }
      if (obj.result) walk(obj.result);
      if (obj.user_results) walk(obj.user_results);
      Object.values(obj).forEach(v => { if (v && typeof v === 'object') walk(v); });
    }
    walk(data);
    return users;
  }

  // ---------- DOM extraction ----------
  function extractUsersFromDOM() {
    const cells = document.querySelectorAll('[data-testid="UserCell"]');
    const users = new Map();
    cells.forEach(cell => {
      try {
        const links = cell.querySelectorAll('a[href^="/"]');
        let username = null;
        for (const link of links) {
          const href = link.getAttribute('href') || '';
          const match = href.match(/^\/([A-Za-z0-9_]{1,15})(?:\/)?$/);
          if (match) { username = match[1]; break; }
        }
        if (!username) return;
        let displayName = username;
        const nameEl = cell.querySelector('[dir="ltr"] > span');
        if (nameEl && nameEl.textContent) displayName = nameEl.textContent.trim() || username;
        let bio = '';
        const bioEl = cell.querySelector('[data-testid="UserDescription"]');
        if (bioEl) bio = (bioEl.textContent || '').trim().slice(0, 200);
        let avatar = '';
        const img = cell.querySelector('img[src*="profile_images"]');
        if (img) avatar = img.src;
        const followsYou = !!cell.querySelector('[data-testid="userFollowIndicator"]');
        users.set(username.toLowerCase(), {
          username, displayName, bio, avatar,
          profileUrl: 'https://x.com/' + username,
          followsYou, scrapedAt: Date.now()
        });
      } catch (_) {}
    });
    return Array.from(users.values());
  }

  async function autoScrollAndCollect(options = {}) {
    const { maxScrolls = 60, scrollDelay = 850 } = options;
    const collected = new Map();
    let lastSize = 0, stable = 0, scrolls = 0;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    while (scrolls < maxScrolls && stable < 4) {
      extractUsersFromDOM().forEach(u => collected.set(u.username.toLowerCase(), u));
      if (collected.size === lastSize) stable++;
      else { stable = 0; lastSize = collected.size; }
      window.scrollBy(0, window.innerHeight * 0.85);
      scrolls++;
      await sleep(scrollDelay + Math.random() * 250);
    }
    extractUsersFromDOM().forEach(u => collected.set(u.username.toLowerCase(), u));
    return Array.from(collected.values());
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'ping') {
      sendResponse({ ok: true, url: location.href, path: location.pathname });
      return true;
    }
    if (message.action === 'extractLoaded') {
      try {
        const users = extractUsersFromDOM();
        sendResponse({ ok: true, users, count: users.length });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
      return true;
    }
    if (message.action === 'autoScan') {
      (async () => {
        try {
          const users = await autoScrollAndCollect({ maxScrolls: message.maxScrolls || 60 });
          sendResponse({ ok: true, users, count: users.length });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
      })();
      return true;
    }
    return false;
  });

  console.log('[XFT] content ready');
})();

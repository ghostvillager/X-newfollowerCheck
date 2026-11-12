// Content script - DOM only (no inline script injection → no CSP violation)
(function () {
  'use strict';

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
          if (match) {
            username = match[1];
            break;
          }
        }
        if (!username) return;

        let displayName = username;
        const nameEl = cell.querySelector('[dir="ltr"] > span');
        if (nameEl && nameEl.textContent) {
          displayName = nameEl.textContent.trim() || username;
        }

        let bio = '';
        const bioEl = cell.querySelector('[data-testid="UserDescription"]');
        if (bioEl) bio = (bioEl.textContent || '').trim().slice(0, 200);

        let avatar = '';
        const img = cell.querySelector('img[src*="profile_images"]');
        if (img) avatar = img.src;

        const followsYou = !!cell.querySelector('[data-testid="userFollowIndicator"]');

        users.set(username.toLowerCase(), {
          username,
          displayName,
          bio,
          avatar,
          profileUrl: 'https://x.com/' + username,
          followsYou,
          scrapedAt: Date.now()
        });
      } catch (_) {}
    });
    return Array.from(users.values());
  }

  async function autoScrollAndCollect(options = {}) {
    const { maxScrolls = 80, scrollDelay = 900 } = options;
    const collected = new Map();
    let lastSize = 0;
    let stable = 0;
    let scrolls = 0;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    while (scrolls < maxScrolls && stable < 5) {
      extractUsersFromDOM().forEach((u) => collected.set(u.username.toLowerCase(), u));
      if (collected.size === lastSize) stable++;
      else {
        stable = 0;
        lastSize = collected.size;
      }
      window.scrollBy(0, window.innerHeight * 0.9);
      scrolls++;
      await sleep(scrollDelay + Math.random() * 300);
    }
    extractUsersFromDOM().forEach((u) => collected.set(u.username.toLowerCase(), u));
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
          const users = await autoScrollAndCollect({ maxScrolls: message.maxScrolls || 80 });
          sendResponse({ ok: true, users, count: users.length });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
      })();
      return true;
    }
    return false;
  });
})();

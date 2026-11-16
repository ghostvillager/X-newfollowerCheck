// X Follower Tracker Native Host
// 拡張機能フォルダ内の json/ に読み書きする

const fs = require('fs');
const path = require('path');

const logPath = path.join(__dirname, 'native-log.txt');
// native-host/ の親 = 拡張機能ルート、その中の json/
const jsonDir = path.resolve(__dirname, '..', 'json');

function log(msg) {
  const line = new Date().toISOString() + ' ' + msg + '\n';
  try { fs.appendFileSync(logPath, line); } catch (e) {}
}

function sendMessage(msg) {
  try {
    const json = JSON.stringify(msg);
    const buffer = Buffer.from(json, 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(buffer.length, 0);
    process.stdout.write(header);
    process.stdout.write(buffer);
    log('sent: ' + json.slice(0, 200));
  } catch (e) {
    log('sendMessage error: ' + e.message);
  }
}

function ensureJsonDir() {
  if (!fs.existsSync(jsonDir)) {
    fs.mkdirSync(jsonDir, { recursive: true });
  }
}

function safeName(name) {
  // パストラバーサル防止（日本語は許可）
  let n = path.basename(String(name || ''));
  n = n.replace(/[<>:"|?*\x00-\x1f]/g, '_');
  n = n.replace(/\s+/g, ' ').trim();
  if (!n) n = 'unnamed.json';
  return n;
}

function handleMessage(msg) {
  const action = msg.action;
  log('action: ' + action);

  try {
    ensureJsonDir();

    if (action === 'ping') {
      sendMessage({ ok: true, jsonDir, cwd: process.cwd() });
      return;
    }

    if (action === 'write') {
      const filename = safeName(msg.filename);
      if (!filename.toLowerCase().endsWith('.json')) {
        sendMessage({ ok: false, error: 'filename must end with .json' });
        return;
      }
      const data = msg.data;
      if (data === undefined || data === null) {
        sendMessage({ ok: false, error: 'data is required' });
        return;
      }
      const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
      const filePath = path.join(jsonDir, filename);
      fs.writeFileSync(filePath, text, 'utf8');
      sendMessage({ ok: true, path: filePath, filename });
      return;
    }

    if (action === 'read') {
      const filename = safeName(msg.filename);
      const filePath = path.join(jsonDir, filename);
      if (!fs.existsSync(filePath)) {
        sendMessage({ ok: false, error: 'file not found: ' + filename });
        return;
      }
      const text = fs.readFileSync(filePath, 'utf8');
      let data;
      try { data = JSON.parse(text); } catch {
        sendMessage({ ok: false, error: 'invalid JSON in file' });
        return;
      }
      sendMessage({ ok: true, filename, data, path: filePath });
      return;
    }

    if (action === 'list') {
      const files = fs.readdirSync(jsonDir)
        .filter(f => f.toLowerCase().endsWith('.json'))
        .map(f => {
          const st = fs.statSync(path.join(jsonDir, f));
          return {
            name: f,
            lastModified: st.mtimeMs,
            size: st.size
          };
        })
        .sort((a, b) => b.lastModified - a.lastModified);
      sendMessage({ ok: true, files, jsonDir });
      return;
    }

    if (action === 'readLatest') {
      // prefix: string または string[]（表示名・内部キーなど）
      let prefixes = msg.prefixes || msg.prefix || [];
      if (typeof prefixes === 'string') prefixes = prefixes ? [prefixes] : [];
      prefixes = prefixes.map(p => String(p || '').trim()).filter(Boolean);

      let files = fs.readdirSync(jsonDir)
        .filter(f => f.toLowerCase().endsWith('.json'))
        .filter(f => f !== 'setup_test.json')
        .map(f => {
          const st = fs.statSync(path.join(jsonDir, f));
          return { name: f, lastModified: st.mtimeMs, size: st.size };
        })
        .sort((a, b) => b.lastModified - a.lastModified);

      if (prefixes.length) {
        const matched = files.filter(f => {
          const lower = f.name.toLowerCase();
          return prefixes.some(p => {
            const pl = p.toLowerCase();
            return lower.startsWith(pl + '_') || lower.startsWith(pl) || lower.includes('_' + pl + '_');
          });
        });
        if (matched.length) files = matched;
      }

      if (!files.length) {
        sendMessage({ ok: false, error: 'no json files found', jsonDir });
        return;
      }

      const latest = files[0];
      const filePath = path.join(jsonDir, latest.name);
      const text = fs.readFileSync(filePath, 'utf8');
      let data;
      try { data = JSON.parse(text); } catch {
        sendMessage({ ok: false, error: 'invalid JSON in latest file: ' + latest.name });
        return;
      }
      sendMessage({
        ok: true,
        filename: latest.name,
        data,
        path: filePath,
        lastModified: latest.lastModified
      });
      return;
    }

    sendMessage({ ok: false, error: 'unknown action: ' + action });
  } catch (e) {
    log('handle error: ' + e.message);
    sendMessage({ ok: false, error: e.message });
  }
}

log('===== native-host.js started =====');
log('jsonDir: ' + jsonDir);

let inputBuffer = Buffer.alloc(0);

process.stdin.on('data', (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  while (inputBuffer.length >= 4) {
    const msgLength = inputBuffer.readUInt32LE(0);
    if (inputBuffer.length < 4 + msgLength) break;
    const msgBody = inputBuffer.slice(4, 4 + msgLength).toString('utf8');
    inputBuffer = inputBuffer.slice(4 + msgLength);
    try {
      handleMessage(JSON.parse(msgBody));
    } catch (e) {
      sendMessage({ ok: false, error: e.message });
    }
  }
});

process.stdin.on('end', () => log('stdin end'));
process.stdin.resume();

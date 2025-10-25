// lanclip.js
// Usage:
//   Server:  LANCLIP_SECRET=yourSecret node lanclip.js server 0.0.0.0 8765
//   Client:  LANCLIP_SECRET=yourSecret node lanclip.js client ws://<server_ip>:8765

import crypto from 'node:crypto';
import os from 'node:os';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket, { WebSocketServer } from 'ws';
import clipboard from 'clipboardy';

const SECRET = process.env.LANCLIP_SECRET || '';
if (!SECRET) {
  console.error(
    'ERROR: Please set LANCLIP_SECRET env var on both server and clients.'
  );
  process.exit(1);
}

const MODE = process.argv[2]; // 'server' | 'client'
if (!MODE || !['server', 'client'].includes(MODE)) {
  console.error(
    'Usage:\n  node lanclip.js server <host> <port>\n  node lanclip.js client <ws_url>'
  );
  process.exit(1);
}

const HOSTNAME = os.hostname();

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function sign(payload) {
  const hmac = crypto.createHmac('sha256', SECRET);
  hmac.update(payload);
  return hmac.digest('hex');
}

function now() {
  return new Date().toISOString();
}

async function readClipboardTextSafe() {
  try {
    return (await clipboard.read()).toString();
  } catch {
    return '';
  }
}

async function writeClipboardTextSafe(text) {
  try {
    await clipboard.write(text);
    return true;
  } catch {
    return false;
  }
}

/** Common message shape:
 * { type: 'hello'|'clip', ts, host, text?, hash, sig }
 */

if (MODE === 'server') {
  const host = process.argv[3] || '0.0.0.0';
  const port = Number(process.argv[4] || '8765');
  const wss = new WebSocketServer({ host, port });
  const clients = new Set();

  function verifySig(msg) {
    const cloned = { ...msg };
    const sig = cloned.sig;
    delete cloned.sig;
    const payload = JSON.stringify(cloned);
    return sig && sig === sign(payload);
  }

  wss.on('connection', (ws) => {
    clients.add(ws);

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!verifySig(msg)) return; // drop invalid

      if (msg.type === 'hello') {
        // could track client meta if needed
        return;
      }
      if (msg.type === 'clip') {
        // broadcast to others
        for (const c of clients) {
          if (c !== ws && c.readyState === WebSocket.OPEN) {
            c.send(raw);
          }
        }
      }
    });

    ws.on('close', () => clients.delete(ws));
  });

  wss.on('listening', () => {
    console.log(`[LANCLIP] Server listening on ws://${host}:${port}`);
  });
}

if (MODE === 'client') {
  const url = process.argv[3];
  if (!url) {
    console.error('Usage: node lanclip.js client ws://<server_ip>:8765');
    process.exit(1);
  }

  let ws;
  let lastAppliedHash = ''; // last text we applied to clipboard (to avoid loops)
  let lastLocalHash = ''; // last local clipboard we sent
  const POLL_MS = 300; // poll clipboard periodically;可改成原生系统事件监听

  function signAndStringify(obj) {
    const payload = { ...obj };
    payload.sig = sign(JSON.stringify(obj));
    return JSON.stringify(payload);
  }

  function connect() {
    ws = new WebSocket(url);

    ws.on('open', () => {
      console.log(`[LANCLIP] Connected to ${url}`);
      ws.send(signAndStringify({ type: 'hello', ts: now(), host: HOSTNAME }));
    });

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      // verify
      const sigOk = (function () {
        const cloned = { ...msg };
        const sig = cloned.sig;
        delete cloned.sig;
        return sig && sig === sign(JSON.stringify(cloned));
      })();
      if (!sigOk) return;

      if (msg.type === 'clip') {
        // ignore our own echo by hash
        if (msg.hash === lastLocalHash) return;

        // apply to clipboard if different
        const ok = await writeClipboardTextSafe(msg.text);
        if (ok) {
          lastAppliedHash = msg.hash;
          // console.log(`[LANCLIP] Applied clipboard from ${msg.host} (${msg.text.length} chars)`);
        }
      }
    });

    ws.on('close', async () => {
      console.log('[LANCLIP] Disconnected. Reconnecting soon...');
      await delay(1000);
      connect();
    });

    ws.on('error', () => {
      /* handled by close */
    });
  }

  connect();

  // Poll local clipboard; when changed and not a loopback, send to server
  (async function watchClipboardLoop() {
    while (true) {
      try {
        const text = await readClipboardTextSafe();
        const h = sha256(text || '');
        if (
          text &&
          h !== lastLocalHash &&
          h !== lastAppliedHash &&
          ws?.readyState === WebSocket.OPEN
        ) {
          lastLocalHash = h;
          const msg = {
            type: 'clip',
            ts: now(),
            host: HOSTNAME,
            text,
            hash: h,
          };
          ws.send(signAndStringify(msg));
          // console.log(`[LANCLIP] Sent ${text.length} chars`);
        }
      } catch {}
      await delay(POLL_MS);
    }
  })();
}

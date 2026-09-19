// server.js
// Minimal secure messenger backend.
// Storage: simple JSON file (db.json). Fine for demo/small scale.
// NOTE for Render: free-tier instances have EPHEMERAL disk — db.json
// will be wiped on redeploy/restart unless you attach a persistent disk
// (Render dashboard -> your service -> Disks) or move to a real DB later.

const express = require('express');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const DB_PATH = path.join(__dirname, 'db.json');
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

// ---------- Storage ----------

function loadDb() {
  if (!fs.existsSync(DB_PATH)) {
    const fresh = { users: {}, conversations: {} };
    fs.writeFileSync(DB_PATH, JSON.stringify(fresh, null, 2));
    return fresh;
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

let db = loadDb();
let saveTimer = null;
function saveDb() {
  // Debounce writes so rapid chat messages don't hammer the disk.
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  }, 200);
}

function convId(a, b) {
  return [a, b].sort().join('__');
}

// ---------- Password/PIN hashing ----------

function hashSecret(secret, salt) {
  return crypto.scryptSync(secret, salt, 64).toString('hex');
}

function constantTimeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// ---------- WebSocket connection registry ----------

const liveSockets = new Map(); // nickname -> ws

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const nickname = url.searchParams.get('nickname');
  if (!nickname || !db.users[nickname]) {
    ws.close();
    return;
  }
  liveSockets.set(nickname, ws);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    handleWsMessage(nickname, msg);
  });

  ws.on('close', () => {
    if (liveSockets.get(nickname) === ws) liveSockets.delete(nickname);
  });
});

function sendTo(nickname, payload) {
  const ws = liveSockets.get(nickname);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
    return true;
  }
  return false;
}

function handleWsMessage(fromNick, msg) {
  const user = db.users[fromNick];
  if (!user) return;

  if (msg.type === 'chat') {
    const { to, text } = msg;
    if (!to || !text || !db.users[to]) return;

    // Incoming-lock: if recipient has locked incoming messages from
    // strangers and sender is not already an existing contact, drop it.
    const recipient = db.users[to];
    const alreadyContact = recipient.contacts.includes(fromNick);
    if (recipient.incomingLocked && !alreadyContact) {
      sendTo(fromNick, { type: 'error', error: 'Этот пользователь недоступен для новых сообщений.' });
      return;
    }

    const id = convId(fromNick, to);
    if (!db.conversations[id]) db.conversations[id] = { participants: [fromNick, to], messages: [] };
    const message = { from: fromNick, text, ts: Date.now() };
    db.conversations[id].messages.push(message);

    if (!user.contacts.includes(to)) user.contacts.push(to);
    if (!recipient.contacts.includes(fromNick)) recipient.contacts.push(fromNick);
    saveDb();

    sendTo(to, { type: 'chat', from: fromNick, text, ts: message.ts });
    sendTo(fromNick, { type: 'chat_ack', to, text, ts: message.ts });
  }

  if (msg.type === 'sos_location') {
    // Forward this user's live location to their configured SOS contacts.
    const { lat, lng } = msg;
    for (const contact of user.sosContacts || []) {
      sendTo(contact, { type: 'sos_location', from: fromNick, lat, lng, ts: Date.now() });
    }
  }
}

// ---------- REST: registration ----------

app.post('/api/register', (req, res) => {
  const { nickname } = req.body || {};
  if (!nickname || typeof nickname !== 'string' || !nickname.trim()) {
    return res.status(400).json({ error: 'Введите никнейм.' });
  }
  const clean = nickname.trim();

  // Nickname is permanently reserved once taken — even if the user's
  // data is later wiped, the nickname slot is never freed.
  if (db.users[clean] || (db.reservedNicknames && db.reservedNicknames[clean])) {
    return res.status(409).json({ error: 'Этот никнейм уже существует, введите другой.' });
  }

  db.users[clean] = {
    nickname: clean,
    normalPinHash: null,
    duressPinHash: null,
    pinSalt: null,
    contacts: [],
    sosContacts: [],
    wipeNoticeContacts: [],
    incomingLocked: false,
    autoLockSeconds: 30,
    createdAt: Date.now(),
  };
  if (!db.reservedNicknames) db.reservedNicknames = {};
  db.reservedNicknames[clean] = true;
  saveDb();

  res.json({ ok: true, nickname: clean });
});

app.get('/api/search', (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (!q) return res.json({ results: [] });
  const results = Object.keys(db.users)
    .filter((n) => n.toLowerCase().includes(q.toLowerCase()))
    .slice(0, 20);
  res.json({ results });
});

app.get('/api/conversations/:nickname', (req, res) => {
  const { nickname } = req.params;
  if (!db.users[nickname]) return res.status(404).json({ error: 'not found' });
  const list = (db.users[nickname].contacts || []).map((c) => {
    const id = convId(nickname, c);
    const conv = db.conversations[id];
    const last = conv && conv.messages.length ? conv.messages[conv.messages.length - 1] : null;
    return { nickname: c, lastMessage: last };
  });
  res.json({ conversations: list });
});

app.get('/api/messages/:a/:b', (req, res) => {
  const { a, b } = req.params;
  const id = convId(a, b);
  const conv = db.conversations[id];
  res.json({ messages: conv ? conv.messages : [] });
});

// ---------- REST: PIN setup & check ----------

app.post('/api/pin/setup', (req, res) => {
  const { nickname, normalPin, duressPin } = req.body || {};
  const user = db.users[nickname];
  if (!user) return res.status(404).json({ error: 'Пользователь не найден.' });
  if (!normalPin || !duressPin || normalPin === duressPin) {
    return res.status(400).json({ error: 'PIN-коды должны быть заданы и различаться.' });
  }
  const salt = crypto.randomBytes(16).toString('hex');
  user.pinSalt = salt;
  user.normalPinHash = hashSecret(normalPin, salt);
  user.duressPinHash = hashSecret(duressPin, salt);
  saveDb();
  res.json({ ok: true });
});

app.post('/api/pin/check', (req, res) => {
  const { nickname, pin } = req.body || {};
  const user = db.users[nickname];
  if (!user || !user.pinSalt) return res.status(400).json({ result: 'invalid' });

  const enteredHash = hashSecret(pin || '', user.pinSalt);
  const isNormal = constantTimeEqual(enteredHash, user.normalPinHash);
  const isDuress = constantTimeEqual(enteredHash, user.duressPinHash);

  // Both branches computed above regardless of order, so timing
  // doesn't reveal which one matched.
  if (isDuress) return res.json({ result: 'duress' });
  if (isNormal) return res.json({ result: 'normal' });
  res.json({ result: 'invalid' });
});

// ---------- REST: emergency wipe ----------

app.post('/api/wipe', (req, res) => {
  const { nickname } = req.body || {};
  const user = db.users[nickname];
  if (!user) return res.status(404).json({ error: 'not found' });

  // 1. Delete server-side conversations involving this user.
  for (const id of Object.keys(db.conversations)) {
    if (db.conversations[id].participants.includes(nickname)) {
      delete db.conversations[id];
    }
  }

  // 2. Lock incoming messages from anyone who isn't already a contact
  //    the user messages first going forward. Existing contact list is
  //    cleared too, so nobody currently "gets through" automatically.
  const wipeNoticeContacts = user.wipeNoticeContacts || [];
  user.contacts = [];
  user.incomingLocked = true;

  saveDb();

  // 3. Notify the separate "wipe notice" list, independent of the
  //    (now-empty) conversation data.
  for (const contact of wipeNoticeContacts) {
    sendTo(contact, {
      type: 'wipe_notice',
      about: nickname,
      text: `Аккаунт "${nickname}" активировал аварийную очистку. История переписки была удалена.`,
    });
  }

  // Note: SOS is NOT touched here. If a session is active client-side,
  // it keeps running independently — see the frontend SOS module.
  res.json({ ok: true });
});

app.post('/api/settings', (req, res) => {
  const { nickname, sosContacts, wipeNoticeContacts, autoLockSeconds } = req.body || {};
  const user = db.users[nickname];
  if (!user) return res.status(404).json({ error: 'not found' });
  if (Array.isArray(sosContacts)) user.sosContacts = sosContacts;
  if (Array.isArray(wipeNoticeContacts)) user.wipeNoticeContacts = wipeNoticeContacts;
  if (typeof autoLockSeconds === 'number' || autoLockSeconds === null) user.autoLockSeconds = autoLockSeconds;
  saveDb();
  res.json({ ok: true });
});

app.post('/api/sos/trigger', (req, res) => {
  const { nickname } = req.body || {};
  const user = db.users[nickname];
  if (!user) return res.status(404).json({ error: 'not found' });
  for (const contact of user.sosContacts || []) {
    sendTo(contact, { type: 'sos_alert', from: nickname, text: 'Возможно, я в беде.' });
  }
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Messenger server running on port ${PORT}`));

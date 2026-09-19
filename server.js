// server.js
// Minimal secure messenger backend.
// Storage: simple JSON file (db.json). Fine for demo/small scale.
// NOTE for Render: free-tier instances have EPHEMERAL disk — db.json
// AND uploaded files will be wiped on redeploy/restart unless you
// attach a Persistent Disk (Render dashboard -> service -> Disks).

const express = require('express');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const multer = require('multer');

const DB_PATH = path.join(__dirname, 'db.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const safe = Date.now() + '_' + Math.random().toString(36).slice(2) + path.extname(file.originalname);
      cb(null, safe);
    }
  }),
  limits: { fileSize: 15 * 1024 * 1024 } // 15MB
});

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

// ---------- Storage ----------

function loadDb() {
  if (!fs.existsSync(DB_PATH)) {
    const fresh = { users: {}, conversations: {}, reservedNicknames: {}, activeSos: {} };
    fs.writeFileSync(DB_PATH, JSON.stringify(fresh, null, 2));
    return fresh;
  }
  const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  if (!data.activeSos) data.activeSos = {};
  if (!data.reservedNicknames) data.reservedNicknames = {};
  return data;
}

let db = loadDb();
let saveTimer = null;
function saveDb() {
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

  // On connect, flush any SOS alerts that arrived while this user was offline.
  const incoming = db.activeSos[nickname];
  if (incoming) {
    for (const from of Object.keys(incoming)) {
      ws.send(JSON.stringify({ type: 'sos_location', from, ...incoming[from] }));
    }
  }

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
    const { to } = msg;
    const kind = msg.kind || 'text'; // 'text' | 'location' | 'file'
    if (!to || !db.users[to]) return;

    const recipient = db.users[to];
    const alreadyContact = recipient.contacts.includes(fromNick);
    if (recipient.incomingLocked && !alreadyContact) {
      sendTo(fromNick, { type: 'error', error: 'Этот пользователь недоступен для новых сообщений.' });
      return;
    }

    const id = convId(fromNick, to);
    if (!db.conversations[id]) db.conversations[id] = { participants: [fromNick, to], messages: [] };

    const message = {
      from: fromNick, kind, ts: Date.now(),
      text: msg.text || null,
      lat: msg.lat, lng: msg.lng, label: msg.label,
      fileUrl: msg.fileUrl, fileName: msg.fileName, mime: msg.mime,
    };
    db.conversations[id].messages.push(message);

    if (!user.contacts.includes(to)) user.contacts.push(to);
    if (!recipient.contacts.includes(fromNick)) recipient.contacts.push(fromNick);
    saveDb();

    sendTo(to, { type: 'chat', ...message });
    sendTo(fromNick, { type: 'chat_ack', to, ...message });
  }

  if (msg.type === 'sos_location') {
    const { lat, lng } = msg;
    const entry = { lat, lng, ts: Date.now(), active: true };
    for (const contact of user.sosContacts || []) {
      if (!db.activeSos[contact]) db.activeSos[contact] = {};
      db.activeSos[contact][fromNick] = entry;
      sendTo(contact, { type: 'sos_location', from: fromNick, ...entry });
    }
    saveDb();
  }

  if (msg.type === 'sos_stop') {
    for (const contact of user.sosContacts || []) {
      if (db.activeSos[contact]) {
        delete db.activeSos[contact][fromNick];
      }
      sendTo(contact, { type: 'sos_stopped', from: fromNick });
    }
    saveDb();
  }
}

// ---------- REST: registration ----------

app.post('/api/register', (req, res) => {
  const { nickname } = req.body || {};
  if (!nickname || typeof nickname !== 'string' || !nickname.trim()) {
    return res.status(400).json({ error: 'Введите никнейм.' });
  }
  const clean = nickname.trim();

  if (db.users[clean] || db.reservedNicknames[clean]) {
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

// ---------- REST: file upload ----------

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  res.json({
    url: `/uploads/${req.file.filename}`,
    fileName: req.file.originalname,
    mime: req.file.mimetype,
  });
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

  if (isDuress) return res.json({ result: 'duress' });
  if (isNormal) return res.json({ result: 'normal' });
  res.json({ result: 'invalid' });
});

// ---------- REST: emergency wipe ----------

app.post('/api/wipe', (req, res) => {
  const { nickname } = req.body || {};
  const user = db.users[nickname];
  if (!user) return res.status(404).json({ error: 'not found' });

  for (const id of Object.keys(db.conversations)) {
    if (db.conversations[id].participants.includes(nickname)) {
      delete db.conversations[id];
    }
  }

  const wipeNoticeContacts = user.wipeNoticeContacts || [];
  user.contacts = [];
  user.incomingLocked = true;

  saveDb();

  for (const contact of wipeNoticeContacts) {
    sendTo(contact, {
      type: 'wipe_notice',
      about: nickname,
      text: `Аккаунт "${nickname}" активировал аварийную очистку. История переписки была удалена.`,
    });
  }

  // SOS state is untouched here on purpose — see db.activeSos / client watch.
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

app.get('/api/settings/:nickname', (req, res) => {
  const user = db.users[req.params.nickname];
  if (!user) return res.status(404).json({ error: 'not found' });
  res.json({
    sosContacts: user.sosContacts || [],
    wipeNoticeContacts: user.wipeNoticeContacts || [],
    autoLockSeconds: user.autoLockSeconds,
    hasPin: !!user.pinSalt,
  });
});

app.post('/api/sos/trigger', (req, res) => {
  const { nickname } = req.body || {};
  const user = db.users[nickname];
  if (!user) return res.status(404).json({ error: 'not found' });
  if (!user.sosContacts || !user.sosContacts.length) {
    return res.status(400).json({ error: 'Сначала добавь доверенные контакты в настройках.' });
  }
  const unknown = user.sosContacts.filter(c => !db.users[c]);
  for (const contact of user.sosContacts) {
    sendTo(contact, { type: 'sos_alert', from: nickname, text: 'Возможно, я в беде.' });
  }
  res.json({ ok: true, warning: unknown.length ? `Никнейм(ы) не найдены: ${unknown.join(', ')}` : null });
});

// Fallback for a recipient who wasn't connected via websocket when SOS fired.
app.get('/api/sos/incoming/:nickname', (req, res) => {
  const entries = db.activeSos[req.params.nickname] || {};
  const list = Object.keys(entries).map(from => ({ from, ...entries[from] }));
  res.json({ alerts: list });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Messenger server running on port ${PORT}`));

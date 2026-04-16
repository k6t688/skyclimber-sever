const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const wss = new WebSocket.Server({ port: 8080 });
const rooms = new Map();

// ─── 영속 계층 (db.json) ──────────────────────────────
const DB_PATH = path.join(__dirname, 'db.json');
let DB = { users: {}, sessions: {} };
try {
  if (fs.existsSync(DB_PATH)) {
    DB = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    if (!DB.users) DB.users = {};
    if (!DB.sessions) DB.sessions = {};
  } else {
    fs.writeFileSync(DB_PATH, JSON.stringify(DB));
  }
} catch (e) {
  console.error('DB load error:', e);
  DB = { users: {}, sessions: {} };
}

let saveTimer = null;
function saveDB() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      DB.sessions = Object.fromEntries(sessions);
      fs.writeFileSync(DB_PATH + '.tmp', JSON.stringify(DB));
      fs.renameSync(DB_PATH + '.tmp', DB_PATH);
    } catch (e) { console.error('DB save error:', e); }
  }, 300);
}

// ─── 인증 유틸 ────────────────────────────────────────
const USER_RE = /^[a-zA-Z0-9_가-힣]{2,16}$/;
function validUser(u) { return typeof u === 'string' && USER_RE.test(u); }
function validPw(p)   { return typeof p === 'string' && p.length >= 4 && p.length <= 64; }
function newSalt()    { return crypto.randomBytes(16).toString('hex'); }
function hashPw(pw, salt) { return crypto.scryptSync(pw, salt, 64).toString('hex'); }
function verifyPw(pw, salt, hash) {
  const h = hashPw(pw, salt);
  const a = Buffer.from(h, 'hex'), b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function newToken() { return crypto.randomBytes(24).toString('hex'); }

const sessions = new Map(); // token -> username
// db.json의 sessions 복원 (재시작 후에도 로그인 토큰 유지)
for (const [t, u] of Object.entries(DB.sessions || {})) sessions.set(t, u);

function userUnlocks(u) {
  return {
    charsUnlocked: u.charsUnlocked || ['human'],
    skinsUnlocked: u.skinsUnlocked || [],
    stagesCleared: u.stagesCleared || []
  };
}
function mergeUnlocks(target, incoming) {
  if (!incoming) return;
  const uniq = (a, b) => {
    const s = new Set(a || []);
    for (const x of (b || [])) s.add(x);
    return Array.from(s);
  };
  target.charsUnlocked = uniq(target.charsUnlocked, incoming.charsUnlocked);
  target.skinsUnlocked = uniq(target.skinsUnlocked, incoming.skinsUnlocked);
  target.stagesCleared = uniq(target.stagesCleared, incoming.stagesCleared);
}

// ─── 로그인 레이트 리밋 (IP 기준) ─────────────────────
const rlMap = new Map(); // ip -> {count, resetAt}
function rlCheck(ip) {
  const now = Date.now();
  let r = rlMap.get(ip);
  if (!r || r.resetAt < now) { r = { count: 0, resetAt: now + 1000 }; rlMap.set(ip, r); }
  r.count++;
  return r.count <= 15;
}

// ─── 관리자 토큰 로드 ─────────────────────────────────
// 우선순위: 환경변수 ADMIN_TOKEN > 파일 admin_token.txt
// 둘 다 없으면 관리자 기능 비활성화
const ADMIN_TOKEN_PATH = path.join(__dirname, 'admin_token.txt');
let ADMIN_TOKEN = process.env.ADMIN_TOKEN || null;
if (!ADMIN_TOKEN) {
  try {
    if (fs.existsSync(ADMIN_TOKEN_PATH)) {
      ADMIN_TOKEN = fs.readFileSync(ADMIN_TOKEN_PATH, 'utf8').trim() || null;
    }
  } catch (e) { /* ignore */ }
}
if (ADMIN_TOKEN) {
  console.log('[ADMIN] 관리자 기능 활성화됨');
} else {
  console.log('[ADMIN] 관리자 토큰 없음 → 관리자 기능 비활성화');
}
// 관리자 요청 레이트 리밋 (IP 기준, 실패만 카운트)
const adminRlMap = new Map();
function adminRlCheck(ip) {
  const now = Date.now();
  let r = adminRlMap.get(ip);
  if (!r || r.resetAt < now) { r = { count: 0, resetAt: now + 60000 }; adminRlMap.set(ip, r); }
  return r.count < 10;
}
function adminRlFail(ip) {
  const now = Date.now();
  let r = adminRlMap.get(ip);
  if (!r || r.resetAt < now) { r = { count: 0, resetAt: now + 60000 }; adminRlMap.set(ip, r); }
  r.count++;
}
function adminAuth(ip, token) {
  if (!ADMIN_TOKEN) return false;
  if (!adminRlCheck(ip)) return false;
  const a = Buffer.from(String(token || ''));
  const b = Buffer.from(ADMIN_TOKEN);
  if (a.length !== b.length) { adminRlFail(ip); return false; }
  const ok = crypto.timingSafeEqual(a, b);
  if (!ok) adminRlFail(ip);
  return ok;
}

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({length:4}, ()=>chars[Math.floor(Math.random()*chars.length)]).join(''); }
  while (rooms.has(code));
  return code;
}

function roomBroadcast(room, msg, excludeIdx=-1) {
  const str = JSON.stringify(msg);
  for (const p of room.players) {
    if (p && p.idx !== excludeIdx && p.ws.readyState === WebSocket.OPEN)
      p.ws.send(str);
  }
}

wss.on('connection', (ws, req) => {
  let myRoom = null;
  let myIdx = -1;
  const ip = (req && req.socket && req.socket.remoteAddress) || 'unknown';

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    // ─── 인증: 회원가입 ──────────────────────────────
    if (msg.t === 'auth_register') {
      if (!rlCheck(ip)) { ws.send(JSON.stringify({ t:'auth_err', code:'rate_limit' })); return; }
      const { user, pw } = msg;
      if (!validUser(user)) { ws.send(JSON.stringify({ t:'auth_err', code:'bad_user' })); return; }
      if (!validPw(pw))     { ws.send(JSON.stringify({ t:'auth_err', code:'bad_pw' })); return; }
      if (DB.users[user])   { ws.send(JSON.stringify({ t:'auth_err', code:'exists' })); return; }
      const salt = newSalt();
      const hash = hashPw(pw, salt);
      const now = Date.now();
      const rec = {
        salt, hash,
        charsUnlocked: ['human'],
        skinsUnlocked: [],
        stagesCleared: [],
        createdAt: now, updatedAt: now
      };
      DB.users[user] = rec;
      const token = newToken();
      sessions.set(token, user);
      saveDB();
      ws.send(JSON.stringify({ t:'auth_ok', user, token, unlocks: userUnlocks(rec) }));
      return;
    }

    // ─── 인증: 로그인 ────────────────────────────────
    else if (msg.t === 'auth_login') {
      if (!rlCheck(ip)) { ws.send(JSON.stringify({ t:'auth_err', code:'rate_limit' })); return; }
      const { user, pw } = msg;
      if (!validUser(user) || !validPw(pw)) { ws.send(JSON.stringify({ t:'auth_err', code:'invalid' })); return; }
      const rec = DB.users[user];
      if (!rec)                        { ws.send(JSON.stringify({ t:'auth_err', code:'invalid' })); return; }
      if (!verifyPw(pw, rec.salt, rec.hash)) { ws.send(JSON.stringify({ t:'auth_err', code:'invalid' })); return; }
      const token = newToken();
      sessions.set(token, user);
      saveDB();
      ws.send(JSON.stringify({ t:'auth_ok', user, token, unlocks: userUnlocks(rec) }));
      return;
    }

    // ─── 해금 동기화 (union 병합) ────────────────────
    else if (msg.t === 'save_sync') {
      const { token, unlocks } = msg;
      const user = sessions.get(token);
      if (!user || !DB.users[user]) { ws.send(JSON.stringify({ t:'save_err', code:'unauth' })); return; }
      const rec = DB.users[user];
      mergeUnlocks(rec, unlocks);
      rec.updatedAt = Date.now();
      saveDB();
      ws.send(JSON.stringify({ t:'save_ok', unlocks: userUnlocks(rec) }));
      return;
    }

    // ─── 관리자 명령 ─────────────────────────────────
    else if (msg.t && msg.t.startsWith('admin_')) {
      if (!adminAuth(ip, msg.token)) {
        ws.send(JSON.stringify({ t:'admin_err', code:'bad_token' })); return;
      }
      if (msg.t === 'admin_list') {
        const users = Object.entries(DB.users).map(([name, u]) => ({
          user: name,
          charsUnlocked: u.charsUnlocked || [],
          skinsUnlocked: u.skinsUnlocked || [],
          stagesCleared: u.stagesCleared || [],
          createdAt: u.createdAt || 0,
          updatedAt: u.updatedAt || 0
        }));
        ws.send(JSON.stringify({ t:'admin_list_ok', users }));
        return;
      }
      if (msg.t === 'admin_set') {
        const { user, unlocks } = msg;
        if (!user || !DB.users[user] || !unlocks) {
          ws.send(JSON.stringify({ t:'admin_err', code:'no_user' })); return;
        }
        const rec = DB.users[user];
        if (Array.isArray(unlocks.charsUnlocked)) rec.charsUnlocked = unlocks.charsUnlocked.slice();
        if (Array.isArray(unlocks.skinsUnlocked)) rec.skinsUnlocked = unlocks.skinsUnlocked.slice();
        if (Array.isArray(unlocks.stagesCleared)) rec.stagesCleared = unlocks.stagesCleared.map(Number).filter(n=>!isNaN(n));
        rec.updatedAt = Date.now();
        saveDB();
        ws.send(JSON.stringify({ t:'admin_ok', user, unlocks: userUnlocks(rec) }));
        return;
      }
      if (msg.t === 'admin_reset') {
        const { user } = msg;
        if (!user || !DB.users[user]) {
          ws.send(JSON.stringify({ t:'admin_err', code:'no_user' })); return;
        }
        const rec = DB.users[user];
        rec.charsUnlocked = ['human'];
        rec.skinsUnlocked = [];
        rec.stagesCleared = [];
        rec.updatedAt = Date.now();
        saveDB();
        ws.send(JSON.stringify({ t:'admin_ok', user, unlocks: userUnlocks(rec) }));
        return;
      }
      if (msg.t === 'admin_delete') {
        const { user } = msg;
        if (!user || !DB.users[user]) {
          ws.send(JSON.stringify({ t:'admin_err', code:'no_user' })); return;
        }
        delete DB.users[user];
        // 해당 유저의 세션 토큰도 제거
        for (const [t, u] of sessions.entries()) {
          if (u === user) sessions.delete(t);
        }
        saveDB();
        ws.send(JSON.stringify({ t:'admin_deleted', user }));
        return;
      }
      ws.send(JSON.stringify({ t:'admin_err', code:'unknown' }));
      return;
    }

    else if (msg.t === 'create') {
      const code = genCode();
      const room = {
        code,
        maxPlayers: Math.min(4, Math.max(2, msg.max || 2)),
        players: [{ ws, char: msg.char || 'human', skin: msg.skin || 'default', idx: 0, ready: false }],
        state: 'waiting'
      };
      rooms.set(code, room);
      myRoom = room; myIdx = 0;
      ws.send(JSON.stringify({ t:'room_ok', code, idx:0, max:room.maxPlayers,
        players:[{idx:0, char:msg.char||'human', skin:msg.skin||'default', ready:false}] }));
    }

    else if (msg.t === 'join') {
      const room = rooms.get(msg.code);
      if (!room) { ws.send(JSON.stringify({ t:'err', reason:'방을 찾을 수 없습니다' })); return; }
      if (room.state === 'playing') { ws.send(JSON.stringify({ t:'err', reason:'이미 게임 중입니다' })); return; }
      if (room.players.length >= room.maxPlayers) { ws.send(JSON.stringify({ t:'err', reason:'방이 꽉 찼습니다' })); return; }
      const idx = room.players.length;
      room.players.push({ ws, char: msg.char||'human', skin: msg.skin||'default', idx, ready: false });
      myRoom = room; myIdx = idx;
      ws.send(JSON.stringify({ t:'joined', idx, code:room.code, max:room.maxPlayers,
        players: room.players.map(p=>({idx:p.idx, char:p.char, skin:p.skin, ready:p.ready})) }));
      roomBroadcast(room, { t:'player_in', idx, char:msg.char||'human', skin:msg.skin||'default', ready:false }, idx);
    }

    else if (msg.t === 'char_update') {
      if (!myRoom) return;
      const p = myRoom.players.find(p=>p.idx===myIdx);
      if (p) { p.char = msg.char; p.skin = msg.skin; p.ready = false; }
      roomBroadcast(myRoom, { t:'char_update', idx:myIdx, char:msg.char, skin:msg.skin }, myIdx);
      // 캐릭터 변경 시 준비 해제도 함께 전송
      roomBroadcast(myRoom, { t:'ready', idx:myIdx, ready:false }, myIdx);
    }

    else if (msg.t === 'ready') {
      if (!myRoom) return;
      const p = myRoom.players.find(p=>p.idx===myIdx);
      if (p) { p.ready = !!msg.ready; }
      roomBroadcast(myRoom, { t:'ready', idx:myIdx, ready:!!msg.ready });
    }

    else if (msg.t === 'start') {
      if (!myRoom || myIdx !== 0 || myRoom.players.length < 2) return;
      const allReady = myRoom.players.every(p => p.ready);
      if (!allReady) return;
      const seed = Math.floor(Math.random() * 99999999);
      myRoom.state = 'playing';
      for (const p of myRoom.players) p.ready = false;
      roomBroadcast(myRoom, {
        t: 'game_start', seed,
        players: myRoom.players.map(p=>({idx:p.idx, char:p.char, skin:p.skin}))
      });
    }

    else if (msg.t === 'return_lobby') {
      if (!myRoom || myIdx !== 0) return;
      myRoom.state = 'waiting';
      for (const p of myRoom.players) p.ready = false;
      roomBroadcast(myRoom, {
        t: 'lobby_return',
        players: myRoom.players.map(p=>({idx:p.idx, char:p.char, skin:p.skin, ready:false}))
      });
    }

    else if (msg.t === 'in') {
      if (!myRoom || myIdx === 0) return;
      const host = myRoom.players[0];
      if (host && host.ws.readyState === WebSocket.OPEN)
        host.ws.send(JSON.stringify({ ...msg, idx: myIdx }));
    }

    else if (msg.t === 'st') {
      if (!myRoom || myIdx !== 0) return;
      roomBroadcast(myRoom, msg, 0);
    }
  });

  ws.on('close', () => {
    if (!myRoom) return;
    myRoom.players = myRoom.players.filter(p => p.idx !== myIdx);
    if (myRoom.players.length === 0) { rooms.delete(myRoom.code); return; }
    if (myIdx === 0) {
      roomBroadcast(myRoom, { t:'host_left' });
      rooms.delete(myRoom.code);
    } else {
      roomBroadcast(myRoom, { t:'player_out', idx: myIdx });
      if (myRoom.state === 'playing') myRoom.state = 'waiting';
    }
  });
});

console.log('Sky Climber WebSocket server running on :8080');

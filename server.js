const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });

// ─── 방 관리 ─────────────────────────────────
const rooms = new Map(); // roomCode → { players: [ws, ws], state, createdAt }

function genRoomCode() {
  let code;
  do {
    code = String(Math.floor(1000 + Math.random() * 9000)); // 4자리
  } while (rooms.has(code));
  return code;
}

function broadcast(room, msg, excludeWs) {
  const data = JSON.stringify(msg);
  for (const p of room.players) {
    if (p && p !== excludeWs && p.readyState === 1) {
      p.send(data);
    }
  }
}

function broadcastAll(room, msg) {
  const data = JSON.stringify(msg);
  for (const p of room.players) {
    if (p && p.readyState === 1) p.send(data);
  }
}

function cleanupRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  broadcastAll(room, { type: 'room_closed' });
  rooms.delete(code);
  console.log(`[ROOM] ${code} 삭제됨 (남은 방: ${rooms.size})`);
}

function removePlayerFromRoom(ws) {
  if (!ws._roomCode) return;
  const room = rooms.get(ws._roomCode);
  if (!room) return;

  const idx = room.players.indexOf(ws);
  if (idx !== -1) room.players[idx] = null;

  const alive = room.players.filter(p => p !== null);
  if (alive.length === 0) {
    rooms.delete(ws._roomCode);
    console.log(`[ROOM] ${ws._roomCode} 삭제됨 (빈 방)`);
  } else {
    broadcast(room, { type: 'opponent_left' });
  }
}

// ─── 30초마다 빈 방 정리 ─────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const alive = room.players.filter(p => p && p.readyState === 1);
    if (alive.length === 0 || now - room.createdAt > 30 * 60 * 1000) {
      rooms.delete(code);
      console.log(`[CLEANUP] ${code} 제거`);
    }
  }
}, 30000);

// ─── 연결 처리 ───────────────────────────────
wss.on('connection', (ws) => {
  ws._roomCode = null;
  ws._playerIdx = -1;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // ── 방 만들기 ──
      case 'create_room': {
        const code = genRoomCode();
        rooms.set(code, {
          players: [ws, null],
          state: 'waiting', // waiting → ready → playing → ended
          createdAt: Date.now(),
        });
        ws._roomCode = code;
        ws._playerIdx = 0;
        ws.send(JSON.stringify({ type: 'room_created', code }));
        console.log(`[ROOM] ${code} 생성됨`);
        break;
      }

      // ── 방 참가 ──
      case 'join_room': {
        const code = String(msg.code);
        const room = rooms.get(code);
        if (!room) {
          ws.send(JSON.stringify({ type: 'error', msg: '방을 찾을 수 없습니다' }));
          break;
        }
        if (room.players[1] !== null) {
          ws.send(JSON.stringify({ type: 'error', msg: '방이 가득 찼습니다' }));
          break;
        }
        room.players[1] = ws;
        room.state = 'ready';
        ws._roomCode = code;
        ws._playerIdx = 1;

        ws.send(JSON.stringify({ type: 'room_joined', code, playerIdx: 1 }));
        broadcastAll(room, { type: 'room_ready', players: 2 });
        console.log(`[ROOM] ${code} 2명 매칭 완료`);
        break;
      }

      // ── 핑 측정 ──
      case 'ping': {
        ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
        break;
      }

      // ── 게임 상태 전달 (상대방에게 중계) ──
      case 'game_state': {
        if (!ws._roomCode) break;
        const room = rooms.get(ws._roomCode);
        if (!room) break;
        broadcast(room, {
          type: 'opponent_state',
          state: msg.state,
          playerIdx: ws._playerIdx,
        }, ws);
        break;
      }

      // ── 게임 이벤트 (시작, 종료 등) ──
      case 'game_event': {
        if (!ws._roomCode) break;
        const room = rooms.get(ws._roomCode);
        if (!room) break;
        broadcastAll(room, {
          type: 'game_event',
          event: msg.event,
          data: msg.data,
          from: ws._playerIdx,
        });
        break;
      }

      // ── 방 나가기 ──
      case 'leave_room': {
        removePlayerFromRoom(ws);
        ws._roomCode = null;
        ws._playerIdx = -1;
        ws.send(JSON.stringify({ type: 'left_room' }));
        break;
      }
    }
  });

  ws.on('close', () => {
    removePlayerFromRoom(ws);
  });

  ws.on('error', () => {
    removePlayerFromRoom(ws);
  });
});

console.log(`Sky Climber 서버 실행 중 — 포트 ${PORT}`);
console.log(`ws://localhost:${PORT}`);

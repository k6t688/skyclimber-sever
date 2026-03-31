const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Sky Climber Server OK');
});

const wss = new WebSocketServer({ server });
const rooms = new Map();

function genRoomCode() {
  let code;
  do { code = String(Math.floor(1000 + Math.random() * 9000)); } while (rooms.has(code));
  return code;
}

function broadcast(room, msg, excludeWs) {
  const data = JSON.stringify(msg);
  for (const p of room.players) {
    if (p && p !== excludeWs && p.readyState === 1) p.send(data);
  }
}

function broadcastAll(room, msg) {
  const data = JSON.stringify(msg);
  for (const p of room.players) {
    if (p && p.readyState === 1) p.send(data);
  }
}

function removePlayerFromRoom(ws) {
  if (!ws._roomCode) return;
  const room = rooms.get(ws._roomCode);
  if (!room) return;
  const idx = room.players.indexOf(ws);
  if (idx !== -1) room.players[idx] = null;
  const alive = room.players.filter(p => p !== null);
  if (alive.length === 0) { rooms.delete(ws._roomCode); }
  else { broadcast(room, { type: 'opponent_left' }); }
}

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const alive = room.players.filter(p => p && p.readyState === 1);
    if (alive.length === 0 || now - room.createdAt > 30 * 60 * 1000) rooms.delete(code);
  }
}, 30000);

wss.on('connection', (ws) => {
  ws._roomCode = null;
  ws._playerIdx = -1;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'create_room': {
        const code = genRoomCode();
        rooms.set(code, { players: [ws, null], state: 'waiting', createdAt: Date.now() });
        ws._roomCode = code;
        ws._playerIdx = 0;
        ws.send(JSON.stringify({ type: 'room_created', code }));
        break;
      }
      case 'join_room': {
        const code = String(msg.code);
        const room = rooms.get(code);
        if (!room) { ws.send(JSON.stringify({ type: 'error', msg: '방을 찾을 수 없습니다' })); break; }
        if (room.players[1] !== null) { ws.send(JSON.stringify({ type: 'error', msg: '방이 가득 찼습니다' })); break; }
        room.players[1] = ws;
        room.state = 'ready';
        ws._roomCode = code;
        ws._playerIdx = 1;
        ws.send(JSON.stringify({ type: 'room_joined', code, playerIdx: 1 }));
        broadcastAll(room, { type: 'room_ready', players: 2 });
        break;
      }
      case 'ping': { ws.send(JSON.stringify({ type: 'pong', t: msg.t })); break; }
      case 'game_state': {
        if (!ws._roomCode) break;
        const room = rooms.get(ws._roomCode);
        if (!room) break;
        broadcast(room, { type: 'opponent_state', state: msg.state }, ws);
        break;
      }
      case 'game_event': {
        if (!ws._roomCode) break;
        const room = rooms.get(ws._roomCode);
        if (!room) break;
        broadcast(room, { type: 'game_event', event: msg.event, data: msg.data, from: ws._playerIdx }, ws);
        break;
      }
      case 'leave_room': {
        removePlayerFromRoom(ws);
        ws._roomCode = null;
        ws._playerIdx = -1;
        ws.send(JSON.stringify({ type: 'left_room' }));
        break;
      }
    }
  });

  ws.on('close', () => removePlayerFromRoom(ws));
  ws.on('error', () => removePlayerFromRoom(ws));
});

server.listen(PORT, () => {
  console.log(`Sky Climber server on port ${PORT}`);
});

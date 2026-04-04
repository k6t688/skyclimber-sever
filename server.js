const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 8080 });
const rooms = new Map();

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

wss.on('connection', ws => {
  let myRoom = null;
  let myIdx = -1;

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    if (msg.t === 'create') {
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

const http = require('http');
const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 8080;
const server = http.createServer((req, res) => { res.writeHead(200); res.end('Sky Climber Server OK'); });
const wss = new WebSocketServer({ server });
const rooms = new Map();

// ─── 상수 ────────────────────────────────────
const W = 900, H = 1200;
const CHARS = {
  human:          { jumpForce:-14, jumpCount:2, speed:5, friction:0.8, crouchTime:0, maxFlyTime:0, freezes:false },
  mochi:          { jumpForce:-18, airJumpForce:-14, jumpCount:2, speed:5, friction:0.8, crouchTime:8, maxFlyTime:0, freezes:false },
  cockroach:      { jumpForce:-10, jumpCount:1, speed:5, friction:0.8, crouchTime:0, maxFlyTime:60, freezes:false },
  ice:            { jumpForce:-14, jumpCount:2, speed:5, friction:0.93, crouchTime:0, maxFlyTime:0, freezes:true },
  rabbit:         { jumpForce:-12, jumpCount:3, speed:5, friction:0.8, crouchTime:0, maxFlyTime:0, freezes:false },
  protein_stick:  { jumpForce:-24, jumpCount:1, speed:5, friction:0.8, crouchTime:10, maxFlyTime:0, freezes:false },
};
const BTL_STATS = {
  human:         { hp:3, kb:20, stun:30, cooldown:22, atkType:'punch' },
  mochi:         { hp:3, kb:0, stun:60, cooldown:50, atkType:'grab', grabRange:200, grabSpeed:18 },
  cockroach:     { hp:4, kb:18, stun:45, cooldown:70, atkType:'bomb', bombSpeed:10, bombGravity:0.3, bombFuseTime:120, blastRadius:60 },
  ice:           { hp:3, kb:12, stun:18, cooldown:30, atkType:'shard', shardSpeed:12, shardRange:150, slowDuration:180 },
  rabbit:        { hp:3, kb:5, stun:6, cooldown:6, atkType:'rapidPunch', autoFire:true },
  protein_stick: { hp:3, kb:8, stun:30, cooldown:30, atkType:'comboPunch', comboKbGrow:3, maxComboKb:30 },
};

function btlHash(seed, idx) {
  let h = (seed * 2654435761 + idx * 2246822519) >>> 0;
  h = ((h >> 16) ^ h) * 0x45d9f3b; h = ((h >> 16) ^ h) * 0x45d9f3b; h = (h >> 16) ^ h;
  return (h & 0x7fffffff) / 0x7fffffff;
}

// ─── 방/매칭 ──────────────────────────────────
function genRoomCode() { let c; do { c = String(Math.floor(1000 + Math.random() * 9000)); } while (rooms.has(c)); return c; }

function broadcastAll(room, msg) {
  const d = JSON.stringify(msg);
  for (const p of room.players) { if (p && p.readyState === 1) p.send(d); }
}
function sendTo(ws, msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

// 빈 방 정리
setInterval(() => {
  for (const [code, room] of rooms) {
    const alive = room.players.filter(p => p && p.readyState === 1);
    if (alive.length === 0 || Date.now() - room.createdAt > 60 * 60 * 1000) {
      if (room.tickId) clearInterval(room.tickId);
      rooms.delete(code);
    }
  }
}, 15000);

// ─── 플레이어 생성 ───────────────────────────
function makePlayer(charId, x, facing) {
  const c = CHARS[charId]; const bs = BTL_STATS[charId];
  let hitJumps = 1;
  if (charId === 'rabbit') hitJumps = 2;
  if (charId === 'cockroach') hitJumps = 0;
  return {
    x, worldY: -50, vx: 0, vy: 0, w: 22, h: 32, facing,
    hp: bs.hp, maxHp: bs.hp, maxJumps: c.jumpCount, jumps: c.jumpCount,
    jumpForce: c.jumpForce, airJumpForce: c.airJumpForce || c.jumpForce,
    speed: c.speed, friction: c.friction,
    onGround: false, frame: 0, ft: 0,
    attacking: false, attackAngle: 0, attackTimer: 0, attackCooldown: 0,
    crouching: false, crouchTimer: 0, crouchTime: c.crouchTime || 0,
    flying: false, flyTimer: 0, maxFlyTime: c.maxFlyTime || 0,
    spinAngle: 0, freezes: !!c.freezes,
    stunTimer: 0, hitJumps, knocked: false,
    slowTimer: 0, comboCount: 0,
    grabArm: null, charId, bs,
    input: { left: false, right: false, jump: false, attack: false, mouseX: 0, mouseY: 0 },
    _jumpHeld: false, _attackHeld: false,
  };
}

// ─── 게임 시작 ───────────────────────────────
function startGame(room) {
  // 이전 틱 정리
  if (room.tickId) { clearInterval(room.tickId); room.tickId = null; }

  const seed = parseInt(room.code) || 1234;
  const g = {
    camY: 0, scrollSpeed: 0.8, time: 0, seed, platIdx: 0,
    height: 0, ship: null, shipSpawned: false,
    platforms: [], projectiles: [],
    p: [room.game_players[0], room.game_players[1]],
    state: 'countdown', countdown: 180, winner: -1,
  };
  g.platforms.push({ x: 0, worldY: 0, w: W, h: 20, type: 'ground', isShipPad: false });
  let wy = -60;
  while (wy > -H * 2) {
    g.platIdx++;
    const r1 = btlHash(seed, g.platIdx * 3), r2 = btlHash(seed, g.platIdx * 3 + 1), r3 = btlHash(seed, g.platIdx * 3 + 2);
    wy -= 45 + r1 * 35; const pw = 70 + r2 * 80;
    g.platforms.push({ x: r3 * (W - pw), worldY: wy, w: pw, h: 14, type: 'rock', isShipPad: false });
  }
  room.g = g;
  room.state = 'playing';
  let lastT = Date.now();
  room.tickId = setInterval(() => {
    const now = Date.now();
    const dt = Math.min((now - lastT) / 16.667, 2.5);
    lastT = now;
    tick(room, dt);
    sendState(room);
  }, 16);
}

// ─── 메인 틱 ─────────────────────────────────
function tick(room, dt) {
  const g = room.g;
  if (!g || g.state === 'ended') return;
  g.time += dt;
  if (g.state === 'countdown') { g.countdown -= dt; if (g.countdown <= 0) g.state = 'playing'; return; }

  g.scrollSpeed = Math.min(2.0, 0.8 + g.time * 0.0003);
  if (g.ship && !g.ship.launching) {
    const sc = g.ship.worldY + g.ship.h / 2 - g.camY;
    if (sc > H * 0.4) g.scrollSpeed = 0;
  }
  g.camY -= g.scrollSpeed * dt;
  g.height += g.scrollSpeed * dt * 0.27;

  // 우주선 스폰
  if (g.height >= 9800 && !g.shipSpawned) {
    g.shipSpawned = true;
    const shipWY = g.camY - H * 0.3;
    const topPlat = Math.min(...g.platforms.map(p => p.worldY));
    let stepY = topPlat;
    while (stepY > shipWY + 80) { stepY -= 55 + Math.random() * 30; const pw = 80 + Math.random() * 60; g.platforms.push({ x: Math.random() * (W - pw), worldY: stepY, w: pw, h: 14, type: 'rock', isShipPad: false }); }
    g.platforms.push({ x: W / 2 - 140, worldY: shipWY, w: 280, h: 20, type: 'star', isShipPad: true });
    g.platforms.push({ x: W / 2 - 250, worldY: shipWY + 40, w: 100, h: 14, type: 'rock', isShipPad: false });
    g.platforms.push({ x: W / 2 + 150, worldY: shipWY + 40, w: 100, h: 14, type: 'rock', isShipPad: false });
    g.ship = { x: W / 2, worldY: shipWY - 80, w: 80, h: 100, boarded: -1, boardTimer: 0, launching: false, launchVy: 0, padY: shipWY };
  }

  // 우주선 탑승
  if (g.ship && g.ship.boarded === -1 && !g.ship.launching) {
    for (let i = 0; i < 2; i++) {
      const p = g.p[i]; const s = g.ship;
      if (Math.abs(p.x + p.w / 2 - s.x) < 50 && Math.abs(p.worldY + p.h / 2 - s.worldY - s.h / 2) < 60 && p.onGround) {
        s.boarded = i; p.vx = 0; p.vy = 0; break;
      }
    }
  }
  if (g.ship && g.ship.boarded >= 0) {
    const s = g.ship; const bp = g.p[s.boarded];
    bp.x = s.x - bp.w / 2; bp.worldY = s.worldY + 20; bp.vx = 0; bp.vy = 0;
    s.boardTimer += dt;
    if (s.boardTimer >= 300 && !s.launching) { s.launching = true; s.launchVy = 0; }
    if (s.launching) {
      s.launchVy -= 0.15 * dt; s.worldY += s.launchVy * dt;
      bp.x = s.x - bp.w / 2; bp.worldY = s.worldY + 20;
      if (s.worldY - g.camY < -200) {
        g.state = 'ended'; g.winner = s.boarded;
        // 게임 종료 시 틱 중단, 방은 유지
        if (room.tickId) { clearInterval(room.tickId); room.tickId = null; }
        room.state = 'ended';
        // 마지막 상태 전송
        sendState(room);
      }
    }
  }

  // 플레이어 업데이트
  for (let i = 0; i < 2; i++) {
    if (g.ship && g.ship.boarded === i) continue;
    updatePlayer(g, g.p[i], dt);
  }

  // 공격 판정
  for (let i = 0; i < 2; i++) { checkHit(g, g.p[i], g.p[1 - i]); }

  // 낙사 체크
  for (let i = 0; i < 2; i++) {
    const p = g.p[i];
    if (p.worldY - g.camY > H + 50) {
      p.hp--;
      if (p.hp <= 0) {
        g.state = 'ended'; g.winner = 1 - i;
        if (room.tickId) { clearInterval(room.tickId); room.tickId = null; }
        room.state = 'ended';
        sendState(room);
      }
      else respawn(g, p);
    }
  }

  // 발판 생성
  if (!g.shipSpawned) {
    let topWY = Math.min(...g.platforms.map(p => p.worldY));
    while (topWY > g.camY - H * 1.5) {
      g.platIdx++;
      const r1 = btlHash(g.seed, g.platIdx * 3), r2 = btlHash(g.seed, g.platIdx * 3 + 1), r3 = btlHash(g.seed, g.platIdx * 3 + 2);
      topWY -= 45 + r1 * 35; const pw = 70 + r2 * 80;
      g.platforms.push({ x: r3 * (W - pw), worldY: topWY, w: pw, h: 14, type: 'rock', isShipPad: false });
    }
  }
  g.platforms = g.platforms.filter(p => p.isShipPad || p.worldY - g.camY < H + 200);

  updateProjectiles(g, dt);
  for (const p of g.p) { if (p.slowTimer > 0) p.slowTimer -= dt; }
}

// ─── 플레이어 물리 ───────────────────────────
function updatePlayer(g, p, dt) {
  const inp = p.input;
  const isCockroach = p.charId === 'cockroach';
  const hasCrouch = p.crouchTime > 0;
  const spdMult = p.slowTimer > 0 ? 0.5 : 1;

  if (p.stunTimer > 0) {
    p.stunTimer -= dt;
    if (isCockroach && !p.onGround) p.vy = Math.min(p.vy + 0.35 * dt, 10);
    else p.vy = Math.min(p.vy + 0.55 * dt, 18);
    p.vx *= 0.95;
    p.x += p.vx * dt; p.worldY += p.vy * dt;
    if (p.x < -p.w) p.x = W; if (p.x > W) p.x = -p.w;
    p.onGround = false;
    for (const pl of g.platforms) {
      if (p.x + p.w <= pl.x || p.x >= pl.x + pl.w) continue;
      const pBot = p.worldY + p.h;
      if (pBot >= pl.worldY && pBot - p.vy * dt <= pl.worldY + 2 && p.vy > 0) {
        p.worldY = pl.worldY - p.h; p.vy = 0; p.onGround = true;
      }
    }
    return;
  }

  if (inp.left) { if (!p.crouching) { p.vx = -p.speed * spdMult; p.facing = -1; } }
  else if (inp.right) { if (!p.crouching) { p.vx = p.speed * spdMult; p.facing = 1; } }
  else p.vx *= p.friction;

  if (hasCrouch && p.crouching) {
    p.vx *= 0.5; p.crouchTimer += dt;
    if (!p.onGround) p.crouching = false;
    else if (p.crouchTimer >= p.crouchTime) { p.crouching = false; p.vy = p.jumpForce; p.jumps--; }
  }

  if (isCockroach) {
    if (inp.jump && p.flyTimer < p.maxFlyTime) { p.vy = Math.max(p.vy - 1.0 * dt, -7); p.flyTimer += dt; p.flying = true; }
    else p.flying = false;
    if (p.onGround) { p.flyTimer = 0; p.flying = false; }
  }

  if (inp.jump && !p._jumpHeld) {
    if (isCockroach) { /* 비행만 */ }
    else if (hasCrouch) {
      if (p.onGround && !p.crouching && !p.knocked) { p.crouching = true; p.crouchTimer = 0; p._jumpHeld = true; }
      else if (!p.onGround && p.jumps > 0) { p.vy = p.airJumpForce; p.jumps--; p._jumpHeld = true; }
      else if (p.onGround && p.knocked && p.jumps > 0) { p.vy = p.airJumpForce; p.jumps--; p._jumpHeld = true; }
    } else {
      if (p.jumps > 0) { p.vy = p.jumpForce; p.jumps--; p._jumpHeld = true; }
    }
  }
  if (!inp.jump) p._jumpHeld = false;

  if (p.attackCooldown > 0) p.attackCooldown -= dt;
  if (p.attacking) { p.attackTimer -= dt; if (p.attackTimer <= 0) p.attacking = false; }
  if (inp.attack && p.bs.autoFire && !p.attacking && p.attackCooldown <= 0 && p.stunTimer <= 0) {
    triggerAttack(g, p);
  }
  if (inp.attack && !p._attackHeld && !p.bs.autoFire && p.stunTimer <= 0) {
    triggerAttack(g, p); p._attackHeld = true;
  }
  if (!inp.attack) p._attackHeld = false;

  if (isCockroach && !p.onGround && !p.flying) p.vy = Math.min(p.vy + 0.35 * dt, 10);
  else p.vy = Math.min(p.vy + 0.55 * dt, 18);

  p.x += p.vx * dt; p.worldY += p.vy * dt;
  if (p.x < -p.w) p.x = W; if (p.x > W) p.x = -p.w;

  p.onGround = false;
  for (const pl of g.platforms) {
    if (p.x + p.w <= pl.x || p.x >= pl.x + pl.w) continue;
    const pBot = p.worldY + p.h;
    if (pBot >= pl.worldY && pBot - p.vy * dt <= pl.worldY + 2 && p.vy > 0) {
      p.worldY = pl.worldY - p.h; p.vy = 0; p.onGround = true;
      if (p.knocked) { p.knocked = false; p.flyTimer = 0; }
      p.jumps = p.maxJumps;
    }
  }

  if (p.charId === 'protein_stick' && !p.onGround) p.spinAngle += 0.25 * dt;
  else p.spinAngle = 0;

  if (Math.abs(p.vx) > 0.5) { p.ft += dt; if (p.ft > 7) { p.ft = 0; p.frame = (p.frame + 1) % 4; } } else p.frame = 0;
}

// ─── 공격 트리거 ─────────────────────────────
function triggerAttack(g, p) {
  const bs = p.bs;
  const angle = Math.atan2(p.input.mouseY - (p.worldY + p.h / 2 - g.camY), p.input.mouseX - (p.x + p.w / 2));
  p.facing = Math.cos(angle) >= 0 ? 1 : -1;
  p.attackAngle = angle;

  if (bs.atkType === 'rapidPunch') {
    if (p.attacking || p.attackCooldown > 0) return;
    p.attacking = true; p.attackTimer = 8; p.attackCooldown = bs.cooldown;
  } else if (bs.atkType === 'grab') {
    if (p.attacking || p.attackCooldown > 0 || p.grabArm) return;
    p.attackCooldown = bs.cooldown;
    p.grabArm = { x: p.x + p.w / 2, y: p.worldY + p.h / 2, vx: Math.cos(angle) * bs.grabSpeed, vy: Math.sin(angle) * bs.grabSpeed, dist: 0, maxDist: bs.grabRange, hit: false, returning: false, targetIdx: -1 };
  } else if (bs.atkType === 'bomb') {
    if (p.attackCooldown > 0) return;
    p.attackCooldown = bs.cooldown;
    g.projectiles.push({ type: 'bomb', ownerIdx: g.p.indexOf(p), x: p.x + p.w / 2, y: p.worldY + p.h / 2, vx: Math.cos(angle) * bs.bombSpeed, vy: Math.sin(angle) * bs.bombSpeed, gravity: bs.bombGravity, fuse: bs.bombFuseTime, landed: false, radius: bs.blastRadius, stun: bs.stun, kb: bs.kb });
  } else if (bs.atkType === 'shard') {
    if (p.attackCooldown > 0) return;
    p.attackCooldown = bs.cooldown;
    g.projectiles.push({ type: 'shard', ownerIdx: g.p.indexOf(p), x: p.x + p.w / 2, y: p.worldY + p.h / 2, vx: Math.cos(angle) * bs.shardSpeed, vy: Math.sin(angle) * bs.shardSpeed, dist: 0, maxDist: bs.shardRange, stun: bs.stun, kb: bs.kb, slowDur: bs.slowDuration });
  } else if (bs.atkType === 'comboPunch') {
    if (p.attacking || p.attackCooldown > 0) return;
    p.attacking = true; p.attackTimer = 10; p.attackCooldown = bs.cooldown;
  } else {
    if (p.attacking || p.attackCooldown > 0) return;
    p.attacking = true; p.attackTimer = 12; p.attackCooldown = bs.cooldown;
  }
}

// ─── 피격 판정 ───────────────────────────────
function checkHit(g, atk, tgt) {
  const bs = atk.bs;
  if (bs.atkType !== 'punch' && bs.atkType !== 'rapidPunch' && bs.atkType !== 'comboPunch') return;
  const maxT = bs.atkType === 'rapidPunch' ? 8 : bs.atkType === 'comboPunch' ? 10 : 12;
  if (!atk.attacking || atk.attackTimer > maxT - 2 || atk.attackTimer < 1) return;
  if (tgt.stunTimer > 0) return;
  const cx = atk.x + atk.w / 2, cy = atk.worldY + atk.h / 2;
  const fx = cx + Math.cos(atk.attackAngle) * 30, fy = cy + Math.sin(atk.attackAngle) * 30;
  const dx = (tgt.x + tgt.w / 2) - fx, dy = (tgt.worldY + tgt.h / 2) - fy;
  if (Math.sqrt(dx * dx + dy * dy) < 28) {
    let kb = bs.kb;
    if (bs.atkType === 'comboPunch') { atk.comboCount++; kb = Math.min(bs.maxComboKb, bs.kb + atk.comboCount * bs.comboKbGrow); }
    applyHit(tgt, atk.attackAngle, kb, bs.stun);
    atk.attacking = false;
  }
}

function applyHit(tgt, angle, kb, stun) {
  tgt.vx = Math.cos(angle) * kb; tgt.vy = Math.sin(angle) * kb;
  tgt.stunTimer = stun; tgt.crouching = false; tgt.crouchTimer = 0; tgt.flying = false;
  tgt.knocked = true;
  if (tgt.charId === 'cockroach') { tgt.flyTimer = tgt.maxFlyTime * 0.5; tgt.jumps = 0; }
  else if (tgt.charId === 'rabbit') tgt.jumps = 2;
  else tgt.jumps = 1;
}

// ─── 투사체 ──────────────────────────────────
function updateProjectiles(g, dt) {
  const remove = [];
  for (let i = 0; i < g.projectiles.length; i++) {
    const pr = g.projectiles[i];
    if (pr.type === 'bomb') {
      if (!pr.landed) {
        pr.vy += pr.gravity * dt; pr.x += pr.vx * dt; pr.y += pr.vy * dt;
        for (const pl of g.platforms) {
          if (pr.x > pl.x && pr.x < pl.x + pl.w && pr.y >= pl.worldY - 6 && pr.y <= pl.worldY + pl.h + 4) {
            pr.landed = true; pr.vx = 0; pr.vy = 0; pr.y = pl.worldY - 6; if (pr.fuse > 120) pr.fuse = 120; break;
          }
        }
        if (!pr.landed) {
          const tgt = g.p[1 - pr.ownerIdx];
          if (Math.abs(pr.x - (tgt.x + tgt.w / 2)) < 18 && Math.abs(pr.y - (tgt.worldY + tgt.h / 2)) < 20) { explode(g, pr); remove.push(i); continue; }
        }
      }
      pr.fuse -= dt; if (pr.fuse <= 0) { explode(g, pr); remove.push(i); continue; }
      if (pr.y - g.camY > H + 100) { remove.push(i); continue; }
    } else if (pr.type === 'shard') {
      pr.x += pr.vx * dt; pr.y += pr.vy * dt; pr.dist += Math.sqrt(pr.vx * pr.vx + pr.vy * pr.vy) * dt;
      if (pr.dist >= pr.maxDist) { remove.push(i); continue; }
      const tgt = g.p[1 - pr.ownerIdx];
      if (tgt.stunTimer <= 0 && Math.abs(pr.x - (tgt.x + tgt.w / 2)) < 18 && Math.abs(pr.y - (tgt.worldY + tgt.h / 2)) < 20) {
        applyHit(tgt, Math.atan2(pr.vy, pr.vx), pr.kb, pr.stun);
        tgt.slowTimer = pr.slowDur;
        remove.push(i); continue;
      }
    }
  }
  for (let i = remove.length - 1; i >= 0; i--) g.projectiles.splice(remove[i], 1);

  for (let i = 0; i < 2; i++) {
    const p = g.p[i]; if (!p.grabArm) continue;
    const arm = p.grabArm; const tgt = g.p[1 - i];
    if (!arm.returning && !arm.hit) {
      arm.x += arm.vx * dt; arm.y += arm.vy * dt;
      arm.dist += Math.sqrt(arm.vx * arm.vx + arm.vy * arm.vy) * dt;
      if (tgt.stunTimer <= 0 && Math.abs(arm.x - (tgt.x + tgt.w / 2)) < 20 && Math.abs(arm.y - (tgt.worldY + tgt.h / 2)) < 22) { arm.hit = true; arm.targetIdx = 1 - i; }
      if (arm.dist >= arm.maxDist) arm.returning = true;
    } else if (arm.hit && arm.targetIdx >= 0) {
      const t2 = g.p[arm.targetIdx];
      const px = p.x + p.w / 2, py = p.worldY + p.h / 2;
      const dx = px - t2.x - t2.w / 2, dy = py - t2.worldY - t2.h / 2;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < 20) { applyHit(t2, 0, 0, p.bs.stun); p.grabArm = null; continue; }
      t2.vx = dx / d * 16; t2.vy = dy / d * 16;
      t2.x += t2.vx * dt; t2.worldY += t2.vy * dt;
      arm.x = t2.x + t2.w / 2; arm.y = t2.worldY + t2.h / 2;
    } else if (arm.returning) {
      const px = p.x + p.w / 2, py = p.worldY + p.h / 2;
      const dx = px - arm.x, dy = py - arm.y, d = Math.sqrt(dx * dx + dy * dy);
      if (d < 15) { p.grabArm = null; continue; }
      arm.x += dx / d * 18 * dt; arm.y += dy / d * 18 * dt;
    }
  }
}

function explode(g, pr) {
  for (let i = 0; i < 2; i++) {
    if (i === pr.ownerIdx) continue;
    const p = g.p[i];
    const dx = p.x + p.w / 2 - pr.x, dy = p.worldY + p.h / 2 - pr.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < pr.radius) { applyHit(p, Math.atan2(dy, dx), pr.kb * (1 - d / pr.radius * 0.5), pr.stun); }
  }
}

function respawn(g, p) {
  const vis = g.platforms.filter(pl => pl.worldY - g.camY > 30 && pl.worldY - g.camY < H * 0.35);
  if (vis.length > 0) { const pl = vis[Math.floor(Math.random() * vis.length)]; p.x = pl.x + pl.w / 2 - p.w / 2; p.worldY = pl.worldY - p.h - 10; }
  else { p.x = W / 2 - p.w / 2; p.worldY = g.camY + 60; }
  p.vx = 0; p.vy = 0; p.jumps = p.maxJumps; p.crouching = false; p.crouchTimer = 0;
  p.flying = false; p.flyTimer = 0; p.spinAngle = 0; p.stunTimer = 0; p.knocked = false;
  p.slowTimer = 0; p.grabArm = null; p.attacking = false;
}

// ─── 상태 전송 ───────────────────────────────
function serializePlayer(p) {
  return { x: p.x, wy: p.worldY, vx: p.vx, vy: p.vy, f: p.facing, fr: p.frame,
    atk: p.attacking, aa: p.attackAngle, at: p.attackTimer, og: p.onGround,
    st: p.stunTimer, hp: p.hp, mhp: p.maxHp, kn: p.knocked,
    cr: p.crouching, ct: p.crouchTimer, fl: p.flying, ft: p.flyTimer,
    sa: p.spinAngle, sl: p.slowTimer, cc: p.comboCount, cid: p.charId,
    ga: p.grabArm ? { x: p.grabArm.x, y: p.grabArm.y, hit: p.grabArm.hit, ret: p.grabArm.returning } : null };
}

function sendState(room) {
  const g = room.g; if (!g) return;
  const msg = {
    type: 'gs',
    s: g.state, t: g.time, cy: g.camY, h: g.height, ss: g.scrollSpeed,
    cd: g.countdown, w: g.winner,
    p: [serializePlayer(g.p[0]), serializePlayer(g.p[1])],
    pr: g.projectiles.map(p => ({ type: p.type, x: p.x, y: p.y, vx: p.vx || 0, vy: p.vy || 0, landed: p.landed, fuse: p.fuse, oi: p.ownerIdx, dist: p.dist })),
    sh: g.ship ? { x: g.ship.x, wy: g.ship.worldY, b: g.ship.boarded, bt: g.ship.boardTimer, l: g.ship.launching, py: g.ship.padY } : null,
  };
  for (let i = 0; i < 2; i++) {
    const ws = room.players[i];
    if (ws && ws.readyState === 1) {
      msg.idx = i;
      ws.send(JSON.stringify(msg));
    }
  }
}

// ─── 연결 처리 ───────────────────────────────
function removePlayer(ws) {
  if (!ws._roomCode) return;
  const room = rooms.get(ws._roomCode);
  if (!room) return;
  const idx = room.players.indexOf(ws);
  if (idx !== -1) room.players[idx] = null;
  // 틱 중단
  if (room.tickId) { clearInterval(room.tickId); room.tickId = null; }
  const alive = room.players.filter(p => p !== null);
  if (alive.length === 0) {
    rooms.delete(ws._roomCode);
  } else {
    // 상대가 아직 있으면 알림 (방은 유지)
    broadcastAll(room, { type: 'opponent_left' });
    room.state = 'waiting';
    room.g = null;
  }
}

wss.on('connection', (ws) => {
  ws._roomCode = null; ws._playerIdx = -1;

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'create_room': {
        const code = genRoomCode();
        rooms.set(code, {
          code, players: [ws, null], state: 'waiting',
          createdAt: Date.now(), g: null, tickId: null,
          game_players: [], chars: [null, null],
          ready: [false, false],
        });
        ws._roomCode = code; ws._playerIdx = 0;
        sendTo(ws, { type: 'room_created', code });
        break;
      }
      case 'join_room': {
        const code = String(msg.code);
        const room = rooms.get(code);
        if (!room) { sendTo(ws, { type: 'error', msg: '방을 찾을 수 없습니다' }); break; }
        if (room.players[1] !== null && room.players[1].readyState === 1) { sendTo(ws, { type: 'error', msg: '방이 가득 찼습니다' }); break; }
        // 빈 슬롯 찾기 (재접속 지원)
        const slot = room.players[0] === null ? 0 : 1;
        room.players[slot] = ws; ws._roomCode = code; ws._playerIdx = slot;
        sendTo(ws, { type: 'room_joined', code, playerIdx: slot });
        // 방에 2명 다 있으면 상대에게도 알림
        const other = room.players[1 - slot];
        if (other && other.readyState === 1) {
          sendTo(other, { type: 'room_ready' });
          sendTo(ws, { type: 'room_ready' });
          // 상대 캐릭터 정보 공유
          if (room.chars[1 - slot]) sendTo(ws, { type: 'opponent_char', charId: room.chars[1 - slot] });
          if (room.chars[slot]) sendTo(other, { type: 'opponent_char', charId: room.chars[slot] });
          if (room.ready[1 - slot]) sendTo(ws, { type: 'opponent_ready' });
          if (room.ready[slot]) sendTo(other, { type: 'opponent_ready' });
        }
        break;
      }
      case 'char_select': {
        const room = rooms.get(ws._roomCode);
        if (!room) break;
        room.chars[ws._playerIdx] = msg.charId;
        // 상대에게 캐릭터 선택 알림
        const other = room.players[1 - ws._playerIdx];
        sendTo(other, { type: 'opponent_char', charId: msg.charId });
        break;
      }
      case 'player_ready': {
        const room = rooms.get(ws._roomCode);
        if (!room) break;
        room.chars[ws._playerIdx] = msg.charId;
        room.ready[ws._playerIdx] = true;
        // 상대에게 준비 완료 알림
        const other = room.players[1 - ws._playerIdx];
        sendTo(other, { type: 'opponent_ready' });
        // 둘 다 준비됐으면 게임 시작
        if (room.ready[0] && room.ready[1] && room.chars[0] && room.chars[1]) {
          room.ready = [false, false]; // 리셋
          room.game_players = [
            makePlayer(room.chars[0], W * 0.3, 1),
            makePlayer(room.chars[1], W * 0.7, -1),
          ];
          broadcastAll(room, { type: 'game_start', chars: room.chars });
          startGame(room);
        }
        break;
      }
      case 'input': {
        const room = rooms.get(ws._roomCode);
        if (!room || !room.g) break;
        const p = room.g.p[ws._playerIdx];
        if (p) {
          p.input.left = !!msg.l; p.input.right = !!msg.r; p.input.jump = !!msg.j;
          p.input.attack = !!msg.a; p.input.mouseX = msg.mx || 0; p.input.mouseY = msg.my || 0;
        }
        break;
      }
      case 'ping': { sendTo(ws, { type: 'pong', t: msg.t }); break; }
      case 'leave_room': {
        removePlayer(ws); ws._roomCode = null; ws._playerIdx = -1;
        sendTo(ws, { type: 'left_room' }); break;
      }
    }
  });

  ws.on('close', () => removePlayer(ws));
  ws.on('error', () => removePlayer(ws));
});

server.listen(PORT, () => { console.log(`Sky Climber authoritative server on port ${PORT}`); });

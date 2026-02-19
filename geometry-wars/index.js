/**
 * geometry-wars plugin
 *
 * Serves a Geometry Wars-style interactive visualization that reacts to
 * TinyClaw events (message_received, agent_routed, response_ready, etc.)
 * via SSE. Self-contained HTTP server + game HTML.
 *
 * Starts automatically on plugin load. Access at http://localhost:3333/
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3333;

const GEOMETRY_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TinyClaw // Geometry Wars</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #000;
      overflow: hidden;
      font-family: 'Courier New', monospace;
    }
    canvas { display: block; }
    #state-label {
      position: fixed;
      top: 16px;
      right: 16px;
      color: #0af;
      font-size: 11px;
      letter-spacing: 3px;
      text-transform: uppercase;
      opacity: 0.5;
      text-shadow: 0 0 8px #0af;
      pointer-events: none;
    }
    #score {
      position: fixed;
      top: 16px;
      left: 16px;
      color: #fff;
      font-size: 14px;
      letter-spacing: 2px;
      opacity: 0.4;
      text-shadow: 0 0 6px #fff;
      pointer-events: none;
    }
  </style>
</head>
<body>
  <canvas id="c"></canvas>
  <div id="state-label">IDLE</div>
  <div id="score">TINYCLAW</div>

  <script>
  (function() {
    var canvas = document.getElementById('c');
    var ctx = canvas.getContext('2d');
    var label = document.getElementById('state-label');

    var W, H, dpr;
    var BORDER_PAD = 60;

    function resize() {
      dpr = window.devicePixelRatio || 1;
      W = window.innerWidth;
      H = window.innerHeight;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      canvas.style.width = W + 'px';
      canvas.style.height = H + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      initGrid();
    }

    var GRID_COLS = 50;
    var GRID_ROWS = 30;
    var gridPoints = [];
    var gridAnchors = [];
    var GRID_STIFFNESS = 0.03;
    var GRID_DAMPING = 0.93;
    var ANCHOR_STIFFNESS = 0.005;

    function initGrid() {
      gridPoints = [];
      gridAnchors = [];
      var fieldW = W - BORDER_PAD * 2;
      var fieldH = H - BORDER_PAD * 2;
      for (var r = 0; r <= GRID_ROWS; r++) {
        for (var c = 0; c <= GRID_COLS; c++) {
          var x = BORDER_PAD + (c / GRID_COLS) * fieldW;
          var y = BORDER_PAD + (r / GRID_ROWS) * fieldH;
          gridPoints.push({ x: x, y: y, vx: 0, vy: 0 });
          gridAnchors.push({ x: x, y: y });
        }
      }
    }

    function applyGridForce(px, py, force, radius) {
      for (var i = 0; i < gridPoints.length; i++) {
        var p = gridPoints[i];
        var dx = p.x - px;
        var dy = p.y - py;
        var dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < radius && dist > 1) {
          var strength = force * (1 - dist / radius);
          p.vx += (dx / dist) * strength;
          p.vy += (dy / dist) * strength;
        }
      }
    }

    function updateGrid() {
      for (var i = 0; i < gridPoints.length; i++) {
        var p = gridPoints[i];
        var a = gridAnchors[i];
        p.vx += (a.x - p.x) * ANCHOR_STIFFNESS;
        p.vy += (a.y - p.y) * ANCHOR_STIFFNESS;
        p.vx *= GRID_DAMPING;
        p.vy *= GRID_DAMPING;
        p.x += p.vx;
        p.y += p.vy;
      }
    }

    function drawGrid() {
      var cols = GRID_COLS + 1;
      ctx.lineWidth = 0.5;
      for (var r = 0; r <= GRID_ROWS; r++) {
        ctx.beginPath();
        ctx.strokeStyle = r % 3 === 0 ? 'rgba(0,80,180,0.25)' : 'rgba(0,40,120,0.12)';
        if (r % 3 === 0) ctx.lineWidth = 1;
        else ctx.lineWidth = 0.5;
        for (var c = 0; c <= GRID_COLS; c++) {
          var p = gridPoints[r * cols + c];
          if (c === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();
      }
      for (var c = 0; c <= GRID_COLS; c++) {
        ctx.beginPath();
        ctx.strokeStyle = c % 3 === 0 ? 'rgba(0,80,180,0.25)' : 'rgba(0,40,120,0.12)';
        if (c % 3 === 0) ctx.lineWidth = 1;
        else ctx.lineWidth = 0.5;
        for (var r = 0; r <= GRID_ROWS; r++) {
          var p = gridPoints[r * cols + c];
          if (r === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();
      }
    }

    function drawBorder() {
      ctx.strokeStyle = '#0af';
      ctx.lineWidth = 2;
      ctx.shadowBlur = 15;
      ctx.shadowColor = '#0af';
      ctx.strokeRect(BORDER_PAD, BORDER_PAD, W - BORDER_PAD * 2, H - BORDER_PAD * 2);
      ctx.shadowBlur = 0;
    }

    var ship = {
      x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0,
      angle: 0, thrust: 0.06, maxSpeed: 1.8, drag: 0.985, wanderTimer: 0
    };

    function initShip() {
      ship.x = W / 2; ship.y = H / 2;
      ship.vx = 0; ship.vy = 0;
      ship.tx = ship.x; ship.ty = ship.y;
    }

    function pickWanderTarget() {
      var margin = BORDER_PAD + 80;
      ship.tx = margin + Math.random() * (W - margin * 2);
      ship.ty = margin + Math.random() * (H - margin * 2);
    }

    function updateShip() {
      var dx = ship.tx - ship.x;
      var dy = ship.ty - ship.y;
      var dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 40) {
        ship.wanderTimer--;
        if (ship.wanderTimer <= 0) {
          pickWanderTarget();
          ship.wanderTimer = 60 + Math.floor(Math.random() * 120);
        }
      }
      var desiredAngle = ship.angle;
      if ((currentState === 'thinking' || currentState === 'collaborating') && targetEnemy) {
        desiredAngle = Math.atan2(targetEnemy.y - ship.y, targetEnemy.x - ship.x);
      } else if (currentState === 'idle' && crystals.length === 0 && miningTarget && asteroids.indexOf(miningTarget) !== -1) {
        var mtdx = miningTarget.x - ship.x;
        var mtdy = miningTarget.y - ship.y;
        if (Math.sqrt(mtdx * mtdx + mtdy * mtdy) < 120) desiredAngle = Math.atan2(mtdy, mtdx);
        else desiredAngle = Math.atan2(dy, dx);
      } else if (dist > 5) {
        desiredAngle = Math.atan2(dy, dx);
      }
      var diff = desiredAngle - ship.angle;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      var turnRate = 0.08;
      if (currentState === 'thinking' || currentState === 'collaborating') turnRate = 0.1;
      ship.angle += diff * turnRate;
      var thrustPower = ship.thrust;
      var maxSpd = ship.maxSpeed;
      if (currentState === 'thinking' || currentState === 'collaborating') { thrustPower = 0.12; maxSpd = 3.2; }
      ship.thrustDirX = 0; ship.thrustDirY = 0;
      if (dist > 15) {
        var distScale = Math.min(1, dist / 100);
        var tx = (dx / dist) * thrustPower * distScale;
        var ty = (dy / dist) * thrustPower * distScale;
        ship.vx += tx; ship.vy += ty;
        ship.thrustDirX = tx; ship.thrustDirY = ty;
      } else { ship.vx *= 0.92; ship.vy *= 0.92; }
      ship.vx *= ship.drag; ship.vy *= ship.drag;
      var spd = Math.sqrt(ship.vx * ship.vx + ship.vy * ship.vy);
      if (spd > maxSpd) { ship.vx = (ship.vx / spd) * maxSpd; ship.vy = (ship.vy / spd) * maxSpd; }
      ship.x += ship.vx; ship.y += ship.vy;
      for (var ai = 0; ai < asteroids.length; ai++) {
        var ast = asteroids[ai];
        var adx = ship.x - ast.x; var ady = ship.y - ast.y;
        var adist = Math.sqrt(adx * adx + ady * ady);
        var minDist = ast.size + 8;
        if (adist < minDist && adist > 0) {
          var overlap = minDist - adist;
          ship.x += (adx / adist) * overlap; ship.y += (ady / adist) * overlap;
          var nx = adx / adist; var ny = ady / adist;
          var dot = ship.vx * nx + ship.vy * ny;
          if (dot < 0) { ship.vx -= 2 * dot * nx * 0.6; ship.vy -= 2 * dot * ny * 0.6; }
          ast.vx -= nx * 0.2; ast.vy -= ny * 0.2;
        }
      }
      var margin = BORDER_PAD + 10;
      if (ship.x < margin) { ship.x = margin; ship.vx *= -0.5; }
      if (ship.x > W - margin) { ship.x = W - margin; ship.vx *= -0.5; }
      if (ship.y < margin) { ship.y = margin; ship.vy *= -0.5; }
      if (ship.y > H - margin) { ship.y = H - margin; ship.vy *= -0.5; }
    }

    function drawShip(x, y, angle) {
      ctx.save(); ctx.translate(x, y); ctx.rotate(angle);
      ctx.strokeStyle = '#0ff'; ctx.lineWidth = 2;
      ctx.shadowBlur = 12; ctx.shadowColor = '#0ff';
      ctx.beginPath();
      ctx.moveTo(12, 0); ctx.lineTo(-8, -7); ctx.lineTo(-4, 0); ctx.lineTo(-8, 7);
      ctx.closePath(); ctx.stroke();
      ctx.fillStyle = 'rgba(0,255,255,0.3)';
      ctx.beginPath(); ctx.arc(-5, 0, 4, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0; ctx.restore();
    }

    var bullets = [];
    function fireBullet() {
      var noseX = ship.x + Math.cos(ship.angle) * 14;
      var noseY = ship.y + Math.sin(ship.angle) * 14;
      bullets.push({ x: noseX, y: noseY, vx: Math.cos(ship.angle) * 7, vy: Math.sin(ship.angle) * 7, trail: [] });
      ship.vx -= Math.cos(ship.angle) * 0.4; ship.vy -= Math.sin(ship.angle) * 0.4;
      applyGridForce(noseX, noseY, -3, 100);
    }
    function bulletHitEffect(x, y) { spawnParticles(x, y, '#0ff', 15); applyGridForce(x, y, 5, 120); }
    function updateBullets() {
      for (var i = bullets.length - 1; i >= 0; i--) {
        var b = bullets[i];
        b.trail.push({ x: b.x, y: b.y }); if (b.trail.length > 6) b.trail.shift();
        b.x += b.vx; b.y += b.vy;
        if (b.x < BORDER_PAD || b.x > W - BORDER_PAD || b.y < BORDER_PAD || b.y > H - BORDER_PAD) {
          bulletHitEffect(b.x, b.y); bullets.splice(i, 1); continue;
        }
        var hit = false;
        for (var j = enemies.length - 1; j >= 0; j--) {
          var e = enemies[j];
          if (Math.sqrt((b.x-e.x)*(b.x-e.x)+(b.y-e.y)*(b.y-e.y)) < e.type.size + 4) {
            e.hp--; e.flash = 1; bulletHitEffect(b.x, b.y);
            if (e.hp <= 0) { spawnParticles(e.x, e.y, e.type.color, 30); spawnCrystals(e.x, e.y, '#0f0', 12); applyGridForce(e.x, e.y, 8, 150); enemies.splice(j, 1); }
            bullets.splice(i, 1); hit = true; break;
          }
        }
        if (hit) continue;
        for (var k = 0; k < asteroids.length; k++) {
          var ast = asteroids[k];
          if (Math.sqrt((b.x-ast.x)*(b.x-ast.x)+(b.y-ast.y)*(b.y-ast.y)) < ast.size) {
            ast.hp--; ast.flash = 1;
            ast.vx += b.vx * 0.15; ast.vy += b.vy * 0.15; ast.spin += (Math.random() - 0.5) * 0.01;
            bulletHitEffect(b.x, b.y); spawnParticles(b.x, b.y, '#886', 5); applyGridForce(ast.x, ast.y, 3, 80);
            bullets.splice(i, 1); break;
          }
        }
      }
    }
    function drawBullets() {
      for (var i = 0; i < bullets.length; i++) {
        var b = bullets[i];
        if (b.trail.length > 1) {
          ctx.beginPath(); ctx.moveTo(b.trail[0].x, b.trail[0].y);
          for (var t = 1; t < b.trail.length; t++) ctx.lineTo(b.trail[t].x, b.trail[t].y);
          ctx.lineTo(b.x, b.y);
          ctx.strokeStyle = 'rgba(0,255,255,0.5)'; ctx.lineWidth = 3;
          ctx.shadowBlur = 8; ctx.shadowColor = '#0ff'; ctx.stroke();
        }
        ctx.fillStyle = '#fff'; ctx.shadowBlur = 18; ctx.shadowColor = '#0ff';
        ctx.beginPath(); ctx.arc(b.x, b.y, 4, 0, Math.PI * 2); ctx.fill();
      }
      ctx.shadowBlur = 0;
    }

    var asteroids = [];
    var miningTarget = null;
    var miningProgress = 0;
    var ASTEROID_COUNT = 6;
    function spawnAsteroid() {
      var margin = BORDER_PAD + 60;
      var x = margin + Math.random() * (W - margin * 2);
      var y = margin + Math.random() * (H - margin * 2);
      var verts = []; var sides = 6 + Math.floor(Math.random() * 4);
      for (var i = 0; i < sides; i++) { verts.push({ a: (i / sides) * Math.PI * 2, r: 0.7 + Math.random() * 0.5 }); }
      asteroids.push({ x: x, y: y, vx: (Math.random()-0.5)*0.3, vy: (Math.random()-0.5)*0.3, angle: Math.random()*Math.PI*2, spin: (Math.random()-0.5)*0.005, size: 18+Math.random()*16, hp: 3, maxHp: 3, verts: verts, flash: 0 });
    }
    function initAsteroids() { asteroids = []; for (var i = 0; i < ASTEROID_COUNT; i++) spawnAsteroid(); }
    function findNearestAsteroid() {
      var best = null, bestDist = Infinity;
      for (var i = 0; i < asteroids.length; i++) { var a = asteroids[i]; var d = (a.x-ship.x)*(a.x-ship.x)+(a.y-ship.y)*(a.y-ship.y); if (d < bestDist) { bestDist = d; best = a; } }
      return best;
    }
    function updateAsteroids() {
      for (var i = asteroids.length - 1; i >= 0; i--) {
        var a = asteroids[i]; a.x += a.vx; a.y += a.vy; a.angle += a.spin;
        if (a.flash > 0) a.flash -= 0.05;
        var margin = BORDER_PAD + a.size;
        if (a.x < margin) { a.x = margin; a.vx *= -1; } if (a.x > W - margin) { a.x = W - margin; a.vx *= -1; }
        if (a.y < margin) { a.y = margin; a.vy *= -1; } if (a.y > H - margin) { a.y = H - margin; a.vy *= -1; }
        if (a.hp <= 0) {
          spawnParticles(a.x, a.y, '#886', 20); spawnCrystals(a.x, a.y, '#4af', 8); applyGridForce(a.x, a.y, 5, 120);
          asteroids.splice(i, 1);
          if (miningTarget === a) { miningTarget = null; miningProgress = 0; }
          setTimeout(spawnAsteroid, 3000 + Math.random() * 4000);
        }
      }
    }
    function drawAsteroid(a) {
      ctx.save(); ctx.translate(a.x, a.y); ctx.rotate(a.angle);
      var col = a.flash > 0.3 ? '#fff' : '#886';
      ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.shadowBlur = 8; ctx.shadowColor = col;
      ctx.beginPath();
      for (var i = 0; i <= a.verts.length; i++) { var v = a.verts[i % a.verts.length]; var px = Math.cos(v.a)*a.size*v.r; var py = Math.sin(v.a)*a.size*v.r; if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); }
      ctx.closePath(); ctx.stroke();
      if (a.hp / a.maxHp < 1) { ctx.strokeStyle = 'rgba(136,102,102,0.4)'; ctx.lineWidth = 0.5; ctx.shadowBlur = 0;
        for (var i = 0; i < (1 - a.hp / a.maxHp) * 4; i++) { ctx.beginPath(); ctx.moveTo((Math.random()-0.5)*a.size,(Math.random()-0.5)*a.size); ctx.lineTo((Math.random()-0.5)*a.size,(Math.random()-0.5)*a.size); ctx.stroke(); } }
      ctx.shadowBlur = 0; ctx.restore();
    }

    var crystals = [];
    function spawnCrystals(x, y, color, count) {
      for (var i = 0; i < count; i++) { var angle = Math.random()*Math.PI*2; var speed = 2+Math.random()*3;
        crystals.push({ x: x, y: y, vx: Math.cos(angle)*speed, vy: Math.sin(angle)*speed, color: color, angle: Math.random()*Math.PI*2, spin: (Math.random()-0.5)*0.1, life: 1, age: 0 }); }
    }
    function findNearestCrystal() {
      var best = null, bestDist = Infinity;
      for (var i = 0; i < crystals.length; i++) { var c = crystals[i]; var d = (c.x-ship.x)*(c.x-ship.x)+(c.y-ship.y)*(c.y-ship.y); if (d < bestDist) { bestDist = d; best = c; } }
      return best;
    }
    function updateCrystals() {
      for (var i = crystals.length - 1; i >= 0; i--) {
        var c = crystals[i]; c.age += 0.016; c.vx *= 0.98; c.vy *= 0.98; c.x += c.vx; c.y += c.vy; c.angle += c.spin;
        var margin = BORDER_PAD + 4;
        if (c.x < margin) { c.x = margin; c.vx *= -0.8; } if (c.x > W - margin) { c.x = W - margin; c.vx *= -0.8; }
        if (c.y < margin) { c.y = margin; c.vy *= -0.8; } if (c.y > H - margin) { c.y = H - margin; c.vy *= -0.8; }
        if (Math.sqrt((ship.x-c.x)*(ship.x-c.x)+(ship.y-c.y)*(ship.y-c.y)) < 20) { spawnParticles(c.x, c.y, c.color, 3); crystals.splice(i, 1); }
      }
    }
    function drawCrystals() {
      for (var i = 0; i < crystals.length; i++) {
        var c = crystals[i]; ctx.save(); ctx.translate(c.x, c.y); ctx.rotate(c.angle);
        ctx.globalAlpha = Math.max(0, c.life); ctx.strokeStyle = c.color; ctx.fillStyle = c.color;
        ctx.lineWidth = 1; ctx.shadowBlur = 8; ctx.shadowColor = c.color;
        ctx.beginPath(); ctx.moveTo(0,-4); ctx.lineTo(3,0); ctx.lineTo(0,4); ctx.lineTo(-3,0); ctx.closePath();
        ctx.stroke(); ctx.globalAlpha *= 0.3; ctx.fill(); ctx.globalAlpha = 1; ctx.shadowBlur = 0; ctx.restore();
      }
    }
    function drawMiningLaser(fromX, fromY, toX, toY) {
      var flicker = 0.6 + Math.random() * 0.4;
      ctx.strokeStyle = 'rgba(255,200,50,' + (flicker * 0.7) + ')'; ctx.lineWidth = 2; ctx.shadowBlur = 15; ctx.shadowColor = '#fa0';
      var mx = (fromX+toX)/2+(Math.random()-0.5)*4; var my = (fromY+toY)/2+(Math.random()-0.5)*4;
      ctx.beginPath(); ctx.moveTo(fromX, fromY); ctx.quadraticCurveTo(mx, my, toX, toY); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,200,' + (flicker * 0.5) + ')'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(fromX, fromY); ctx.quadraticCurveTo(mx, my, toX, toY); ctx.stroke();
      if (Math.random() < 0.3) spawnParticles(toX, toY, '#fa0', 1);
      ctx.shadowBlur = 0;
    }

    var enemies = [];
    var ENEMY_TYPES = [
      { color: '#f0a', sides: 4, size: 12, speed: 0.6, spin: 0.03, name: 'diamond' },
      { color: '#ff0', sides: 3, size: 10, speed: 0.9, spin: -0.05, name: 'arrow' },
      { color: '#f60', sides: 5, size: 14, speed: 0.4, spin: 0.02, name: 'penta' },
      { color: '#0f0', sides: 6, size: 11, speed: 0.7, spin: 0.04, name: 'hex' },
      { color: '#f00', sides: 8, size: 16, speed: 0.3, spin: 0.01, name: 'octa' }
    ];
    function spawnEnemy() {
      var type = ENEMY_TYPES[Math.floor(Math.random() * ENEMY_TYPES.length)];
      var side = Math.floor(Math.random() * 4); var x, y, margin = BORDER_PAD + 20;
      if (side === 0) { x = margin; y = margin + Math.random() * (H - margin * 2); }
      else if (side === 1) { x = W - margin; y = margin + Math.random() * (H - margin * 2); }
      else if (side === 2) { x = margin + Math.random() * (W - margin * 2); y = margin; }
      else { x = margin + Math.random() * (W - margin * 2); y = H - margin; }
      enemies.push({ x: x, y: y, vx: 0, vy: 0, angle: Math.random()*Math.PI*2, type: type, hp: 1, spawnTime: Date.now(), flash: 0 });
    }
    function updateEnemies() {
      for (var i = enemies.length - 1; i >= 0; i--) {
        var e = enemies[i]; var dx = ship.x - e.x; var dy = ship.y - e.y; var dist = Math.sqrt(dx*dx+dy*dy);
        if (dist > 1) { e.vx += (dx/dist)*e.type.speed*0.05; e.vy += (dy/dist)*e.type.speed*0.05; }
        e.vx *= 0.98; e.vy *= 0.98;
        var spd = Math.sqrt(e.vx*e.vx+e.vy*e.vy);
        if (spd > e.type.speed) { e.vx = (e.vx/spd)*e.type.speed; e.vy = (e.vy/spd)*e.type.speed; }
        e.x += e.vx; e.y += e.vy; e.angle += e.type.spin;
        if (e.flash > 0) e.flash -= 0.1;
        applyGridForce(e.x, e.y, -0.15, 50);
      }
    }
    function drawEnemy(e) {
      ctx.save(); ctx.translate(e.x, e.y); ctx.rotate(e.angle);
      var col = e.flash > 0.5 ? '#fff' : e.type.color;
      ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.shadowBlur = 15; ctx.shadowColor = col;
      ctx.beginPath();
      for (var i = 0; i <= e.type.sides; i++) { var a = (i/e.type.sides)*Math.PI*2; var px = Math.cos(a)*e.type.size; var py = Math.sin(a)*e.type.size; if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); }
      ctx.closePath(); ctx.stroke();
      ctx.globalAlpha = 0.1; ctx.fill(); ctx.globalAlpha = 1;
      ctx.shadowBlur = 0; ctx.restore();
    }

    var particles = [];
    function spawnParticles(x, y, color, count) {
      for (var i = 0; i < count; i++) { var angle = Math.random()*Math.PI*2; var speed = 1+Math.random()*4;
        particles.push({ x: x, y: y, vx: Math.cos(angle)*speed, vy: Math.sin(angle)*speed, life: 0.5+Math.random()*0.5, color: color, size: 1+Math.random()*2 }); }
    }
    function updateParticles() {
      for (var i = particles.length - 1; i >= 0; i--) {
        var p = particles[i]; p.x += p.vx; p.y += p.vy; p.vx *= 0.97; p.vy *= 0.97; p.life -= 0.015;
        if (p.life <= 0) particles.splice(i, 1);
      }
    }
    function drawParticles() {
      for (var i = 0; i < particles.length; i++) {
        var p = particles[i]; ctx.globalAlpha = Math.max(0, p.life);
        ctx.fillStyle = p.color; ctx.shadowBlur = 6; ctx.shadowColor = p.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1; ctx.shadowBlur = 0;
    }

    var currentState = 'idle';
    var stateTime = 0;
    var fireTimer = 0;
    var targetEnemy = null;

    function setState(s) {
      if (s === currentState) return;
      currentState = s; stateTime = 0; label.textContent = s.toUpperCase();
      if (s === 'listening') {
        miningTarget = null; miningProgress = 0;
        var count = 2 + Math.floor(Math.random() * 3);
        for (var i = 0; i < count; i++) spawnEnemy();
        applyGridForce(W / 2, H / 2, 4, 300);
      }
      if (s === 'thinking') { targetEnemy = findNearestEnemy(); fireTimer = 0; }
      if (s === 'speaking') {
        for (var i = 0; i < enemies.length; i++) { spawnParticles(enemies[i].x, enemies[i].y, enemies[i].type.color, 40); spawnCrystals(enemies[i].x, enemies[i].y, '#0f0', 12); applyGridForce(enemies[i].x, enemies[i].y, 10, 200); }
        enemies = []; targetEnemy = null;
        spawnParticles(ship.x, ship.y, '#fff', 50); applyGridForce(ship.x, ship.y, 6, 250);
      }
    }

    function findNearestEnemy() {
      var best = null, bestDist = Infinity;
      for (var i = 0; i < enemies.length; i++) { var e = enemies[i]; var d = (e.x-ship.x)*(e.x-ship.x)+(e.y-ship.y)*(e.y-ship.y); if (d < bestDist) { bestDist = d; best = e; } }
      return best;
    }

    var sse = new EventSource('/events');
    sse.onmessage = function(e) {
      try {
        var ev = JSON.parse(e.data);
        switch (ev.type) {
          case 'message_received': setState('listening'); break;
          case 'agent_routed': setState('thinking'); break;
          case 'response_ready': setState('speaking'); break;
          case 'chain_step_start':
          case 'team_chain_start': setState('collaborating'); break;
          case 'team_chain_end': setState('speaking'); break;
        }
      } catch(err) {}
    };

    var lastTime = performance.now();
    function frame(now) {
      requestAnimationFrame(frame);
      var dt = (now - lastTime) / 16.67; lastTime = now; stateTime += dt;
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
      updateGrid(); updateShip(); updateBullets(); updateEnemies(); updateAsteroids(); updateCrystals(); updateParticles();

      if (currentState === 'idle') {
        if (crystals.length > 0) {
          miningTarget = null; miningProgress = 0;
          var nearCrystal = findNearestCrystal();
          if (nearCrystal) { ship.tx = nearCrystal.x; ship.ty = nearCrystal.y; }
        } else if (asteroids.length > 0) {
          if (!miningTarget || asteroids.indexOf(miningTarget) === -1) { miningTarget = findNearestAsteroid(); miningProgress = 0; }
          if (miningTarget) {
            var mdx = miningTarget.x - ship.x; var mdy = miningTarget.y - ship.y; var mdist = Math.sqrt(mdx*mdx+mdy*mdy);
            if (mdist > 100) { ship.tx = miningTarget.x; ship.ty = miningTarget.y; }
            else { var orbitAngle = Math.atan2(ship.y-miningTarget.y, ship.x-miningTarget.x)+0.01; ship.tx = miningTarget.x+Math.cos(orbitAngle)*90; ship.ty = miningTarget.y+Math.sin(orbitAngle)*90; miningProgress += dt; if (miningProgress > 60) { miningProgress = 0; miningTarget.hp--; miningTarget.flash = 1; spawnParticles(miningTarget.x, miningTarget.y, '#fa0', 5); applyGridForce(miningTarget.x, miningTarget.y, 2, 60); } }
          }
        } else { miningTarget = null; pickWanderTarget(); }
      }
      if (currentState === 'listening') { if (stateTime > 90) setState('thinking'); }
      if (currentState === 'thinking') {
        fireTimer += dt;
        if (targetEnemy && enemies.indexOf(targetEnemy) === -1) targetEnemy = findNearestEnemy();
        if (targetEnemy) {
          var edx = targetEnemy.x-ship.x; var edy = targetEnemy.y-ship.y; var edist = Math.sqrt(edx*edx+edy*edy);
          if (edist > 120) { ship.tx = targetEnemy.x; ship.ty = targetEnemy.y; }
          else { ship.tx = ship.x+edy*0.5; ship.ty = ship.y-edx*0.5; }
          if (fireTimer > 25) { fireTimer = 0; fireBullet(); }
        }
        if (enemies.length === 0 && stateTime > 30) setState('speaking');
      }
      if (currentState === 'speaking') { if (stateTime > 120) { setState('idle'); pickWanderTarget(); } }
      if (currentState === 'collaborating') {
        if (stateTime < 3) { if (Math.random() < 0.05) spawnEnemy(); }
        fireTimer += dt;
        if (targetEnemy && enemies.indexOf(targetEnemy) === -1) targetEnemy = findNearestEnemy();
        if (!targetEnemy) targetEnemy = findNearestEnemy();
        if (targetEnemy) {
          var cdx = targetEnemy.x-ship.x; var cdy = targetEnemy.y-ship.y; var cdist = Math.sqrt(cdx*cdx+cdy*cdy);
          if (cdist > 120) { ship.tx = targetEnemy.x; ship.ty = targetEnemy.y; }
          else { ship.tx = ship.x+cdy*0.5; ship.ty = ship.y-cdx*0.5; }
          if (fireTimer > 25) { fireTimer = 0; fireBullet(); }
        }
      }

      var thrustMag = Math.sqrt(ship.thrustDirX*ship.thrustDirX+ship.thrustDirY*ship.thrustDirY);
      if (thrustMag > 0.01) {
        var thrustAngle = Math.atan2(-ship.thrustDirY, -ship.thrustDirX);
        var emitX = ship.x+Math.cos(thrustAngle)*8; var emitY = ship.y+Math.sin(thrustAngle)*8;
        var trailAngle = thrustAngle+(Math.random()-0.5)*0.6; var trailSpeed = 0.5+Math.random()*1.5;
        particles.push({ x: emitX, y: emitY, vx: Math.cos(trailAngle)*trailSpeed, vy: Math.sin(trailAngle)*trailSpeed, life: 0.2+Math.random()*0.2, color: '#0ff', size: 1+Math.random() });
      }

      drawGrid(); drawBorder();
      for (var i = 0; i < asteroids.length; i++) drawAsteroid(asteroids[i]);
      drawBullets();
      for (var i = 0; i < enemies.length; i++) drawEnemy(enemies[i]);
      if (currentState === 'idle' && crystals.length === 0 && miningTarget && asteroids.indexOf(miningTarget) !== -1) {
        var mdx = miningTarget.x-ship.x; var mdy = miningTarget.y-ship.y;
        if (Math.sqrt(mdx*mdx+mdy*mdy) < 120) { var noseX = ship.x+Math.cos(ship.angle)*14; var noseY = ship.y+Math.sin(ship.angle)*14; drawMiningLaser(noseX, noseY, miningTarget.x, miningTarget.y); }
      }
      drawCrystals(); drawParticles(); drawShip(ship.x, ship.y, ship.angle);
    }

    window.addEventListener('resize', resize);
    resize(); initShip(); initAsteroids(); pickWanderTarget();
    requestAnimationFrame(frame);
  })();
  </script>
</body>
</html>`;

let server = null;
let watcher = null;
let heartbeatInterval = null;

module.exports.activate = function(ctx) {
    const eventsDir = path.join(ctx.getTinyClawHome(), 'events');
    if (!fs.existsSync(eventsDir)) {
        fs.mkdirSync(eventsDir, { recursive: true });
    }

    const sseClients = new Set();

    server = http.createServer((req, res) => {
        if (req.url === '/events') {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'Access-Control-Allow-Origin': '*',
            });
            res.write(':\n\n');
            sseClients.add(res);
            req.on('close', () => sseClients.delete(res));
            return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(GEOMETRY_HTML);
    });

    try {
        watcher = fs.watch(eventsDir, (eventType, filename) => {
            if (eventType !== 'rename' || !filename || !filename.endsWith('.json')) return;
            const filePath = path.join(eventsDir, filename);
            try {
                if (!fs.existsSync(filePath)) return;
                const content = fs.readFileSync(filePath, 'utf8').trim();
                if (!content) return;
                const data = 'data: ' + content + '\n\n';
                for (const client of sseClients) client.write(data);
            } catch {}
        });
    } catch {
        ctx.log('WARN', 'Could not watch events directory');
    }

    heartbeatInterval = setInterval(() => {
        for (const client of sseClients) client.write(':\\n\\n');
    }, 15000);

    server.listen(PORT, () => {
        ctx.log('INFO', 'Geometry Wars running at http://localhost:' + PORT);
    });

    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            ctx.log('WARN', 'Port ' + PORT + ' in use, geometry-wars server not started');
        } else {
            ctx.log('ERROR', 'Server error: ' + err.message);
        }
    });
};

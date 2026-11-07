/*
 * Home page mini games: ten tiny C64-style games on one 240x160 canvas.
 * One is picked at random on each load; "Another game" walks the shuffled rest.
 *
 * A game is { id, name, hint, bg, init(), update(s, input, g), draw(s, g) }.
 * The engine owns the title, game-over and best-score screens, and runs
 * update() at a fixed 60 steps per second whatever the display refresh rate.
 */
(function () {
  'use strict';

  var root = document.getElementById('mini-games');
  if (!root) return;
  var canvas = root.querySelector('canvas');
  var nextButton = root.querySelector('.mini-games-next');
  var ctx = canvas.getContext('2d');
  var W = canvas.width = 240;
  var H = canvas.height = 160;
  var STEP_MS = 1000 / 60;
  var KEY_LAST = 'miniGames.last';
  var KEY_BEST = 'miniGames.best';

  var C = {
    black: '#000000', white: '#FFFFFF', red: '#880000', cyan: '#AAFFEE',
    purple: '#CC44CC', green: '#00CC55', blue: '#0000AA', yellow: '#EEEE77',
    orange: '#DD8855', brown: '#664400', lightRed: '#FF7777', darkGrey: '#333333',
    grey: '#777777', lightGreen: '#AAFF66', lightBlue: '#0088FF', lightGrey: '#BBBBBB'
  };

  function rnd(a, b) { return a + Math.random() * (b - a); }
  function rndInt(n) { return Math.floor(Math.random() * n); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function rect(x, y, w, h, c) { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); }
  function circle(x, y, r, c) {
    ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  function text(s, x, y, c, size, align) {
    ctx.fillStyle = c;
    ctx.font = 'bold ' + (size || 10) + 'px monospace';
    ctx.textAlign = align || 'left';
    ctx.fillText(s, x, y);
  }
  function lives(n) { for (var i = 0; i < n; i++) rect(W - 10 - i * 8, 4, 6, 6, C.lightRed); }
  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = rndInt(i + 1), t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  // Horizontal steering shared by the games with a ship or paddle at the bottom.
  function steer(x, input, speed, min, max) {
    if (input.left) x -= speed;
    if (input.right) x += speed;
    if (input.pointer) x += clamp(input.x - x, -speed, speed);
    return clamp(x, min, max);
  }

  var GAMES = [
    {
      id: 'pong', name: 'PONG', hint: 'Move to steer the left paddle', bg: C.blue,
      autostart: true, hud: false,
      init: function () {
        return { l: 64, r: 64, a: 0, b: 0, x: W / 2, y: H / 2, vx: 2, vy: 1.5 };
      },
      update: function (s, input) {
        var ph = 32, pw = 6, size = 5;
        if (input.up) s.l -= 3;
        if (input.down) s.l += 3;
        if (input.pointer) s.l = input.y - ph / 2;
        s.l = clamp(s.l, 0, H - ph);
        var mid = s.r + ph / 2;
        if (s.y < mid - 5) s.r -= 1.9; else if (s.y > mid + 5) s.r += 1.9;
        s.r = clamp(s.r, 0, H - ph);

        s.x += s.vx; s.y += s.vy;
        if (s.y <= size) s.vy = Math.abs(s.vy);
        if (s.y >= H - size) s.vy = -Math.abs(s.vy);

        function bounce(top, dir) {
          s.vx = dir * Math.min(Math.abs(s.vx) * 1.05, 4.5);
          s.vy = clamp(s.vy + (s.y - (top + ph / 2)) * 0.1, -3.5, 3.5);
        }
        if (s.x <= pw + size && s.y >= s.l && s.y <= s.l + ph) bounce(s.l, 1);
        if (s.x >= W - pw - size && s.y >= s.r && s.y <= s.r + ph) bounce(s.r, -1);

        if (s.x < 0 || s.x > W) {
          if (s.x < 0) s.b++; else s.a++;
          s.x = W / 2; s.y = H / 2;
          s.vx = (Math.random() > 0.5 ? 1 : -1) * 2;
          s.vy = rnd(-1.5, 1.5);
        }
      },
      draw: function (s) {
        for (var y = 0; y < H; y += 8) rect(W / 2, y, 1, 4, C.lightGrey);
        rect(0, s.l, 6, 32, C.white);
        rect(W - 6, s.r, 6, 32, C.white);
        circle(s.x, s.y, 5, C.yellow);
        text(s.a, W / 4, 24, C.cyan, 18, 'center');
        text(s.b, 3 * W / 4, 24, C.cyan, 18, 'center');
      }
    },

    {
      id: 'snake', name: 'KV SNAKE', hint: 'Eat tokens, grow the cache', bg: C.black,
      init: function () {
        return {
          body: [{ x: 12, y: 10 }, { x: 11, y: 10 }, { x: 10, y: 10 }, { x: 9, y: 10 }],
          dx: 1, dy: 0, nx: 1, ny: 0, t: 0, every: 9, food: { x: 22, y: 10 }
        };
      },
      update: function (s, input, g) {
        var CELL = 8, COLS = 30, ROWS = 20;
        if (input.press === 'left' && s.dx !== 1) { s.nx = -1; s.ny = 0; }
        if (input.press === 'right' && s.dx !== -1) { s.nx = 1; s.ny = 0; }
        if (input.press === 'up' && s.dy !== 1) { s.nx = 0; s.ny = -1; }
        if (input.press === 'down' && s.dy !== -1) { s.nx = 0; s.ny = 1; }
        if (++s.t < s.every) return;
        s.t = 0;

        var head = s.body[0];
        function blocked(x, y) {
          return x < 0 || y < 0 || x >= COLS || y >= ROWS ||
            s.body.some(function (b) { return b.x === x && b.y === y; });
        }
        // With a pointer, take the legal move that gets closest to it, so mouse
        // and touch need no d-pad. Straight on wins ties.
        if (input.pointer) {
          var tx = Math.floor(input.x / CELL), ty = Math.floor(input.y / CELL), bestDist = Infinity;
          [[s.dx, s.dy], [s.dy, s.dx], [-s.dy, -s.dx]].forEach(function (m) {
            var cx = head.x + m[0], cy = head.y + m[1];
            var dist = Math.abs(cx - tx) + Math.abs(cy - ty);
            if (!blocked(cx, cy) && dist < bestDist) { bestDist = dist; s.nx = m[0]; s.ny = m[1]; }
          });
        }
        s.dx = s.nx; s.dy = s.ny;
        var nx = head.x + s.dx, ny = head.y + s.dy;
        if (blocked(nx, ny)) return g.over();

        s.body.unshift({ x: nx, y: ny });
        if (nx === s.food.x && ny === s.food.y) {
          g.score++;
          s.every = Math.max(4, 9 - Math.floor(g.score / 5));
          var free = [];
          for (var x = 0; x < COLS; x++) for (var y = 1; y < ROWS; y++) free.push({ x: x, y: y });
          free = free.filter(function (c) {
            return !s.body.some(function (b) { return b.x === c.x && b.y === c.y; });
          });
          if (!free.length) return g.over('CACHE FULL');
          s.food = free[rndInt(free.length)];
        } else {
          s.body.pop();
        }
      },
      draw: function (s) {
        rect(s.food.x * 8 + 1, s.food.y * 8 + 1, 6, 6, C.yellow);
        s.body.forEach(function (b, i) {
          rect(b.x * 8, b.y * 8, 7, 7, i ? C.green : C.lightGreen);
        });
      }
    },

    {
      id: 'breaker', name: 'BLOCK EVICT', hint: 'Clear the KV blocks', bg: C.blue,
      init: function () {
        var s = { x: W / 2, bx: 0, by: 0, vx: 0, vy: 0, speed: 2.2, lives: 3, wait: 40, bricks: [] };
        this.fill(s);
        return s;
      },
      fill: function (s) {
        var colors = [C.lightRed, C.orange, C.yellow, C.lightGreen];
        s.bricks = [];
        for (var r = 0; r < 4; r++) for (var c = 0; c < 10; c++) {
          s.bricks.push({ x: c * 24 + 1, y: 16 + r * 9, c: colors[r] });
        }
      },
      update: function (s, input, g) {
        var PW = 40, PY = 150;
        s.x = steer(s.x, input, 4, PW / 2, W - PW / 2);
        if (s.wait > 0) {
          s.bx = s.x; s.by = PY - 4;
          if (--s.wait === 0) { s.vx = rnd(-1, 1); s.vy = -Math.sqrt(s.speed * s.speed - s.vx * s.vx); }
          return;
        }
        s.bx += s.vx; s.by += s.vy;
        if (s.bx < 3) { s.bx = 3; s.vx = Math.abs(s.vx); }
        if (s.bx > W - 3) { s.bx = W - 3; s.vx = -Math.abs(s.vx); }
        if (s.by < 3) { s.by = 3; s.vy = Math.abs(s.vy); }

        if (s.vy > 0 && s.by >= PY - 3 && s.by <= PY + 4 && Math.abs(s.bx - s.x) <= PW / 2 + 2) {
          s.vx = clamp((s.bx - s.x) / (PW / 2), -1, 1) * s.speed * 0.8;
          s.vy = -Math.sqrt(s.speed * s.speed - s.vx * s.vx);
        }
        for (var i = 0; i < s.bricks.length; i++) {
          var b = s.bricks[i];
          if (s.bx > b.x - 2 && s.bx < b.x + 24 && s.by > b.y - 2 && s.by < b.y + 9) {
            s.bricks.splice(i, 1);
            s.vy = -s.vy;
            g.score++;
            break;
          }
        }
        if (!s.bricks.length) { this.fill(s); s.speed = Math.min(s.speed + 0.35, 4); s.wait = 40; }
        if (s.by > H) {
          if (--s.lives <= 0) return g.over();
          s.wait = 40;
        }
      },
      draw: function (s) {
        s.bricks.forEach(function (b) { rect(b.x, b.y, 22, 7, b.c); });
        rect(s.x - 20, 150, 40, 4, C.white);
        circle(s.bx, s.by, 3, C.yellow);
        lives(s.lives);
      }
    },

    {
      id: 'cave', name: 'HEAT TUNNEL', hint: 'Hold to climb, let go to fall', bg: C.black,
      init: function () {
        var cols = [];
        for (var i = 0; i < 62; i++) cols.push({ top: 25, bot: H - 25 });
        return { y: 80, vy: 0, cols: cols, off: 0, mid: 80, target: 80, gap: 110, n: 0, t: 0 };
      },
      update: function (s, input, g) {
        s.vy = clamp(s.vy + (input.held ? -0.17 : 0.13), -2.3, 2.3);
        s.y += s.vy;
        s.off += 1.7;
        while (s.off >= 4) {
          s.off -= 4;
          s.cols.shift();
          if (++s.n % 18 === 0) s.target = rnd(45, H - 45);
          s.mid += clamp(s.target - s.mid, -1.4, 1.4);
          s.gap = Math.max(52, s.gap - 0.04);
          s.cols.push({ top: s.mid - s.gap / 2, bot: s.mid + s.gap / 2 });
        }
        if (++s.t % 12 === 0) g.score++;
        var a = s.cols[Math.floor((40 + s.off) / 4)];
        var b = s.cols[Math.floor((50 + s.off) / 4)];
        if (s.y - 3 < Math.max(a.top, b.top) || s.y + 3 > Math.min(a.bot, b.bot)) g.over();
      },
      draw: function (s) {
        s.cols.forEach(function (c, i) {
          var x = i * 4 - s.off;
          rect(x, 0, 4.5, c.top, C.red);
          rect(x, c.bot, 4.5, H - c.bot, C.red);
        });
        rect(40, s.y - 3, 10, 6, C.cyan);
        rect(36, s.y - 1, 4, 2, C.orange);
      }
    },

    {
      id: 'meteor', name: 'TRAFFIC SPIKE', hint: 'Dodge the falling requests', bg: C.darkGrey,
      init: function () { return { x: W / 2, rocks: [], t: 0 }; },
      update: function (s, input, g) {
        s.x = steer(s.x, input, 3, 6, W - 6);
        if (--s.t <= 0) {
          s.t = Math.max(9, 30 - g.score / 2);
          s.rocks.push({ x: rnd(4, W - 4), y: -8, r: rnd(3, 7), v: rnd(1, 2) + Math.min(g.score * 0.01, 1.4) });
        }
        for (var i = s.rocks.length - 1; i >= 0; i--) {
          var m = s.rocks[i];
          m.y += m.v;
          var dx = m.x - s.x, dy = m.y - 148;
          if (dx * dx + dy * dy < (m.r + 4) * (m.r + 4)) return g.over();
          if (m.y > H + 8) { s.rocks.splice(i, 1); g.score++; }
        }
      },
      draw: function (s) {
        s.rocks.forEach(function (m) { circle(m.x, m.y, m.r, C.orange); });
        rect(s.x - 6, 150, 12, 4, C.white);
        rect(s.x - 2, 145, 4, 5, C.lightBlue);
      }
    },

    {
      id: 'blaster', name: 'BUG BLASTER', hint: 'Fires itself, you aim', bg: C.black,
      init: function () { return { x: W / 2, shots: [], bugs: [], t: 0, gun: 0, lives: 3, n: 0 }; },
      update: function (s, input, g) {
        s.x = steer(s.x, input, 4, 6, W - 6);
        s.n++;
        if (--s.gun <= 0) { s.gun = 16; s.shots.push({ x: s.x, y: 142 }); }
        if (--s.t <= 0) {
          s.t = Math.max(18, 60 - g.score);
          s.bugs.push({ x0: rnd(20, W - 20), y: -6, v: Math.min(0.4 + g.score * 0.01, 1.2), p: rnd(0, 6) });
        }
        s.shots = s.shots.filter(function (b) { b.y -= 4; return b.y > -4; });
        for (var i = s.bugs.length - 1; i >= 0; i--) {
          var b = s.bugs[i];
          b.y += b.v;
          b.x = b.x0 + Math.sin(s.n * 0.03 + b.p) * 18;
          var hit = -1;
          for (var j = 0; j < s.shots.length; j++) {
            if (Math.abs(s.shots[j].x - b.x) < 7 && Math.abs(s.shots[j].y - b.y) < 7) { hit = j; break; }
          }
          if (hit >= 0) { s.shots.splice(hit, 1); s.bugs.splice(i, 1); g.score++; continue; }
          var rammed = b.y > 142 && Math.abs(b.x - s.x) < 11;
          if (rammed || b.y > H) {
            s.bugs.splice(i, 1);
            if (--s.lives <= 0) return g.over();
          }
        }
      },
      draw: function (s) {
        s.bugs.forEach(function (b) {
          rect(b.x - 4, b.y - 3, 8, 6, C.green);
          rect(b.x - 7, b.y - 2, 2, 1, C.lightGreen); rect(b.x + 5, b.y - 2, 2, 1, C.lightGreen);
          rect(b.x - 7, b.y + 1, 2, 1, C.lightGreen); rect(b.x + 5, b.y + 1, 2, 1, C.lightGreen);
          rect(b.x - 2, b.y - 1, 1, 1, C.black); rect(b.x + 1, b.y - 1, 1, 1, C.black);
        });
        s.shots.forEach(function (b) { rect(b.x - 1, b.y - 3, 2, 6, C.yellow); });
        rect(s.x - 6, 150, 12, 4, C.white);
        rect(s.x - 1, 145, 2, 5, C.lightGrey);
        lives(s.lives);
      }
    },

    {
      id: 'whack', name: 'WHACK A BUG', hint: 'Hit the bug before it hides', bg: C.brown,
      init: function () { return { bug: -1, t: 20, ttl: 72, lives: 3, flash: 0, hit: -1, cur: 0, kb: false }; },
      cell: function (x, y) {
        var c = Math.floor((x - 15) / 70), r = Math.floor((y - 24) / 58);
        return c >= 0 && c < 3 && r >= 0 && r < 2 ? r * 3 + c : -1;
      },
      update: function (s, input, g) {
        if (input.press) {
          s.kb = true;
          if (input.press === 'left' && s.cur % 3) s.cur--;
          if (input.press === 'right' && s.cur % 3 < 2) s.cur++;
          if (input.press === 'up' && s.cur > 2) s.cur -= 3;
          if (input.press === 'down' && s.cur < 3) s.cur += 3;
        }
        var pick = input.pointerTap ? this.cell(input.x, input.y) : input.actionTap ? s.cur : -1;
        if (s.flash > 0) s.flash--;
        if (pick >= 0 && pick === s.bug) {
          g.score++;
          s.hit = pick; s.flash = 10;
          s.bug = -1; s.t = 14;
          s.ttl = Math.max(26, s.ttl - 2);
          return;
        }
        if (--s.t > 0) return;
        if (s.bug >= 0) {
          s.bug = -1; s.t = 14;
          if (--s.lives <= 0) g.over();
        } else {
          s.bug = rndInt(6); s.t = s.ttl;
        }
      },
      draw: function (s) {
        for (var i = 0; i < 6; i++) {
          var x = 15 + (i % 3) * 70, y = 24 + Math.floor(i / 3) * 58;
          rect(x + 8, y + 34, 54, 12, C.black);
          if (s.flash && s.hit === i) text('*', x + 35, y + 36, C.yellow, 26, 'center');
          if (s.bug === i) {
            rect(x + 23, y + 16, 24, 20, C.green);
            rect(x + 28, y + 22, 4, 4, C.white); rect(x + 38, y + 22, 4, 4, C.white);
            rect(x + 25, y + 11, 2, 5, C.lightGreen); rect(x + 43, y + 11, 2, 5, C.lightGreen);
          }
          if (s.kb && s.cur === i) {
            ctx.strokeStyle = C.cyan; ctx.strokeRect(x + 3.5, y + 6.5, 63, 45);
          }
        }
        lives(s.lives);
      }
    },

    {
      id: 'pairs', name: 'CACHE HIT', hint: 'Match all six pairs', bg: C.purple, hud: false,
      init: function () {
        var deck = shuffle([0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
        return { deck: deck, done: deck.map(function () { return false; }), open: [], lock: 0, moves: 0, cur: 0, kb: false };
      },
      cell: function (x, y) {
        var c = Math.floor((x - 31) / 46), r = Math.floor((y - 24) / 44);
        return c >= 0 && c < 4 && r >= 0 && r < 3 ? r * 4 + c : -1;
      },
      update: function (s, input, g) {
        if (input.press) {
          s.kb = true;
          if (input.press === 'left' && s.cur % 4) s.cur--;
          if (input.press === 'right' && s.cur % 4 < 3) s.cur++;
          if (input.press === 'up' && s.cur > 3) s.cur -= 4;
          if (input.press === 'down' && s.cur < 8) s.cur += 4;
        }
        if (s.lock > 0) {
          if (--s.lock === 0) s.open = [];
          return;
        }
        var pick = input.pointerTap ? this.cell(input.x, input.y) : input.actionTap ? s.cur : -1;
        if (pick < 0 || s.done[pick] || s.open.indexOf(pick) >= 0) return;
        s.open.push(pick);
        if (s.open.length < 2) return;
        s.moves++;
        var a = s.open[0], b = s.open[1];
        if (s.deck[a] === s.deck[b]) {
          s.done[a] = s.done[b] = true;
          s.open = [];
          if (s.done.every(Boolean)) {
            g.score = Math.max(10, 100 - (s.moves - 6) * 5);
            g.over('ALL CACHED');
          }
        } else {
          s.lock = 45;
        }
      },
      shape: function (kind, x, y) {
        var colors = [C.yellow, C.lightRed, C.lightGreen, C.cyan, C.orange, C.lightBlue];
        var c = colors[kind];
        if (kind === 0) circle(x, y, 8, c);
        if (kind === 1) rect(x - 8, y - 8, 16, 16, c);
        if (kind === 2) { rect(x - 9, y - 2, 18, 4, c); rect(x - 2, y - 9, 4, 18, c); }
        if (kind === 3) { rect(x - 9, y - 7, 18, 4, c); rect(x - 9, y + 3, 18, 4, c); }
        if (kind === 4) {
          ctx.fillStyle = c; ctx.beginPath();
          ctx.moveTo(x, y - 9); ctx.lineTo(x + 9, y + 8); ctx.lineTo(x - 9, y + 8); ctx.fill();
        }
        if (kind === 5) {
          ctx.fillStyle = c; ctx.beginPath();
          ctx.moveTo(x, y - 9); ctx.lineTo(x + 9, y); ctx.lineTo(x, y + 9); ctx.lineTo(x - 9, y); ctx.fill();
        }
      },
      draw: function (s) {
        for (var i = 0; i < 12; i++) {
          var x = 31 + (i % 4) * 46, y = 24 + Math.floor(i / 4) * 44;
          var up = s.done[i] || s.open.indexOf(i) >= 0;
          rect(x, y, 40, 38, s.done[i] ? C.darkGrey : up ? C.black : C.blue);
          if (up) this.shape(s.deck[i], x + 20, y + 19);
          else text('?', x + 20, y + 25, C.lightBlue, 16, 'center');
          if (s.kb && s.cur === i) { ctx.strokeStyle = C.white; ctx.strokeRect(x - 1.5, y - 1.5, 43, 41); }
        }
        text('MOVES ' + s.moves, 4, 14, C.white);
      }
    },

    {
      id: 'stack', name: 'RACK STACK', hint: 'Tap to drop the GPU', bg: C.blue,
      init: function () {
        return { rack: [{ x: 70, w: 100 }], x: 0, w: 100, dir: 1, v: 1.4, cam: 0 };
      },
      update: function (s, input, g) {
        s.x += s.dir * s.v;
        if (s.x < 0) { s.x = 0; s.dir = 1; }
        if (s.x + s.w > W) { s.x = W - s.w; s.dir = -1; }
        s.cam += (Math.max(0, s.rack.length - 10) * 10 - s.cam) * 0.15;
        if (!input.tap) return;

        var top = s.rack[s.rack.length - 1];
        var left = Math.max(s.x, top.x), right = Math.min(s.x + s.w, top.x + top.w);
        if (right - left <= 0) return g.over();
        // Close enough counts as perfect, otherwise nobody could keep the width.
        if (Math.abs(s.x - top.x) < 2.5) left = top.x; else s.w = right - left;
        s.rack.push({ x: left, w: s.w });
        g.score++;
        s.v = Math.min(s.v + 0.09, 4);
        s.dir = s.rack.length % 2 ? 1 : -1;
        s.x = s.dir > 0 ? 0 : W - s.w;
      },
      draw: function (s) {
        function unit(x, y, w, c) {
          rect(x, y, w, 9, c);
          rect(x + 2, y + 3, Math.min(3, w), 3, C.lightGreen);
        }
        var base = H - 10 + s.cam;
        s.rack.forEach(function (r, i) {
          var y = base - i * 10;
          if (y > -10 && y < H) unit(r.x, y, r.w, i % 2 ? C.lightGrey : C.grey);
        });
        unit(s.x, base - s.rack.length * 10, s.w, C.yellow);
      }
    },

    {
      id: 'runner', name: 'PIXEL COURIER', hint: 'Tap to jump the crates', bg: C.lightBlue,
      init: function () { return { y: 0, vy: 0, crates: [], gap: 60, v: 2, t: 0 }; },
      update: function (s, input, g) {
        var GROUND = 136, PX = 30, PW = 10, PH = 12;
        if ((input.tap || input.held) && s.y === 0) s.vy = -4.3;
        s.vy += 0.22;
        s.y = Math.min(0, s.y + s.vy);
        if (s.y === 0) s.vy = 0;

        s.v = Math.min(s.v + 0.0008, 4.4);
        if (++s.t % 6 === 0) g.score++;
        s.gap -= s.v;
        if (s.gap <= 0) {
          s.crates.push({ x: W, w: 8 + rndInt(8), h: 10 + rndInt(11) });
          s.gap = rnd(s.v * 48, s.v * 90);
        }
        for (var i = s.crates.length - 1; i >= 0; i--) {
          var c = s.crates[i];
          c.x -= s.v;
          if (c.x + c.w < 0) { s.crates.splice(i, 1); continue; }
          var feet = GROUND + s.y;
          if (c.x < PX + PW && c.x + c.w > PX && feet > GROUND - c.h && feet - PH < GROUND) return g.over();
        }
      },
      draw: function (s) {
        rect(0, 136, W, 24, C.green);
        s.crates.forEach(function (c) {
          rect(c.x, 136 - c.h, c.w, c.h, C.brown);
          rect(c.x + 2, 138 - c.h, c.w - 4, 1, C.orange);
        });
        var y = 124 + s.y;
        rect(30, y, 10, 12, C.white);
        rect(36, y + 3, 2, 2, C.black);
      }
    }
  ];

  /* Engine */

  var input = {
    x: W / 2, y: H / 2, pointer: false, held: false, moved: false,
    tap: false, pointerTap: false, actionTap: false, press: null,
    left: false, right: false, up: false, down: false, action: false, touching: false
  };
  var order = [], index = 0;
  var game = null, scene = null, mode = 'ready', tick = 0, wait = 0;
  var api = { score: 0, over: gameOver, message: 'GAME OVER' };
  var best = readBest();

  function storageGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function storageSet(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* private mode */ } }
  function readBest() {
    try { return JSON.parse(storageGet(KEY_BEST)) || {}; } catch (e) { return {}; }
  }

  function load(g) {
    game = g;
    canvas.setAttribute('aria-label', 'Mini game: ' + g.name + '. ' + g.hint + '.');
    storageSet(KEY_LAST, g.id);
    begin(g.autostart && !window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'play' : 'ready');
  }

  function begin(next) {
    api.score = 0;
    api.message = 'GAME OVER';
    scene = game.init();
    mode = next;
  }

  function gameOver(message) {
    if (mode !== 'play') return;
    if (message) api.message = message;
    mode = 'over';
    wait = 30;
    if (api.score > (best[game.id] || 0)) {
      best[game.id] = api.score;
      storageSet(KEY_BEST, JSON.stringify(best));
    }
  }

  function step() {
    tick++;
    input.held = input.touching || input.action;
    if (mode === 'play') {
      game.update(scene, input, api);
    } else if (wait > 0) {
      wait--;
    } else if (input.tap) {
      begin('play');
    }
    input.tap = input.pointerTap = input.actionTap = input.moved = false;
    input.press = null;
  }

  function draw() {
    rect(0, 0, W, H, game.bg);
    game.draw(scene, api);
    if (mode === 'play' && game.hud !== false) text(api.score, 4, 12, C.white);
    if (mode === 'play') return;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.72)';
    ctx.fillRect(0, 0, W, H);
    var blink = Math.floor(tick / 30) % 2 === 0;
    if (mode === 'ready') {
      text(game.name, W / 2, 62, C.yellow, 18, 'center');
      text(game.hint, W / 2, 84, C.lightGrey, 10, 'center');
      if (blink) text('TAP OR PRESS SPACE', W / 2, 112, C.cyan, 10, 'center');
    } else {
      text(api.message, W / 2, 58, C.lightRed, 18, 'center');
      text('SCORE ' + api.score + '   BEST ' + (best[game.id] || 0), W / 2, 84, C.white, 10, 'center');
      if (blink && wait === 0) text('TAP TO RETRY', W / 2, 112, C.cyan, 10, 'center');
    }
  }

  function locate(e) {
    var r = canvas.getBoundingClientRect();
    input.x = (e.clientX - r.left) * W / r.width;
    input.y = (e.clientY - r.top) * H / r.height;
    input.pointer = true;
    input.moved = true;
  }

  function bindInput() {
    canvas.addEventListener('pointermove', locate);
    canvas.addEventListener('pointerdown', function (e) {
      locate(e);
      input.touching = true;
      input.tap = input.pointerTap = true;
      canvas.focus({ preventScroll: true });
      if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    function release() { input.touching = false; }
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
    canvas.addEventListener('blur', function () {
      release();
      input.left = input.right = input.up = input.down = input.action = false;
    });

    var KEYS = {
      arrowleft: 'left', a: 'left', arrowright: 'right', d: 'right',
      arrowup: 'up', w: 'up', arrowdown: 'down', s: 'down', ' ': 'action', enter: 'action'
    };
    // Keys only count while the canvas has focus, so the page still scrolls normally.
    canvas.addEventListener('keydown', function (e) {
      var name = KEYS[e.key.toLowerCase()];
      if (!name || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      if (e.repeat) return;
      input[name] = true;
      input.pointer = false;
      if (name === 'action') input.tap = input.actionTap = true;
      else input.press = name;
    });
    canvas.addEventListener('keyup', function (e) {
      var name = KEYS[e.key.toLowerCase()];
      if (name) input[name] = false;
    });

    if (nextButton) {
      nextButton.addEventListener('click', function () {
        index = (index + 1) % order.length;
        load(order[index]);
        canvas.focus({ preventScroll: true });
      });
    }
  }

  function run() {
    var last = 0, pending = 0, visible = true, running = false;
    function frame(now) {
      if (!visible) { running = false; return; }
      pending += Math.min(now - (last || now), 100);
      last = now;
      while (pending >= STEP_MS) { step(); pending -= STEP_MS; }
      draw();
      requestAnimationFrame(frame);
    }
    function start() {
      if (running) return;
      running = true;
      last = 0;
      requestAnimationFrame(frame);
    }
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        visible = entries[0].isIntersecting;
        if (visible) start();
      }).observe(canvas);
    }
    start();
  }

  function mount() {
    order = shuffle(GAMES.slice());
    var lastId = storageGet(KEY_LAST);
    if (order[0].id === lastId) order.push(order.shift());
    bindInput();
    load(order[0]);
    draw();
    run();
  }

  mount();
})();

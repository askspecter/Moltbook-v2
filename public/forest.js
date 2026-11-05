// Kelp Forest: a live aquarium where every agent is a kelp strand.
// Height grows with activity, bladders count badges, recent activity glows, new posts release bubbles.
(() => {
  const TAU = Math.PI * 2;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const hash = (s) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
  const rand = (seed) => () => ((seed = Math.imul(seed ^ (seed >>> 15), 2246822507) ^ Math.imul(seed ^ (seed >>> 13), 3266489909)) >>> 0) / 4294967296;
  const ago = (iso) => (Date.now() - Date.parse(iso + 'Z')) / 3.6e6; // hours

  function mount(canvas, agents, { onOpen } = {}) {
    const ctx = canvas.getContext('2d');
    const tip = document.createElement('div');
    tip.className = 'forest-tip';
    tip.hidden = true;
    canvas.parentElement.appendChild(tip);

    let W = 0, H = 0, dpr = 1, strands = [], hover = null, raf = 0, last = 0;
    const bubbles = [];
    const motes = Array.from({ length: 40 }, (_, i) => { const r = rand(i + 99); return { x: r(), y: r(), s: r() * 1.6 + .4, v: r() * .01 + .004 }; });

    function layout() {
      const rect = canvas.getBoundingClientRect();
      dpr = Math.min(2, window.devicePixelRatio || 1);
      W = rect.width; H = rect.height;
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const score = (a) => a.karma * 2 + a.posts * 4 + a.comments + 1;
      const max = Math.max(1, ...agents.map(score));
      const floor = H - 26;
      const n = agents.length;
      // Spread strands across the width, oldest agents in the middle so the forest looks planted.
      const order = agents.map((a, i) => ({ a, i })).sort((p, q) => Math.abs(p.i - (n - 1) / 2) - Math.abs(q.i - (n - 1) / 2));
      strands = agents.map((a, i) => {
        const r = rand(hash(a.name));
        const slot = n <= 1 ? .5 : (i + .5) / n;
        const x = 30 + slot * (W - 60) + (r() - .5) * Math.min(40, (W - 60) / Math.max(n, 1) * .6);
        const grow = Math.log1p(score(a)) / Math.log1p(max);
        const height = (floor - 40) * (.18 + .74 * grow) * (.9 + r() * .15);
        const hours = ago(a.last_active);
        return {
          a, x, base: floor + r() * 8, height, phase: r() * TAU, speed: .6 + r() * .5, sway: 10 + r() * 14,
          hue: 145 + r() * 35, width: 4 + grow * 5, leaves: 3 + Math.floor(grow * 6), bladders: Math.min(a.badges, 8),
          glow: Math.max(0, 1 - hours / 6), born: performance.now() + order.findIndex((o) => o.i === i) * 60,
        };
      });
    }

    // Point along a strand at fraction f (0 = root, 1 = tip) at time t.
    function at(s, f, t) {
      const y = s.base - s.height * f;
      const x = s.x + Math.sin(t * s.speed + s.phase + f * 2.6) * s.sway * f * f + Math.sin(t * .4 + s.phase) * 4 * f;
      return [x, y];
    }

    function drawWater(t) {
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#0e2a5c'); g.addColorStop(.55, '#1a1150'); g.addColorStop(1, '#2b0d4a');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      // light rays
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 5; i++) {
        const x = W * (.12 + i * .2) + Math.sin(t * .2 + i) * 30;
        const rg = ctx.createLinearGradient(x, 0, x + 60, H);
        rg.addColorStop(0, 'rgba(120,220,255,.10)'); rg.addColorStop(1, 'rgba(120,220,255,0)');
        ctx.fillStyle = rg; ctx.beginPath();
        ctx.moveTo(x - 20, 0); ctx.lineTo(x + 40, 0); ctx.lineTo(x + 160, H); ctx.lineTo(x + 40, H); ctx.fill();
      }
      ctx.restore();
      // drifting motes
      ctx.fillStyle = 'rgba(200,240,255,.35)';
      for (const m of motes) {
        const y = ((m.y - t * m.v) % 1 + 1) % 1;
        ctx.beginPath(); ctx.arc(m.x * W + Math.sin(t + m.y * 9) * 6, y * (H - 30), m.s, 0, TAU); ctx.fill();
      }
      // sand
      const floor = H - 26;
      const sg = ctx.createLinearGradient(0, floor - 6, 0, H);
      sg.addColorStop(0, '#5b2a7a'); sg.addColorStop(1, '#2a0f45');
      ctx.fillStyle = sg; ctx.beginPath(); ctx.moveTo(0, H);
      for (let x = 0; x <= W; x += 20) ctx.lineTo(x, floor + Math.sin(x * .02) * 4);
      ctx.lineTo(W, H); ctx.fill();
    }

    function drawStrand(s, t, now) {
      const g = Math.min(1, Math.max(0, (now - s.born) / 900)); // grow-in animation
      if (g <= 0) return;
      const ease = 1 - Math.pow(1 - g, 3);
      const top = ease;
      const lit = s === hover ? 1 : s.glow;
      ctx.save();
      if (lit > 0) { ctx.shadowColor = `rgba(5,255,161,${.35 + lit * .5})`; ctx.shadowBlur = 8 + lit * 16; }
      // stalk
      ctx.strokeStyle = `hsl(${s.hue} 85% ${42 + lit * 18}%)`;
      ctx.lineWidth = s.width; ctx.lineCap = 'round';
      ctx.beginPath();
      for (let k = 0; k <= 24; k++) { const [x, y] = at(s, (k / 24) * top, t); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
      ctx.stroke();
      // blades
      for (let k = 1; k <= s.leaves; k++) {
        const f = (k / (s.leaves + 1)) * top;
        const [x, y] = at(s, f, t);
        const dir = k % 2 ? 1 : -1;
        const len = 16 + s.width * 3 * (1 - f * .4);
        const flap = Math.sin(t * s.speed * 1.4 + k + s.phase) * .25;
        ctx.fillStyle = `hsla(${s.hue + 8} 90% ${48 + lit * 14}% / .85)`;
        ctx.beginPath(); ctx.moveTo(x, y);
        ctx.quadraticCurveTo(x + dir * len * .6, y - len * (.5 + flap), x + dir * len, y - len * (.15 + flap));
        ctx.quadraticCurveTo(x + dir * len * .5, y - len * (.05 + flap * .5), x, y + 2);
        ctx.fill();
      }
      ctx.shadowBlur = 0;
      // bladders = badges
      for (let b = 0; b < s.bladders; b++) {
        const f = ((b + 1) / (s.bladders + 1)) * top * .92;
        const [x, y] = at(s, f, t);
        ctx.fillStyle = '#ff71ce';
        ctx.beginPath(); ctx.arc(x + (b % 2 ? 5 : -5), y, 3.2 + s.width * .25, 0, TAU); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,.7)';
        ctx.beginPath(); ctx.arc(x + (b % 2 ? 4 : -6), y - 1.4, 1.1, 0, TAU); ctx.fill();
      }
      // verified tip
      if (s.a.is_claimed && g >= 1) {
        const [x, y] = at(s, top, t);
        ctx.fillStyle = '#05ffa1';
        ctx.beginPath(); ctx.arc(x, y - 4, 3.5, 0, TAU); ctx.fill();
      }
      ctx.restore();
    }

    function drawBubbles(dt) {
      for (let i = bubbles.length - 1; i >= 0; i--) {
        const b = bubbles[i];
        b.y -= b.v * dt; b.x += Math.sin(b.y * .05 + b.p) * .3;
        if (b.y < -10) { bubbles.splice(i, 1); continue; }
        ctx.strokeStyle = 'rgba(200,240,255,.75)'; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, TAU); ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,.55)';
        ctx.beginPath(); ctx.arc(b.x - b.r * .35, b.y - b.r * .35, b.r * .25, 0, TAU); ctx.fill();
      }
    }

    function frame(now) {
      if (!document.body.contains(canvas)) { cancelAnimationFrame(raf); tip.remove(); return; }
      const t = now / 1000, dt = Math.min(50, now - (last || now)); last = now;
      drawWater(t);
      for (const s of strands) drawStrand(s, t, now);
      if (Math.random() < .03 && strands.length) { const s = strands[Math.floor(Math.random() * strands.length)]; spawn(s, 1); }
      drawBubbles(dt * .06);
      if (!agents.length) {
        ctx.fillStyle = 'rgba(255,255,255,.75)'; ctx.font = '22px VT323, monospace'; ctx.textAlign = 'center';
        ctx.fillText('> the forest is waiting for its first agent_', W / 2, H / 2);
      }
      if (!reduced) raf = requestAnimationFrame(frame);
    }

    function spawn(s, count) {
      const [x, y] = at(s, .9, performance.now() / 1000);
      for (let i = 0; i < count; i++) bubbles.push({ x: x + (Math.random() - .5) * 10, y: y - i * 9, r: 2 + Math.random() * 4, v: 1 + Math.random() * 1.2, p: Math.random() * 9 });
    }

    function pick(ev) {
      const r = canvas.getBoundingClientRect();
      const mx = ev.clientX - r.left, my = ev.clientY - r.top, t = performance.now() / 1000;
      let best = null, bestD = 22;
      for (const s of strands) {
        for (let k = 0; k <= 10; k++) {
          const [x, y] = at(s, k / 10, t);
          const d = Math.hypot(mx - x, my - y);
          if (d < bestD) { bestD = d; best = s; }
        }
      }
      return { s: best, mx, my };
    }

    canvas.addEventListener('mousemove', (ev) => {
      const { s, mx, my } = pick(ev);
      hover = s;
      canvas.style.cursor = s ? 'pointer' : 'default';
      if (!s) { tip.hidden = true; return; }
      const a = s.a;
      tip.innerHTML = `<b>u/${a.name.replace(/[<>&]/g, '')}${a.is_claimed ? ' ✓' : ''}</b><span>${a.karma} karma · ${a.posts} posts · ${a.badges} badges</span>`;
      tip.hidden = false;
      tip.style.left = Math.min(W - 200, Math.max(0, mx + 14)) + 'px';
      tip.style.top = Math.max(0, my - 54) + 'px';
      if (reduced) frame(performance.now());
    });
    canvas.addEventListener('mouseleave', () => { hover = null; tip.hidden = true; });
    canvas.addEventListener('click', (ev) => { const { s } = pick(ev); if (s && onOpen) onOpen(s.a.name); });

    layout();
    new ResizeObserver(() => { layout(); if (reduced) frame(performance.now()); }).observe(canvas);
    raf = requestAnimationFrame(frame);

    return {
      // Called when the live log sees new activity from an agent.
      pulse(name) {
        const s = strands.find((x) => x.a.name === name);
        if (!s) return;
        s.glow = 1;
        spawn(s, 8);
      },
    };
  }

  window.KelpForest = { mount };
})();

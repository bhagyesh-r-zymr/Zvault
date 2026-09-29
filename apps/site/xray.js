// The X-ray story and the blueprint band. Scroll drives everything; the lens follows the pointer.
// No inline styles anywhere: the site's CSP forbids them, so styles are set through the CSSOM.
(function () {
  const $ = (s) => document.querySelector(s),
    $$ = (s) => [...document.querySelectorAll(s)];
  const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (RM) document.documentElement.classList.add('rm');
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const sm = (a, b, x) => {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  const rnd = (n) => {
    let s = '';
    for (let i = 0; i < n; i++) s += B64[(Math.random() * 64) | 0];
    return s;
  };
  const END = 10,
    PW = 'Tq7#vR2m!xLp9';

  const story = $('#story'),
    nav = $('#nav');
  const applyCss = (root) =>
    root.querySelectorAll('[data-css]').forEach((el) => {
      el.style.cssText = el.dataset.css;
      el.removeAttribute('data-css');
    });
  $$('[data-d]').forEach((el) => el.style.setProperty('--d', el.dataset.d + 's'));
  function navState() {
    const r = story.getBoundingClientRect(),
      dark = r.top <= 58 && r.bottom > 58;
    nav.classList.toggle('dark', dark);
    nav.classList.toggle('solid', !dark && scrollY > 8);
  }
  const stage = $('#stage'),
    outerW = $('#outerW'),
    innerW = $('#innerW'),
    mask = $('#innerMask'),
    ring = $('#ring'),
    read = $('#read'),
    readT = $('#read span');
  const cvs = $('#wall'),
    ctx = cvs.getContext('2d');
  // word-by-word headline split
  $$('.ws').forEach((h) => {
    let i = 0;
    const walk = (n) => {
      [...n.childNodes].forEach((c) => {
        if (c.nodeType === 3) {
          const parts = c.textContent.split(/(\s+)/);
          const fr = document.createDocumentFragment();
          parts.forEach((p) => {
            if (!p) return;
            if (/^\s+$/.test(p)) {
              fr.appendChild(document.createTextNode(' '));
              return;
            }
            const s = document.createElement('span');
            s.className = 'w';
            s.style.setProperty('--i', i++);
            s.textContent = p;
            fr.appendChild(s);
          });
          c.replaceWith(fr);
        } else walk(c);
      });
    };
    walk(h);
  });
  const caps = $$('.cap').map((c) => ({ el: c, a: +c.dataset.a, b: +c.dataset.b }));
  const railS = $$('#rail span');
  let W,
    H,
    compact,
    ZX,
    ZY,
    FR,
    R,
    dpr,
    lensR = 150;

  // ---------- build zones ----------
  function build() {
    const fr = FR;
    const place = (i, k) =>
      `left:${i * W + ZX - fr[k][0] / 2}px;top:${ZY - fr[k][1] / 2}px;width:${fr[k][0]}px;height:${fr[k][1]}px`;
    const srvUnits = (inner) => {
      const h = fr.srv[1],
        uh = (h - 110) / 3;
      let s = '';
      for (let u = 0; u < 3; u++) {
        s += inner
          ? `<div class="u" data-css="top:${u * (uh + 8)}px;height:${uh}px"><pre data-ct></pre></div>`
          : `<div class="o-unit" data-css="top:${u * (uh + 8)}px;height:${uh}px"></div>`;
      }
      return s;
    };
    const recTop = fr.srv[1] - 86;
    const urlPath = 'https://vault.acme.dev/share/',
      frag = compact ? '#k3v9…Xq7…key' : '#k3v9x2…id.Xq7mPf…key';
    outerW.innerHTML = `
  <div class="frame" data-css="${place(0, 'mac')}"><div class="flab"><b>Priya's Mac</b> holds the keys</div><div class="o-box"></div><div class="o-bar"><div class="o-dots"><i></i><i></i><i></i></div></div></div>
  <div class="frame" data-css="${place(1, 'srv')}"><div class="flab"><b>Zvault server</b> ciphertext only</div>${srvUnits(false)}<div class="o-unit" data-css="top:${recTop}px;bottom:0;height:auto"></div></div>
  <div class="frame" data-css="${place(2, 'lk')}"><div class="flab"><b>The link</b> as our server receives it</div><div class="lk o"><div class="bar">${compact ? '…/share/' : urlPath}<span data-css="opacity:.55">&nbsp;# (fragment not sent)</span></div></div></div>
  <div class="frame" data-css="${place(3, 'brw')}"><div class="flab"><b>Sam's browser</b> key from the #fragment</div><div class="o-box"></div><div class="o-bar"><div class="o-dots"><i></i><i></i><i></i></div><div class="o-addr"></div></div></div>`;
    innerW.innerHTML = `
  <div class="frame" data-css="${place(0, 'mac')}"><div class="win"><div class="bar"><i></i><i></i><i></i><span>Zvault</span></div>
    <div class="mac-body"><div class="side"><div class="h">Payments API · prod</div>
      <div class="it on"><div class="tl" data-css="background:#10204a">P</div><div>Prod DB<small>postgres</small></div></div>
      <div class="it"><div class="tl" data-css="background:#e0573f">S</div><div>Stripe live<small>api key</small></div></div>
      <div class="it"><div class="tl" data-css="background:#2fa37a">G</div><div>Deploy key<small>ssh</small></div></div></div>
      <div class="det"><div class="hd"><div class="tl" data-css="background:#10204a">P</div><b>Prod DB</b><span class="tag">prod</span></div>
        <div class="flds"><div><small>username</small><span>postgres</span></div><div class="pw"><small>password</small><span>${PW}</span></div><div><small>host</small><span>db.acme.internal:5432</span></div></div>
        <div class="sheet" id="sheet"><b>Share “Prod DB”</b><div class="r"><span>Expires</span><span>1 day</span></div><div class="r"><span>Views</span><span>1</span></div><div class="r"><span>Only</span><span>sam@acme.dev</span></div>
          <div class="sbtn"><i id="sbar"></i><span id="stxt">Create link</span></div></div>
      </div></div></div></div>
  <div class="frame" data-css="${place(1, 'srv')}"><div class="srv"><div class="blind">● even we can't see through</div>${srvUnits(true)}
    <div class="rec" data-css="top:${recTop}px"><b>share</b> 7f3a9c · <b>ct</b> 412 B · <b>views</b> <span id="vleft">1 left</span><br><b>key</b> <span class="no">— not stored</span> · <b>expires</b> 1 day</div></div></div>
  <div class="frame" data-css="${place(2, 'lk')}"><div class="lk i"><div class="bar">${compact ? '…/share/' : urlPath}<span class="f" id="ifrag">${frag}</span></div>
    <div class="br" id="brP" data-css="color:#8a93ad"></div><div class="cap2" id="capP" data-css="color:#a3aecb">sent to server</div>
    <div class="br" id="brF" data-css="color:#7d9dff"></div><div class="cap2" id="capF" data-css="color:#7d9dff">never leaves the browser</div></div></div>
  <div class="frame brw" data-css="${place(3, 'brw')}"><div class="win"><div class="bar"><i></i><i></i><i></i><div class="addr">vault.acme.dev/share/<span class="f">${compact ? '#k3v9…' : '#k3v9x2…id.Xq7mPf…key'}</span></div></div>
    <div class="page"><div class="card">
      <div class="st" data-st="0"><h5>Priya shared a secret with you</h5><p>This link is for a verified email. We'll send you a code.</p><div class="inp">sam@acme.dev</div><div class="btnb">Send code</div></div>
      <div class="st" data-st="1"><h5>Enter your code</h5><p>Sent to sam@acme.dev · valid 10 minutes</p><div class="bx" id="bx"><span></span><span></span><span></span><span></span><span></span><span></span></div></div>
      <div class="st" data-st="2"><h5>Prod DB <span class="tag">prod</span></h5><p>postgres · shared by priya@acme.dev</p><div class="pwv" id="pwv"></div><div class="ok">decrypted here · 1 of 1 views used</div></div>
      <div class="st" data-st="3"><h5>This link has expired</h5><p>1 of 1 views used. Ask Priya for a new link.</p><div class="pwv" data-css="color:#8a93ad">•••••••••••••</div><div class="ok c">nothing left to open</div></div>
    </div></div></div></div>`;
    applyCss(outerW);
    applyCss(innerW);
    // link brackets geometry
    const lkI = innerW.querySelector('.lk.i'),
      bar = lkI.querySelector('.bar'),
      f = $('#ifrag');
    const fx = f.offsetLeft,
      fw = Math.min(f.offsetWidth, bar.clientWidth - fx - 14);
    const pb = $('#brP'),
      cp = $('#capP'),
      fb = $('#brF'),
      cf = $('#capF');
    pb.style.left = '26px';
    pb.style.width = fx - 34 + 'px';
    cp.style.left = '26px';
    fb.style.left = fx + 'px';
    fb.style.width = fw + 'px';
    cf.style.left = Math.max(0, fx + fw - cf.offsetWidth) + 'px';
    if (compact) {
      cp.style.top = '104px';
      pb.style.display = 'none';
      cp.textContent = 'before # → sent to server';
      cf.style.top = '80px';
      cf.style.left = '0';
    }
  }
  function layout() {
    W = stage.clientWidth;
    H = stage.clientHeight;
    compact = W < 760;
    dpr = Math.min(2, devicePixelRatio || 1);
    if (compact) {
      ZX = W / 2;
      ZY = H * 0.63;
      const fw = W - 32;
      FR = { mac: [fw, 300], srv: [fw, 330], lk: [fw, 130], brw: [fw, 360] };
      R = 112;
    } else {
      ZX = W * 0.66;
      ZY = H * 0.52;
      FR = { mac: [620, 390], srv: [440, 390], lk: [640, 120], brw: [600, 400] };
      R = 172;
    }
    lensR = R;
    cvs.width = W * dpr;
    cvs.height = H * dpr;
    outerW.style.width = innerW.style.width = 4 * W + 'px';
    build();
    initWall();
    ctEls = $$('[data-ct]');
    fillCt(true);
    ring.style.width = ring.style.height = R * 2 + 'px';
  }
  // ---------- ciphertext wall ----------
  let rows = [],
    FS,
    LH,
    CW;
  function initWall() {
    FS = compact ? 11 : 13;
    LH = compact ? 16 : 18;
    ctx.font = `${FS}px "JetBrains Mono", monospace`;
    CW = ctx.measureText('M').width || FS * 0.6;
    const n = Math.ceil(H / LH) + 1,
      len = Math.ceil((W * 1.2) / CW) + 40;
    rows = [];
    for (let i = 0; i < n; i++)
      rows.push({
        s: rnd(len).split(''),
        v: (8 + Math.random() * 16) * (i % 2 ? 1 : -1),
        a: 0.1 + Math.random() * 0.13,
      });
  }
  function drawWall(time, camX) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.font = `${FS}px "JetBrains Mono", monospace`;
    ctx.textBaseline = 'top';
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i],
        str = r.s.join(''),
        rw = r.s.length * CW;
      let off = (((time * r.v - camX * 0.35) % rw) + rw) % rw;
      ctx.fillStyle = `rgba(125,148,210,${r.a})`;
      for (let x = off - rw; x < W; x += rw) ctx.fillText(str, x, i * LH + 2);
    }
  }
  function mutate(k) {
    for (let j = 0; j < k; j++) {
      const r = rows[(Math.random() * rows.length) | 0];
      if (r) r.s[(Math.random() * r.s.length) | 0] = B64[(Math.random() * 64) | 0];
    }
  }
  let ctEls = [];
  function fillCt(all) {
    ctEls.forEach((el) => {
      const cols = Math.floor((el.clientWidth || 300) / ((compact ? 11 : 12) * 0.6)),
        rs = Math.max(1, Math.floor((el.clientHeight || 40) / 16));
      if (all || !el._l) {
        el._l = [];
        for (let i = 0; i < rs; i++) el._l.push(rnd(cols).split(''));
      } else {
        for (let j = 0; j < 6; j++) {
          const l = el._l[(Math.random() * el._l.length) | 0];
          l[(Math.random() * l.length) | 0] = B64[(Math.random() * 64) | 0];
        }
      }
      el.textContent = el._l.map((l) => l.join('')).join('\n');
    });
  }

  // ---------- story ----------
  function zoneF(t) {
    if (t < 3.0) return 0;
    if (t < 3.7) return ease((t - 3.0) / 0.7);
    if (t < 5.25) return 1;
    if (t < 5.95) return 1 + ease((t - 5.25) / 0.7);
    if (t < 7.05) return 2;
    if (t < 7.75) return 2 + ease((t - 7.05) / 0.7);
    return 3;
  }
  function vis(a, b, t) {
    const i = a <= 0 ? 1 : sm(a + 0.02, a + 0.28, t),
      o = b >= END ? 1 : 1 - sm(b - 0.16, b + 0.02, t);
    return i * o;
  }
  let lastFr = -1,
    activeCap = -1;
  function seek(t, time, lens, capT) {
    const zf = zoneF(t),
      camX = zf * W;
    outerW.style.transform = innerW.style.transform = `translate3d(${(-camX).toFixed(1)}px,0,0)`;
    // mac sheet
    const sh = $('#sheet'),
      sv = sm(1.45, 1.8, t);
    sh.style.opacity = sv.toFixed(3);
    sh.style.transform = `translateX(${(16 * (1 - sv)).toFixed(1)}px)`;
    const enc = sm(2.2, 2.8, t);
    $('#sbar').style.width = (enc * 100).toFixed(1) + '%';
    $('#stxt').textContent =
      t < 2.2 ? 'Create link' : t < 2.8 ? 'Encrypting on this Mac…' : 'Link copied ✓';
    // server views
    $('#vleft').textContent = t >= 9.4 ? '0 left · expired' : '1 left';
    // browser states
    const S = [
      [7.0, 7.95],
      [7.95, 8.55],
      [8.55, 9.4],
      [9.4, END],
    ];
    $$('.st').forEach((el, i) => {
      const v = i === 0 ? (t < 7.95 ? 1 : 1 - sm(7.8, 7.95, t)) : vis(S[i][0], S[i][1], t);
      el.style.opacity = v.toFixed(3);
      el.style.filter = v < 0.98 ? `blur(${((1 - v) * 6).toFixed(1)}px)` : 'none';
    });
    const bx = $$('#bx span');
    bx.forEach((b, k) => {
      const d = 8.08 + k * 0.065;
      b.textContent = t >= d ? '482917'[k] : '';
      b.style.boxShadow =
        t >= d
          ? 'inset 0 0 0 1px #c9d6f5'
          : t >= d - 0.065 && t > 8.0
            ? 'inset 0 0 0 1.5px #2f63d9'
            : '';
    });
    const fr = Math.floor(time * 24);
    if (fr !== lastFr) {
      lastFr = fr;
      let pw = '';
      for (let k = 0; k < PW.length; k++) {
        const at = 8.6 + k * 0.02;
        pw += t >= at ? PW[k] : B64[(Math.random() * 64) | 0];
      }
      $('#pwv').textContent = pw;
    }
    // lens
    const lx = lens.x,
      ly = lens.y;
    const R = lensR,
      m = `radial-gradient(circle ${R.toFixed(1)}px at ${lx.toFixed(1)}px ${ly.toFixed(1)}px, #000 0, #000 ${(R - 22).toFixed(1)}px, transparent ${R.toFixed(1)}px)`;
    ring.style.width = ring.style.height = (R * 2).toFixed(1) + 'px';
    mask.style.webkitMaskImage = m;
    mask.style.maskImage = m;
    ring.style.transform = `translate(${(lx - R).toFixed(1)}px,${(ly - R).toFixed(1)}px)`;
    // readout
    const wx = lx + camX,
      zi = clamp(Math.floor((wx - (ZX - W / 2)) / W), 0, 3),
      f = FR[['mac', 'srv', 'lk', 'brw'][zi]];
    const cx = zi * W + ZX,
      inF = Math.abs(wx - cx) < f[0] / 2 + R * 0.3 && Math.abs(ly - ZY) < f[1] / 2 + R * 0.3;
    let txt = 'ciphertext',
      col = '#8a93ad';
    if (inF) {
      if (zi === 0) {
        txt = 'plaintext · keys on this Mac';
        col = '#4cc995';
      } else if (zi === 1) {
        txt = 'ciphertext only · no key here';
        col = '#ff7a61';
      } else if (zi === 2) {
        txt = 'key in the #fragment';
        col = '#7d9dff';
      } else {
        if (t < 8.55) {
          txt = 'locked · waiting for code';
          col = '#7d9dff';
        } else if (t < 9.4) {
          txt = 'plaintext · decrypted here';
          col = '#4cc995';
        } else {
          txt = 'expired · nothing to open';
          col = '#ff7a61';
        }
      }
    }
    if (readT.textContent !== txt) readT.textContent = txt;
    read.style.color = col;
    const rx = clamp(lx + R * 0.62, 8, W - read.offsetWidth - 8),
      ry = clamp(ly + R * 0.78, 70, H - 40);
    read.style.transform = `translate(${rx.toFixed(1)}px,${ry.toFixed(1)}px)`;
    // captions
    const ct = capT ?? t;
    let ai = caps.findIndex((o) => ct >= o.a && ct < o.b);
    if (ai < 0) ai = caps.length - 1;
    if (ai !== activeCap) {
      caps.forEach((o, i) => o.el.classList.toggle('on', i === ai));
      activeCap = ai;
    }
    railS.forEach((s, i) => {
      const a = clamp(zf - i + 1, 0, 1);
      s.lastChild.style.width = clamp(zf - i + 0.5, 0, 1) * 100 + '%';
      s.classList.toggle('on', Math.round(zf) === i);
    });
    drawWall(time, camX);
  }

  // ---------- blueprint section (L5) ----------
  const bpSec = $('#bp'),
    bpStage = $('#bpStage'),
    board = $('#bpBoard'),
    real = $('#bpReal'),
    blue = $('#bpBlue'),
    ann = $('#bpAnn'),
    scan = $('#scan'),
    bpA = $('#bpA'),
    bpH = $('#bpH'),
    bpMode = $('#bpMode');
  const TPL = `<div class="card it"><div class="ih"><div class="tl">P</div><div><b>Prod DB</b><span class="tg">prod</span><small>Payments API · Priya's Mac</small></div></div>
<div class="f"><small>username</small><span class="pt">postgres</span></div>
<div class="f"><small>password</small><span class="pt">Tq7#vR2m!xLp9</span></div>
<div class="f"><small>share link</small><span class="url"><span class="pa">vault.acme.dev/share/</span><span class="fr">#k3v9…Xq7…key</span></span></div></div>
<div class="wire"><span>ciphertext only →</span></div>
<div class="card sv"><div class="sh"><i></i><div><b>Zvault server</b><small>what it stores</small></div></div>
<div class="cb"><small>item.prod_db</small><code>9f2c 41e0 b7a3 5d1c</code></div>
<div class="cb"><small>share.7f3a9c</small><code>c41e 07b9 a2d4 6f13</code></div>
<div class="cb"><small>auth verifier</small><code>3e7a d902 f1c6 4b88</code></div>
<div class="nk"><small>decryption key</small><span>not stored</span></div></div>`;
  real.innerHTML = TPL;
  blue.insertAdjacentHTML('afterbegin', TPL);
  const bpPT = [...blue.querySelectorAll('.pt,.fr')],
    bpCB = [...blue.querySelectorAll('.cb')],
    bpCode = [...blue.querySelectorAll('.cb code')];
  let bpG = {};
  function bpLayout() {
    ann.innerHTML = '';
    bpG = { a: [], b: [], c: [] };
    const B = blue.getBoundingClientRect(),
      R = (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.left - B.left, y: r.top - B.top, w: r.width, h: r.height };
      };
    const add = (g, html, css) => {
      const d = document.createElement('div');
      d.className = 'd' + (g === 'b' ? ' ns' : '');
      d.innerHTML = html;
      applyCss(d);
      Object.assign(d.style, css);
      ann.appendChild(d);
      bpG[g].push(d);
    };
    const it = R(blue.querySelector('.it')),
      sv = R(blue.querySelector('.sv'));
    (compact
      ? [[it, 'item']]
      : [
          [it, 'item'],
          [sv, 'server'],
        ]
    ).forEach(([r, n]) => {
      add(
        'a',
        `<div class="hb" data-css="left:0;top:14px;width:${r.w}px"></div><div data-css="position:absolute;left:${r.w / 2}px;top:0;transform:translateX(-50%)">${Math.round(r.w)} px · ${n}</div>`,
        { left: r.x + 'px', top: r.y - 24 + 'px', width: r.w + 'px', height: '20px' },
      );
    });
    if (!compact)
      add(
        'a',
        `<div class="vb" data-css="left:0;top:0;height:${it.h}px;transform:scaleX(-1)"></div>`,
        { left: it.x - 16 + 'px', top: it.y + 'px', height: it.h + 'px' },
      );
    bpPT.forEach((el) => {
      const r = R(el);
      add(
        'b',
        `<div class="ub" data-css="left:0;top:0;width:${r.w}px"></div><div data-css="position:absolute;left:${r.w / 2}px;top:10px;transform:translateX(-50%)">never sent</div>`,
        { left: r.x + 'px', top: r.y + r.h + 1 + 'px', width: r.w + 'px' },
      );
    });
    const c0 = R(bpCB[0]),
      c2 = R(bpCB[bpCB.length - 1]);
    add('c', `<div class="vb" data-css="left:0;top:0;height:${c2.y + c2.h - c0.y}px"></div>`, {
      left: sv.x + sv.w + 6 + 'px',
      top: c0.y + 'px',
    });
    add('c', `stored · ciphertext only`, {
      left: sv.x + sv.w / 2 + 'px',
      top: sv.y + sv.h + 10 + 'px',
      transform: 'translateX(-50%)',
      fontWeight: '500',
    });
  }
  let bpCur = 0,
    bpOn = false;
  function bpTarget() {
    const r = bpSec.getBoundingClientRect(),
      h = bpStage.clientHeight;
    return clamp(-r.top / Math.max(1, r.height - h), 0, 1);
  }
  function bpSeek(p) {
    const A = sm(0.12, 0.26, p),
      g1 = sm(0.26, 0.36, p),
      g2 = sm(0.36, 0.48, p),
      g3 = sm(0.48, 0.58, p),
      sc = clamp((p - 0.64) / 0.22, 0, 1),
      s = sc * sc * (3 - 2 * sc);
    blue.style.opacity = A.toFixed(3);
    bpG.a.forEach((d) => {
      d.style.opacity = g1.toFixed(3);
    });
    bpG.b.forEach((d) => {
      d.style.opacity = g2.toFixed(3);
    });
    bpG.c.forEach((d) => {
      d.style.opacity = g3.toFixed(3);
    });
    bpPT.forEach((el) => {
      el.style.opacity = (1 - 0.78 * g2).toFixed(3);
    });
    bpCB.forEach((el) => {
      el.style.background = `rgba(47,99,217,${(0.13 * g3).toFixed(3)})`;
      el.style.outline = g3 > 0.5 ? '1.5px solid #2f63d9' : '';
    });
    bpCode.forEach((el) => {
      el.style.color = `rgba(37,82,189,${(0.6 + 0.4 * g3).toFixed(3)})`;
      el.style.fontWeight = g3 > 0.5 ? '600' : '400';
    });
    if (s > 0 && s < 1) {
      real.style.clipPath = `inset(0 0 ${((1 - s) * 100).toFixed(2)}% 0)`;
      blue.style.clipPath = `inset(${(s * 100).toFixed(2)}% 0 0 0)`;
      scan.style.opacity = '1';
      scan.style.transform = `translateY(${(s * board.clientHeight).toFixed(1)}px)`;
    } else {
      real.style.clipPath = '';
      blue.style.clipPath = '';
      scan.style.opacity = '0';
      if (s >= 1) blue.style.opacity = '0';
    }
    bpA.classList.toggle('on', p > 0.84);
    bpMode.textContent =
      p < 0.14
        ? 'view · product'
        : p < 0.64
          ? 'view · blueprint'
          : p < 0.86
            ? 'scan → product'
            : 'view · product';
  }
  // ---------- drive ----------
  function target() {
    const r = story.getBoundingClientRect();
    return clamp(-r.top / Math.max(1, r.height - H), 0, 1);
  }
  let mouse = null,
    lastInput = -1e9;
  stage.addEventListener('mousemove', (e) => {
    const r = stage.getBoundingClientRect();
    mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
    lastInput = performance.now();
  });
  stage.addEventListener('mouseleave', () => {
    lastInput = -1e9;
  });
  stage.addEventListener(
    'touchmove',
    (e) => {
      const r = stage.getBoundingClientRect(),
        p = e.touches[0];
      mouse = { x: p.clientX - r.left, y: p.clientY - r.top - 70 };
      lastInput = performance.now();
    },
    { passive: true },
  );
  function autoLens(t, time) {
    const zi = Math.round(zoneF(t)),
      f = FR[['mac', 'srv', 'lk', 'brw'][zi]];
    let fx = ZX,
      fy = ZY,
      ax = f[0] * 0.14,
      ay = f[1] * 0.1;
    if (zi === 0) {
      if (t < 1.5 || compact) {
        fx = ZX + (compact ? 0 : f[0] * 0.13);
        fy = ZY + f[1] * 0.06;
      } else {
        fx = ZX + f[0] / 2 - 132;
        fy = ZY + 10;
        ax = 24;
        ay = f[1] * 0.16;
      }
    }
    if (zi === 1) {
      ax = f[0] * 0.2;
      ay = f[1] * 0.18;
    }
    if (zi === 2) {
      fy = ZY - f[1] / 2 + 32;
      ax = Math.max(0, f[0] / 2 - lensR * 0.75);
      ay = 6;
    }
    if (zi === 3) {
      fy = ZY + 20;
      ax = f[0] * 0.1;
      ay = f[1] * 0.06;
    }
    return { x: fx + ax * Math.sin(time * 0.5), y: fy + ay * Math.sin(time * 0.8 + 1.2) };
  }
  let cur = 0,
    last = performance.now(),
    t0 = last,
    lens = null;
  layout();
  bpLayout();
  addEventListener('resize', () => {
    layout();
    bpLayout();
  });
  if (document.fonts && document.fonts.ready)
    document.fonts.ready.then(() => {
      layout();
      bpLayout();
    });
  addEventListener('scroll', navState, { passive: true });
  navState();
  if (RM) {
    bpH.classList.add('on');
    const still = () => {
      layout();
      bpLayout();
      bpSeek(0.6);
      seek(0, 0, { x: ZX + (compact ? 0 : FR.mac[0] * 0.08), y: ZY + FR.mac[1] * 0.06 }, 0);
    };
    still();
    addEventListener('resize', still);
    if (document.fonts) document.fonts.ready.then(still);
    return;
  }
  cur = target();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const time = (now - t0) / 1000;
    const zR = [1, 1, 1.22, 1.1][Math.round(zoneF(cur * END))] * R;
    lensR += (zR - lensR) * (1 - Math.exp(-dt * 4));
    const tg = target();
    cur += (tg - cur) * (1 - Math.exp(-dt * 4.5));
    if (Math.abs(tg - cur) < 1e-5) cur = tg;
    const t = cur * END;
    const useMouse = mouse && now - lastInput < 2500;
    const goal = useMouse ? mouse : autoLens(t, time);
    if (!lens) lens = { ...goal };
    const k = 1 - Math.exp(-dt * (useMouse ? 14 : 5));
    lens.x += (goal.x - lens.x) * k;
    lens.y += (goal.y - lens.y) * k;
    const sr = story.getBoundingClientRect();
    if (sr.bottom > 0) {
      if (Math.random() < 0.5) mutate(compact ? 4 : 10);
      if ((now | 0) % 3 === 0) fillCt(false);
      seek(t, time, lens);
    }
    const bt = bpTarget();
    bpCur += (bt - bpCur) * (1 - Math.exp(-dt * 4.5));
    if (Math.abs(bt - bpCur) < 1e-5) bpCur = bt;
    const br = bpSec.getBoundingClientRect();
    if (br.top < innerHeight && br.bottom > 0) bpSeek(bpCur);
    if (!bpOn && br.top < innerHeight * 0.5) {
      bpOn = true;
      bpH.classList.add('on');
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();

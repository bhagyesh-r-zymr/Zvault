// The launch film at the top of the page: one pinned stage played by scrolling.
// Everything on it is a pure function of film time t (0..40 s), so scrolling back works.
// A halftone mascot is drawn with three.js: the scene renders to a texture, then one
// full-screen shader turns it into a dot screen. Type and cards are plain HTML on top.
// Test hooks: ?p=0..1 (film progress), ?t=seconds, ?still (reduced motion).
import * as THREE from '/vendor/three.module.min.js';
/* =========================================================
   timeline
   ========================================================= */
var TOTAL = 40,
  FPS = 24;
var SHOTS = [
  { id: 'hook', a: 0, b: 6, bg: 'white', tone: 'white', lbl: '// 01 — hook', still: 5.2 },
  { id: 'problem', a: 6, b: 13, bg: 'blue', tone: 'blue', lbl: '// 02 — the problem', still: 12.4 },
  { id: 'zvault', a: 13, b: 22, bg: 'white', tone: 'white', lbl: '// 03 — zvault', still: 21.2 },
  {
    id: 'handled',
    a: 22,
    b: 29.4,
    bg: 'white',
    tone: 'white',
    lbl: '// 04 — handled',
    still: 27.0,
  },
  { id: 'flow', a: 29.4, b: 34, bg: 'black', tone: 'black', lbl: '// 05 — flow', still: 32.8 },
  { id: 'end', a: 34, b: 40.01, bg: 'white', tone: 'white', lbl: '// zvault', still: 38.5 },
];
var WHIPS = [6, 13, 22];
var TEASER = [
  [0.25, 1.6],
  [2.3, 1.5],
  [27.35, 1.25],
  [34.55, 1.65],
]; /* [film start, duration] */
var TEASE = TEASER.reduce(function (s, c) {
  return s + c[1];
}, 0);

var qs = new URLSearchParams(location.search);
var REDUCE = matchMedia('(prefers-reduced-motion: reduce)').matches || qs.has('still');

function clamp(x, a, b) {
  a = a === undefined ? 0 : a;
  b = b === undefined ? 1 : b;
  return Math.min(b, Math.max(a, x));
}
function seg(t, a, b) {
  return clamp((t - a) / (b - a));
}
function lerp(a, b, k) {
  return a + (b - a) * k;
}
var E = {
  lin: function (x) {
    return x;
  },
  out: function (x) {
    return 1 - Math.pow(1 - x, 3);
  },
  out5: function (x) {
    return 1 - Math.pow(1 - x, 5);
  },
  io: function (x) {
    return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
  },
  back: function (x) {
    var c1 = 1.9,
      c3 = c1 + 1;
    return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
  },
  expo: function (x) {
    return x >= 1 ? 1 : 1 - Math.pow(2, -10 * x);
  },
};
/* keyframes: [[t,v],[t,v,'ease'],...] */
function kf(t, k) {
  if (t <= k[0][0]) return k[0][1];
  for (var i = 1; i < k.length; i++) {
    if (t < k[i][0]) {
      var e = E[k[i][2] || 'io'];
      return lerp(k[i - 1][1], k[i][1], e(seg(t, k[i - 1][0], k[i][0])));
    }
  }
  return k[k.length - 1][1];
}
function shotAt(t) {
  for (var i = 0; i < SHOTS.length; i++) if (t < SHOTS[i].b) return SHOTS[i];
  return SHOTS[SHOTS.length - 1];
}

/* =========================================================
   DOM
   ========================================================= */
var body = document.body,
  nav = document.getElementById('nav'),
  film = document.getElementById('film'),
  pin = document.getElementById('pin');
var content = document.getElementById('content');
var shots = {};
[].forEach.call(document.querySelectorAll('.shot'), function (el) {
  shots[el.dataset.shot] = el;
});
var bgs = {};
[].forEach.call(document.querySelectorAll('[data-bg]'), function (el) {
  bgs[el.dataset.bg] = el;
});
var lbl = document.getElementById('lbl'),
  tc = document.getElementById('tc'),
  fi = document.getElementById('fi');

/* split kinetic words */
var WORDS = [];
[].forEach.call(document.querySelectorAll('.kw'), function (el) {
  var a = parseFloat(el.dataset.a),
    s = parseFloat(el.dataset.s || '0.14');
  var parts = el.textContent.split(/(\s+)/);
  el.textContent = '';
  var i = 0;
  parts.forEach(function (p) {
    if (!p) return;
    if (/^\s+$/.test(p)) {
      el.appendChild(document.createTextNode(' '));
      return;
    }
    var w = document.createElement('span');
    w.className = 'w';
    w.textContent = p;
    el.appendChild(w);
    WORDS.push({ el: w, a: a + i * s });
    i++;
  });
});
function q(sel) {
  return [].slice.call(document.querySelectorAll(sel));
}
var POPS = q('.pop').map(function (el) {
  return {
    el: el,
    a: parseFloat(el.dataset.a),
    h: el.dataset.hide ? parseFloat(el.dataset.hide) : null,
  };
});
var SHOWS = q('[data-show]').map(function (el) {
  return {
    el: el,
    a: parseFloat(el.dataset.show),
    h: el.dataset.hide ? parseFloat(el.dataset.hide) : null,
  };
});
var TYPES = q('[data-type]').map(function (el) {
  return { el: el, a: parseFloat(el.dataset.a), b: parseFloat(el.dataset.b), txt: el.dataset.text };
});
var COUNTS = q('[data-count]').map(function (el) {
  return {
    el: el,
    a: parseFloat(el.dataset.a),
    b: parseFloat(el.dataset.b),
    f: parseFloat(el.dataset.from || '0'),
    to: parseFloat(el.dataset.to),
  };
});
var STRIKES = q('[data-strike]').map(function (el) {
  return { el: el, a: parseFloat(el.dataset.strike) };
});
var ONS = q('[data-on]').map(function (el) {
  return { el: el, a: parseFloat(el.dataset.on) };
});
var DRAWS = q('[data-draw]').map(function (el) {
  var L = 160;
  el.style.strokeDasharray = L;
  return { el: el, a: parseFloat(el.dataset.draw), L: L };
});
var CODES = q('[data-code]').map(function (el) {
  return {
    el: el,
    a: parseFloat(el.dataset.a),
    b: parseFloat(el.dataset.b),
    code: el.dataset.code,
    box: [].slice.call(el.children),
  };
});
/* bars */
var BARS = [];
(function () {
  var b = document.getElementById('bars');
  for (var i = 0; i < 18; i++) {
    var el = document.createElement('i');
    var h = 0.55 + 0.45 * Math.min(1, i / 5) * (0.82 + 0.18 * Math.sin(i * 1.9));
    el.style.height = (h * 44).toFixed(1) + 'px';
    b.appendChild(el);
    BARS.push({ el: el, a: 17.75 + i * 0.07 });
  }
})();
var bubble = document.getElementById('bubble'),
  banner = document.getElementById('banner'),
  iris = document.getElementById('iris'),
  yours = document.getElementById('yours');

function setOp(el, o, tf, fl) {
  el.style.opacity = o >= 0.999 ? '' : o.toFixed(3);
  el.style.transform = tf || '';
  el.style.filter = fl || '';
  el.style.visibility = o <= 0.001 ? 'hidden' : '';
}

function domUpdate(t) {
  var still = REDUCE;
  WORDS.forEach(function (w) {
    var e = E.out(seg(t, w.a, w.a + 0.42));
    if (still) e = t >= w.a ? 1 : 0;
    if (e >= 1) {
      setOp(w.el, 1);
      return;
    }
    var k = 1 - e;
    setOp(
      w.el,
      Math.min(1, e * 2.2),
      'translateX(' + (k * 0.55).toFixed(3) + 'em) scaleX(' + (1 + k * 0.6).toFixed(3) + ')',
      'blur(' + (k * 9).toFixed(2) + 'px)',
    );
  });
  POPS.forEach(function (p) {
    var e = seg(t, p.a, p.a + 0.5),
      o = seg(t, p.a, p.a + 0.14);
    if (p.h !== null) {
      var x = seg(t, p.h, p.h + 0.14);
      o *= 1 - x;
    }
    if (still) {
      e = t >= p.a ? 1 : 0;
      o = e * (p.h !== null && t >= p.h ? 0 : 1);
    }
    if (e >= 1 && o >= 1) {
      setOp(p.el, 1);
      return;
    }
    var s = lerp(0.82, 1, E.back(e)),
      k = 1 - E.out(e);
    setOp(
      p.el,
      o,
      'translateY(' + (k * 26).toFixed(1) + 'px) scale(' + s.toFixed(4) + ')',
      k > 0.02 ? 'blur(' + (k * 8).toFixed(2) + 'px)' : '',
    );
  });
  SHOWS.forEach(function (p) {
    var o = seg(t, p.a, p.a + 0.18);
    if (p.h !== null) o *= 1 - seg(t, p.h, p.h + 0.1);
    if (still) o = t >= p.a && (p.h === null || t < p.h) ? 1 : 0;
    setOp(p.el, o, o < 1 ? 'translateY(' + ((1 - o) * 6).toFixed(1) + 'px)' : '');
  });
  TYPES.forEach(function (p) {
    var k = still ? (t >= p.a ? 1 : 0) : seg(t, p.a, p.b);
    var n = Math.round(p.txt.length * k);
    var s = p.txt.slice(0, n);
    if (p.el.textContent !== s) p.el.textContent = s;
    p.el.classList.toggle('caret', t >= p.a - 0.3 && k < 1);
  });
  COUNTS.forEach(function (p) {
    var v = lerp(p.f, p.to, E.out(still ? (t >= p.a ? 1 : 0) : seg(t, p.a, p.b)));
    var s = Math.round(v).toLocaleString('en-US');
    if (p.el.textContent !== s) p.el.textContent = s;
  });
  STRIKES.forEach(function (p) {
    var e = still ? (t >= p.a ? 1 : 0) : E.out(seg(t, p.a, p.a + 0.28));
    p.el.style.transform = 'scaleX(' + e.toFixed(3) + ')';
  });
  ONS.forEach(function (p) {
    p.el.classList.toggle('on', t >= p.a);
  });
  DRAWS.forEach(function (p) {
    var e = still ? (t >= p.a ? 1 : 0) : E.out(seg(t, p.a, p.a + 0.45));
    p.el.style.strokeDashoffset = (p.L * (1 - e)).toFixed(1);
  });
  CODES.forEach(function (p) {
    var n = still ? (t >= p.a ? 6 : 0) : Math.floor(seg(t, p.a, p.b) * 6.999);
    p.box.forEach(function (b, i) {
      var ch = i < n ? p.code[i] : '';
      if (b.textContent !== ch) b.textContent = ch;
      b.classList.toggle('f', i < n);
      b.classList.toggle('cur', i === n && t >= p.a - 0.4 && n < 6);
    });
  });
  BARS.forEach(function (b) {
    var e = still ? (t >= b.a ? 1 : 0) : E.back(seg(t, b.a, b.a + 0.3));
    b.el.style.transform = 'scaleY(' + Math.max(0.001, e).toFixed(3) + ')';
  });
  /* banner swipe */
  var bOn = t >= 27.3 && t < 29.4;
  banner.classList.toggle('on', bOn);
  if (bOn) {
    var inE = E.expo(seg(t, 27.3, 27.75)),
      outE = seg(t, 29.0, 29.35);
    outE = outE * outE;
    var x = (1 - inE) * 110 - (t - 27.3) * 4 - outE * 130;
    var bl = (1 - inE) * 30 + outE * 30;
    if (still) {
      x = 0;
      bl = 0;
    }
    banner.style.transform = 'rotate(-8deg) translateX(' + x.toFixed(2) + 'vw)';
    banner.style.filter = bl > 0.3 ? 'blur(' + bl.toFixed(1) + 'px)' : '';
  }
  /* iris */
  if (yours) {
    var ir = still ? 0 : E.io(seg(t, 33.1, 33.95));
    if (ir > 0) {
      var r = pin.getBoundingClientRect(),
        y = yours.getBoundingClientRect();
      var cx = y.left + y.width / 2 - r.left,
        cy = y.top + y.height / 2 - r.top;
      var R = Math.hypot(Math.max(cx, r.width - cx), Math.max(cy, r.height - cy)) * 1.05;
      iris.style.clipPath =
        'circle(' + (ir * R).toFixed(1) + 'px at ' + cx.toFixed(1) + 'px ' + cy.toFixed(1) + 'px)';
    } else iris.style.clipPath = 'circle(0px at 50% 50%)';
  }
}

/* whip transition on the whole frame */
function whip(t) {
  if (REDUCE) return { x: 0, b: 0 };
  for (var i = 0; i < WHIPS.length; i++) {
    var c = WHIPS[i],
      w = 0.2;
    if (t >= c - w && t < c) {
      var k = seg(t, c - w, c);
      return { x: -k * k * 38, b: k * 26 };
    }
    if (t >= c && t < c + w) {
      var k2 = 1 - seg(t, c, c + w);
      return { x: k2 * k2 * 38, b: k2 * 26 };
    }
  }
  return { x: 0, b: 0 };
}

/* =========================================================
   layout helpers
   ========================================================= */
var W = 1,
  H = 1,
  portrait = false;
function rel(el) {
  var x = 0,
    y = 0,
    e = el;
  while (e && e !== pin) {
    x += e.offsetLeft;
    y += e.offsetTop;
    e = e.offsetParent;
  }
  return { x: x, y: y, w: el.offsetWidth, h: el.offsetHeight };
}
var mcell = document.getElementById('mcell'),
  wordmark = document.getElementById('wordmark'),
  keycard = document.getElementById('keycard'),
  term = document.getElementById('term-film');
var LAY = {};
function measure() {
  W = pin.clientWidth;
  H = pin.clientHeight;
  portrait = W / H < 0.8;
  document.documentElement.classList.toggle('portrait', portrait);
  var vis = [];
  ['handled', 'end', 'zvault'].forEach(function (k) {
    vis.push([shots[k], shots[k].style.display]);
    shots[k].style.display = 'block';
    shots[k].style.visibility = 'hidden';
  });
  LAY.cell = rel(mcell);
  LAY.word = rel(wordmark);
  LAY.term = rel(term);
  vis.forEach(function (v) {
    v[0].style.display = v[1];
    v[0].style.visibility = '';
  });
  /* keycard sits over the terminal's left edge */
  if (portrait) {
    keycard.style.left = LAY.term.x + LAY.term.w - 150 + 'px';
    keycard.style.top = LAY.term.y - 196 + 'px';
  } else {
    keycard.style.left = LAY.term.x - 70 + 'px';
    keycard.style.top = LAY.term.y + LAY.term.h - 40 + 'px';
  }
}

/* =========================================================
   mascot choreography (pure function of t)
   ========================================================= */
var EXPR = [
  [0, 'neutral'],
  [0.8, 'o'],
  [1.95, 'smile'],
  [3.2, 'laugh'],
  [4.5, 'smile'],
  [6, 'worried'],
  [9.35, 'o'],
  [10.5, 'grimace'],
  [11.5, 'worried'],
  [13, 'smile'],
  [16.2, 'o'],
  [17.0, 'smile'],
  [19.5, 'laugh'],
  [20.8, 'smile'],
  [22, 'smile'],
  [24.35, 'o'],
  [25.2, 'wink'],
  [25.8, 'laugh'],
  [26.9, 'smile'],
  [29.4, 'smile'],
  [31.7, 'laugh'],
  [32.5, 'wink'],
  [33.0, 'smile'],
  [34, 'o'],
  [35.1, 'smile'],
  [36.3, 'wink'],
  [37.0, 'laugh'],
  [38.0, 'smile'],
];
var BLINKS = [5.0, 8.2, 12.3, 18.3, 21.4, 23.2, 28.0, 30.3, 35.8, 38.9];
function exprAt(t) {
  var e = 'neutral';
  for (var i = 0; i < EXPR.length; i++) {
    if (t >= EXPR[i][0]) e = EXPR[i][1];
  }
  return e;
}
function mascotAt(t) {
  var s = shotAt(t),
    m = {
      vis: true,
      cx: 0,
      cy: 0,
      h: 100,
      yaw: 0,
      pitch: 0,
      roll: 0,
      lookX: 0,
      lookY: 0,
      expr: exprAt(t),
      blink: 0,
      clip: null,
    };
  BLINKS.forEach(function (b) {
    var k = seg(t, b, b + 0.16);
    if (k > 0 && k < 1) m.blink = Math.sin(Math.PI * k);
  });
  var P = portrait;
  if (s.id === 'hook') {
    m.h = P ? 0.25 * H : 0.44 * H;
    m.cx = P
      ? kf(t, [
          [0, W + 0.2 * H],
          [0.8, W * 0.56, 'out'],
          [1.95, W * 0.56],
          [2.4, W * 0.64, 'io'],
        ])
      : kf(t, [
          [0, W + 0.2 * H],
          [0.8, W * 0.64, 'out'],
          [1.95, W * 0.64],
          [2.45, W * 0.76, 'io'],
        ]);
    m.cy = P ? 0.7 * H : 0.47 * H;
    m.roll = kf(t, [
      [0, -0.32],
      [0.8, 0.1, 'out'],
      [1.95, 0.07],
      [2.45, 0, 'io'],
    ]);
    m.yaw = kf(t, [
      [0, -0.6],
      [0.8, -0.38, 'out'],
      [2.4, -0.3],
      [3.2, -0.22],
    ]);
    m.lookX = -0.6;
    m.lookY = kf(t, [
      [2.3, 0],
      [3.2, -0.2],
    ]);
    m.pitch = kf(t, [
      [3.1, 0],
      [3.35, -0.1, 'out'],
      [3.9, 0],
    ]);
  } else if (s.id === 'problem') {
    m.h = P ? 0.2 * H : 0.4 * H;
    m.cx = P ? 0.22 * W : 0.17 * W;
    m.cy = P ? 0.85 * H : 0.66 * H;
    m.yaw = 0.3;
    m.lookX = 0.9;
    m.roll = kf(t, [
      [6, 0.05],
      [9.3, 0.05],
      [9.6, -0.1, 'out'],
      [11.5, -0.04],
    ]);
    m.pitch = kf(t, [
      [6, 0.05],
      [9.3, 0.05],
      [9.55, -0.08, 'out'],
      [10.6, 0.06],
    ]);
  } else if (s.id === 'zvault') {
    m.h = P ? 0.14 * H : 0.3 * H;
    m.cx = P ? 0.2 * W : 0.3 * W;
    m.cy = P
      ? kf(t, [
          [13, H * 1.08],
          [13.6, H * 0.905, 'back'],
        ])
      : kf(t, [
          [13, H * 1.2],
          [13.7, H * 0.8, 'back'],
        ]);
    m.yaw = P ? 0.3 : 0.3;
    m.lookX = 0.9;
    m.lookY = 0.25;
    m.roll = kf(t, [
      [19.4, 0],
      [19.7, -0.12, 'out'],
      [20.6, 0],
    ]);
    if (P) {
      m.lookY = 0.35;
    }
  } else if (s.id === 'handled') {
    var c = LAY.cell;
    m.clip = c;
    m.h = c.h * (P ? 0.54 : 0.62);
    m.cx = c.x + c.w * 0.5;
    m.cy = c.y + c.h * (P ? 0.6 : 0.6);
    m.vis = t >= 22.65;
    m.yaw = kf(t, [
      [22.6, -0.3],
      [23.3, 0.12],
      [24.4, -0.2],
      [25.4, 0.1],
    ]);
    m.lookX = kf(t, [
      [22.6, -0.5],
      [23.4, 0.5],
      [24.3, -0.6],
      [25.2, 0.2],
    ]);
    m.roll = kf(t, [
      [25.1, 0],
      [25.3, 0.14, 'out'],
      [26.2, 0.02],
    ]);
  } else if (s.id === 'flow') {
    m.h = P ? 0.22 * H : 0.42 * H;
    m.cx = P ? 0.72 * W : 0.8 * W;
    m.cy = P ? 0.8 * H : 0.6 * H;
    m.yaw = -0.38;
    m.lookX = -0.6;
    m.roll = kf(t, [
      [31.6, 0],
      [31.9, -0.1, 'out'],
      [32.9, 0.06],
    ]);
  } else {
    var wd = LAY.word;
    var fs = parseFloat(getComputedStyle(wordmark).fontSize) || 200;
    m.h = fs * 0.86;
    m.cx = wd.x + wd.w * 0.55;
    var base = wd.y + fs * 0.33; /* head center: letters cross the chin */
    m.cy =
      base +
      kf(t, [
        [34.1, fs * 0.95],
        [34.95, 0, 'back'],
      ]);
    m.clip = { x: 0, y: 0, w: W, h: base + m.h * 0.47 };
    m.yaw = kf(t, [
      [34, 0],
      [36.2, 0.12],
      [37.2, -0.08],
    ]);
    m.roll = kf(t, [
      [36.2, 0],
      [36.4, 0.1, 'out'],
      [37.3, 0],
    ]);
    m.lookX = kf(t, [
      [34, 0],
      [35, -0.2],
      [36.2, 0.25],
    ]);
  }
  /* idle life */
  m.cy += Math.sin(t * 2.1) * m.h * 0.006;
  m.roll += Math.sin(t * 1.3) * 0.015;
  return m;
}

/* =========================================================
   WebGL: halftone mascot
   ========================================================= */
var canvas = document.getElementById('gl'),
  renderer = null;
try {
  renderer = new THREE.WebGLRenderer({
    canvas: canvas,
    antialias: false,
    alpha: true,
    premultipliedAlpha: true,
  });
} catch (e) {
  renderer = null;
}

var HALFTONE_VS = 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.0,1.0); }';
var HALFTONE_FS = [
  'uniform sampler2D tMap; uniform vec2 uRes; uniform float uCell; uniform float uAng; uniform vec3 uInk; uniform vec3 uPaper; uniform float uGamma; uniform float uGain;',
  'varying vec2 vUv;',
  'float lumAt(vec2 px){ vec4 c=texture2D(tMap,px/uRes); vec3 rgb=c.a>0.001?c.rgb/c.a:vec3(1.0); rgb=pow(clamp(rgb,0.0,1.0),vec3(1.0/2.2)); float l=dot(rgb,vec3(0.299,0.587,0.114)); return mix(1.0,l,clamp(c.a,0.0,1.0)); }',
  'void main(){',
  '  vec2 px=vUv*uRes; float s=sin(uAng), c=cos(uAng);',
  '  vec2 q=vec2(c*px.x-s*px.y, s*px.x+c*px.y);',
  '  vec2 cc=(floor(q/uCell)+0.5)*uCell; vec2 d=q-cc;',
  '  vec2 p0=vec2(c*cc.x+s*cc.y, -s*cc.x+c*cc.y);',
  '  float o=uCell*0.3;',
  '  float l=lumAt(p0)*0.4+0.15*(lumAt(p0+vec2(o,0.0))+lumAt(p0-vec2(o,0.0))+lumAt(p0+vec2(0.0,o))+lumAt(p0-vec2(0.0,o)));',
  '  float dark=clamp((1.0-l-0.04)*uGain,0.0,1.0); dark=pow(dark,uGamma);',
  '  float r=uCell*0.76*sqrt(dark);',
  '  float ink=1.0-smoothstep(r-0.75,r+0.75,length(d));',
  '  float a=smoothstep(0.3,0.7,texture2D(tMap,vUv).a);',
  '  vec3 col=mix(uPaper,uInk,ink);',
  '  gl_FragColor=vec4(col*a,a);',
  '}',
].join('\n');
function Halftone(r, cellCss) {
  this.r = r;
  this.cellCss = cellCss;
  this.rt = new THREE.WebGLRenderTarget(4, 4, { samples: 4, depthBuffer: true });
  this.mat = new THREE.ShaderMaterial({
    vertexShader: HALFTONE_VS,
    fragmentShader: HALFTONE_FS,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
    uniforms: {
      tMap: { value: this.rt.texture },
      uRes: { value: new THREE.Vector2(4, 4) },
      uCell: { value: 5 },
      uAng: { value: 0.785 },
      uInk: { value: new THREE.Color(0x141519) },
      uPaper: { value: new THREE.Color(0xffffff) },
      uGamma: { value: 1.3 },
      uGain: { value: 1.0 },
    },
  });
  this.scene = new THREE.Scene();
  this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  var quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
  quad.frustumCulled = false;
  this.scene.add(quad);
}
Halftone.prototype.setSize = function (w, h, dpr) {
  this.rt.setSize(Math.round(w * dpr), Math.round(h * dpr));
  this.mat.uniforms.uRes.value.set(Math.round(w * dpr), Math.round(h * dpr));
  this.mat.uniforms.uCell.value = this.cellCss * dpr;
};
Halftone.prototype.render = function (scene, cam, clip, H) {
  var r = this.r;
  r.setRenderTarget(this.rt);
  r.setClearColor(0x000000, 0);
  r.clear(true, true, true);
  r.render(scene, cam);
  r.setRenderTarget(null);
  r.setClearColor(0x000000, 0);
  r.clear(true, true, true);
  if (clip) {
    r.setScissorTest(true);
    r.setScissor(clip.x, H - clip.y - clip.h, clip.w, clip.h);
  }
  r.render(this.scene, this.cam);
  r.setScissorTest(false);
};

/* shared geometry helpers */
function rrShape(w, h, r) {
  var s = new THREE.Shape(),
    x = -w / 2,
    y = -h / 2;
  r = Math.min(r, w / 2, h / 2);
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}
function rbox(w, h, d, r, b) {
  var g = new THREE.ExtrudeGeometry(rrShape(w - 2 * b, h - 2 * b, Math.max(r - b, 0.004)), {
    depth: Math.max(d - 2 * b, 0.001),
    bevelEnabled: true,
    bevelThickness: b,
    bevelSize: b,
    bevelSegments: 4,
    curveSegments: 10,
  });
  g.translate(0, 0, -(d - 2 * b) / 2);
  g.computeVertexNormals();
  return g;
}
function hexShape(R, rr) {
  var s = new THREE.Shape(),
    pts = [],
    i;
  for (i = 0; i < 6; i++) {
    var a = Math.PI / 6 + (i * Math.PI) / 3;
    pts.push(new THREE.Vector2(Math.cos(a) * R, Math.sin(a) * R));
  }
  for (i = 0; i < 6; i++) {
    var p = pts[i],
      pn = pts[(i + 1) % 6],
      pp = pts[(i + 5) % 6];
    var a1 = p.clone().lerp(pp, rr / R),
      a2 = p.clone().lerp(pn, rr / R);
    if (i === 0) s.moveTo(a1.x, a1.y);
    else s.lineTo(a1.x, a1.y);
    s.quadraticCurveTo(p.x, p.y, a2.x, a2.y);
  }
  s.closePath();
  return s;
}
function std(c, r, m) {
  return new THREE.MeshStandardMaterial({
    color: c,
    roughness: r === undefined ? 0.6 : r,
    metalness: m || 0,
  });
}
function studio(scene, k) {
  k = k || 1;
  scene.add(new THREE.HemisphereLight(0xffffff, 0xc8c8c8, 1.3 * k));
  var key = new THREE.DirectionalLight(0xffffff, 2.5 * k);
  key.position.set(-4, 5, 6);
  scene.add(key);
  var fill = new THREE.DirectionalLight(0xffffff, 0.55 * k);
  fill.position.set(5, 0.5, 4);
  scene.add(fill);
  var rim = new THREE.DirectionalLight(0xffffff, 1.1 * k);
  rim.position.set(2, 4, -6);
  scene.add(rim);
  return key;
}

var MAT = {
  skin: std(0xf4e9e1, 0.62),
  skinD: std(0xe9d2c4, 0.6),
  cheek: new THREE.MeshBasicMaterial({ color: 0xc9c0bc }),
  hair: std(0x6a615a, 0.7),
  hood: std(0xc4c8cf, 0.85),
  hoodD: std(0xaeb3bc, 0.85),
  cord: std(0xe9e9ec, 0.6),
  eye: new THREE.MeshStandardMaterial({ color: 0x0b0b0d, roughness: 0.25 }),
  glint: new THREE.MeshBasicMaterial({ color: 0xffffff }),
  mouth: std(0x2a1616, 0.5),
  tongue: std(0xd98e86, 0.6),
  brow: std(0x2e2926, 0.7),
  badge: std(0xf7f7f9, 0.45),
  badgeRing: std(0x2f63d9, 0.4),
};

function buildMascot() {
  var root = new THREE.Group(),
    headG = new THREE.Group();
  root.add(headG);
  var head = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 48), MAT.skin);
  head.scale.set(1, 0.97, 0.96);
  headG.add(head);
  /* ears */
  [-1, 1].forEach(function (sx) {
    var e = new THREE.Mesh(new THREE.SphereGeometry(0.21, 24, 16), MAT.skinD);
    e.scale.set(0.55, 1, 0.75);
    e.position.set(sx * 0.97, -0.06, 0.02);
    headG.add(e);
  });
  /* hair: tousled cluster */
  var N = 150,
    pts = [],
    ga = Math.PI * (3 - Math.sqrt(5));
  for (var i = 0; i < N; i++) {
    var y = 1 - (i / (N - 1)) * 2,
      rr = Math.sqrt(1 - y * y),
      th = ga * i;
    var p = new THREE.Vector3(Math.cos(th) * rr, y, Math.sin(th) * rr);
    var keep = p.y > 0.38 || (p.y > 0.02 && p.z < -0.15) || (p.y > -0.35 && p.z < -0.55);
    if (p.z > 0.5 && p.y < 0.62) keep = false;
    if (Math.abs(p.x) > 0.82 && p.y < 0.3 && p.z > -0.3) keep = false;
    if (keep) pts.push(p);
  }
  var hg = new THREE.SphereGeometry(1, 20, 14),
    hm = new THREE.InstancedMesh(hg, MAT.hair, pts.length),
    dm = new THREE.Object3D();
  pts.forEach(function (p, i) {
    var r = 0.27 + 0.07 * (0.5 + 0.5 * Math.sin(i * 12.9898));
    dm.position.copy(p).multiplyScalar(0.94 + 0.04 * Math.sin(i * 4.1));
    dm.position.y += 0.05;
    dm.scale.setScalar(r);
    dm.updateMatrix();
    hm.setMatrixAt(i, dm.matrix);
  });
  headG.add(hm);
  /* front curls */
  [
    [-0.42, 0.78, 0.52, 0.3],
    [-0.05, 0.86, 0.5, 0.31],
    [0.34, 0.8, 0.52, 0.29],
    [0.62, 0.62, 0.52, 0.25],
    [-0.68, 0.6, 0.46, 0.24],
  ].forEach(function (c) {
    var m = new THREE.Mesh(hg, MAT.hair);
    m.position.set(c[0], c[1], c[2]);
    m.scale.setScalar(c[3]);
    headG.add(m);
  });
  /* face */
  var face = new THREE.Group();
  headG.add(face);
  function onFace(x, y, out) {
    var z = Math.sqrt(Math.max(0, 1 - x * x - y * y)) * 0.96;
    return new THREE.Vector3(x, y, z + (out || 0));
  }
  var eyes = [];
  [-1, 1].forEach(function (sx) {
    var g = new THREE.Group();
    g.position.copy(onFace(sx * 0.33, 0.06, -0.02));
    var e = new THREE.Mesh(new THREE.SphereGeometry(0.135, 28, 20), MAT.eye);
    e.scale.set(0.86, 1.2, 0.5);
    g.add(e);
    var gl = new THREE.Mesh(new THREE.SphereGeometry(0.042, 14, 10), MAT.glint);
    gl.position.set(0.035, 0.06, 0.06);
    g.add(gl);
    g.rotation.y = sx * 0.3;
    face.add(g);
    eyes.push({ g: g, base: g.position.clone() });
  });
  var brows = [-1, 1].map(function (sx) {
    var b = new THREE.Mesh(new THREE.CapsuleGeometry(0.032, 0.17, 6, 12), MAT.brow);
    b.rotation.z = Math.PI / 2;
    var g = new THREE.Group();
    g.add(b);
    g.position.copy(onFace(sx * 0.35, 0.36, 0.01));
    g.rotation.y = sx * 0.32;
    face.add(g);
    return { g: g, sx: sx, base: g.position.clone() };
  });
  var nose = new THREE.Mesh(new THREE.SphereGeometry(0.085, 20, 14), MAT.skinD);
  nose.position.copy(onFace(0, -0.1, 0.03));
  face.add(nose);
  [-1, 1].forEach(function (sx) {
    var c = new THREE.Mesh(new THREE.SphereGeometry(0.15, 20, 14), MAT.cheek);
    c.scale.set(1, 0.66, 0.3);
    c.position.copy(onFace(sx * 0.56, -0.2, -0.02));
    c.rotation.y = sx * 0.55;
    face.add(c);
  });
  var mouthPos = onFace(0, -0.34, 0.0);
  var M = {};
  M.smile = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.026, 10, 32, Math.PI), MAT.mouth);
  M.smile.rotation.z = Math.PI;
  M.smile.position.copy(mouthPos).add(new THREE.Vector3(0, 0.05, 0.0));
  M.smile.scale.set(1, 0.8, 1);
  (function () {
    var s = new THREE.Shape();
    s.moveTo(-0.2, 0);
    s.lineTo(0.2, 0);
    s.absarc(0, 0, 0.2, 0, -Math.PI, true);
    var g = new THREE.ExtrudeGeometry(s, {
      depth: 0.04,
      bevelEnabled: true,
      bevelThickness: 0.015,
      bevelSize: 0.015,
      bevelSegments: 3,
      curveSegments: 24,
    });
    var grp = new THREE.Group();
    var mm = new THREE.Mesh(g, MAT.mouth);
    grp.add(mm);
    var tg = new THREE.Mesh(new THREE.SphereGeometry(0.1, 20, 14), MAT.tongue);
    tg.scale.set(1.1, 0.55, 0.4);
    tg.position.set(0, -0.13, 0.035);
    grp.add(tg);
    grp.position.copy(mouthPos).add(new THREE.Vector3(0, 0.04, -0.02));
    grp.rotation.x = -0.25;
    M.open = grp;
  })();
  M.o = new THREE.Mesh(new THREE.SphereGeometry(0.075, 20, 14), MAT.mouth);
  M.o.scale.set(0.78, 1, 0.45);
  M.o.position.copy(mouthPos).add(new THREE.Vector3(0, 0.0, 0));
  M.flat = new THREE.Mesh(new THREE.CapsuleGeometry(0.024, 0.18, 6, 12), MAT.mouth);
  M.flat.rotation.z = Math.PI / 2;
  M.flat.position.copy(mouthPos).add(new THREE.Vector3(0, 0.02, 0));
  Object.keys(M).forEach(function (k) {
    face.add(M[k]);
  });
  /* body: hoodie bust */
  var body = new THREE.Group();
  root.add(body);
  var neck = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.38, 0.5, 28), MAT.skinD);
  neck.position.y = -1.05;
  body.add(neck);
  var prof = [
    [0.001, -1.12],
    [0.44, -1.12],
    [0.62, -1.2],
    [0.98, -1.38],
    [1.38, -1.62],
    [1.64, -1.98],
    [1.78, -2.5],
    [1.84, -3.2],
    [1.86, -5.2],
    [0.001, -5.2],
  ].map(function (p) {
    return new THREE.Vector2(p[0], p[1]);
  });
  var torso = new THREE.Mesh(new THREE.LatheGeometry(prof, 64), MAT.hood);
  torso.scale.set(1, 1, 0.7);
  body.add(torso);
  var roll = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.1, 16, 48), MAT.hoodD);
  roll.rotation.x = Math.PI / 2 - 0.2;
  roll.position.set(0, -1.2, 0.02);
  roll.scale.set(1.08, 1, 0.95);
  body.add(roll);
  var hoodB = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 20), MAT.hoodD);
  hoodB.scale.set(1.05, 0.5, 0.55);
  hoodB.position.set(0, -1.35, -0.62);
  body.add(hoodB);
  [-1, 1].forEach(function (sx) {
    var c = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.62, 10), MAT.cord);
    c.position.set(sx * 0.23, -1.72, 0.7);
    c.rotation.z = sx * 0.06;
    c.rotation.x = -0.3;
    body.add(c);
    var tip = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.1, 6, 10), MAT.hoodD);
    tip.position.set(sx * 0.25, -2.04, 0.8);
    body.add(tip);
  });
  var bx = 0.72,
    by = -2.45,
    br = 1.73,
    bz = Math.sqrt(br * br - bx * bx) * 0.7;
  var badge = new THREE.Group();
  badge.position.set(bx, by, bz);
  badge.rotation.y = 0.55;
  badge.rotation.x = -0.08;
  var bg = new THREE.ExtrudeGeometry(hexShape(0.3, 0.05), {
    depth: 0.05,
    bevelEnabled: true,
    bevelThickness: 0.02,
    bevelSize: 0.02,
    bevelSegments: 3,
  });
  badge.add(new THREE.Mesh(bg, MAT.badge));
  var rs = hexShape(0.21, 0.035);
  rs.holes.push(new THREE.Path(hexShape(0.15, 0.025).getPoints(24).reverse()));
  var rm = new THREE.Mesh(
    new THREE.ExtrudeGeometry(rs, { depth: 0.02, bevelEnabled: false }),
    MAT.badgeRing,
  );
  rm.position.z = 0.07;
  badge.add(rm);
  var dot = new THREE.Mesh(new THREE.SphereGeometry(0.045, 14, 10), MAT.badgeRing);
  dot.position.z = 0.08;
  dot.scale.z = 0.4;
  badge.add(dot);
  body.add(badge);
  return { root: root, head: headG, eyes: eyes, brows: brows, M: M, face: face };
}
var EXP = {
  neutral: { m: 'smile', ms: 0.7, br: 0, bt: 0, sq: 1 },
  smile: { m: 'smile', ms: 1, br: 0.02, bt: 0, sq: 1 },
  o: { m: 'o', ms: 1, br: 0.08, bt: 0.12, sq: 1.06 },
  laugh: { m: 'open', ms: 1, br: 0.06, bt: 0, sq: 0.62 },
  wink: { m: 'smile', ms: 1.1, br: 0.03, bt: 0, sq: 1, wink: 1 },
  worried: { m: 'flat', ms: 0.8, br: 0.05, bt: -0.32, sq: 1 },
  grimace: { m: 'flat', ms: 1.35, br: -0.02, bt: -0.2, sq: 0.9 },
};
function poseMascot(mc, m) {
  var ex = EXP[m.expr] || EXP.neutral;
  Object.keys(mc.M).forEach(function (k) {
    mc.M[k].visible = k === ex.m;
  });
  var mm = mc.M[ex.m];
  if (ex.m === 'smile' || ex.m === 'flat') {
    mm.scale.x = ex.ms * (ex.m === 'smile' ? 1 : 1);
  }
  mc.eyes.forEach(function (e, i) {
    var sy = ex.sq * (1 - m.blink * 0.9);
    if (ex.wink && i === 0) sy = 0.14;
    e.g.scale.set(1, Math.max(0.08, sy), 1);
    e.g.position.copy(e.base);
    e.g.position.x += m.lookX * 0.035;
    e.g.position.y += m.lookY * 0.03 + (ex.sq < 1 ? -0.01 : 0);
  });
  mc.brows.forEach(function (b) {
    b.g.position.copy(b.base);
    b.g.position.y += ex.br + (ex.wink && b.sx < 0 ? -0.05 : 0);
    b.g.rotation.z = -b.sx * ex.bt;
  });
  mc.head.rotation.set(m.pitch, m.yaw, m.roll);
  mc.root.rotation.y = m.yaw * 0.35;
}

/* ---------- small halftone object renders for cards ---------- */
function buildObj(name) {
  var g = new THREE.Group();
  var metal = std(0xd2d4d8, 0.35, 0.15),
    dark = std(0x2a2d33, 0.4),
    mid = std(0xa7acb5, 0.5),
    white = std(0xf4f4f6, 0.5),
    screen = new THREE.MeshStandardMaterial({ color: 0x14161b, roughness: 0.2 });
  if (name === 'key') {
    var ring = hexShape(0.62, 0.12);
    ring.holes.push(new THREE.Path(hexShape(0.3, 0.08).getPoints(30).reverse()));
    var bow = new THREE.Mesh(
      new THREE.ExtrudeGeometry(ring, {
        depth: 0.14,
        bevelEnabled: true,
        bevelThickness: 0.05,
        bevelSize: 0.05,
        bevelSegments: 4,
      }),
      metal,
    );
    bow.position.x = -1.0;
    g.add(bow);
    var sh = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 1.9, 24), metal);
    sh.rotation.z = Math.PI / 2;
    sh.position.set(0.45, 0, 0.07);
    g.add(sh);
    [
      [0.95, 0.3],
      [1.2, 0.22],
      [1.38, 0.34],
    ].forEach(function (b) {
      var t = new THREE.Mesh(rbox(0.16, b[1], 0.14, 0.03, 0.02), metal);
      t.position.set(b[0], -0.11 - b[1] / 2, 0.07);
      g.add(t);
    });
    g.rotation.set(0.55, -0.45, 0.3);
    g.scale.setScalar(1.15);
    g.position.x = -0.15;
  } else if (name === 'db') {
    for (var i = 0; i < 3; i++) {
      var c = new THREE.Mesh(
        new THREE.CylinderGeometry(0.95, 0.95, 0.44, 48),
        i === 2 ? white : mid,
      );
      c.position.y = -0.52 + i * 0.52;
      g.add(c);
      var r = new THREE.Mesh(new THREE.TorusGeometry(0.95, 0.035, 10, 64), dark);
      r.rotation.x = Math.PI / 2;
      r.position.y = -0.52 + i * 0.52 + 0.22;
      g.add(r);
      var l = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 8), dark);
      l.position.set(0.55, -0.52 + i * 0.52, 0.78);
      g.add(l);
    }
    g.rotation.set(0.42, 0.3, 0);
    g.scale.setScalar(0.95);
  } else if (name === 'laptop') {
    var base = new THREE.Mesh(rbox(2.4, 1.6, 0.08, 0.1, 0.02), metal);
    base.rotation.x = -Math.PI / 2;
    g.add(base);
    var kb = new THREE.Mesh(new THREE.PlaneGeometry(2.0, 0.7), dark);
    kb.rotation.x = -Math.PI / 2;
    kb.position.set(0, 0.045, -0.25);
    g.add(kb);
    var hinge = new THREE.Group();
    hinge.position.set(0, 0.04, -0.8);
    hinge.rotation.x = -0.3;
    g.add(hinge);
    var lid = new THREE.Mesh(rbox(2.4, 1.55, 0.05, 0.1, 0.015), metal);
    lid.position.y = 0.78;
    hinge.add(lid);
    var sc = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 1.38), screen);
    sc.position.set(0, 0.78, 0.03);
    hinge.add(sc);
    var ui = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.16), white);
    ui.position.set(-0.3, 0.95, 0.035);
    hinge.add(ui);
    var ui2 = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.12), mid);
    ui2.position.set(-0.1, 0.66, 0.035);
    hinge.add(ui2);
    g.rotation.set(0.35, -0.55, 0);
    g.position.y = -0.35;
    g.scale.setScalar(0.92);
  } else if (name === 'docs') {
    for (var j = 0; j < 3; j++) {
      var p = new THREE.Mesh(rbox(1.5, 1.95, 0.04, 0.06, 0.012), j === 2 ? white : mid);
      p.position.set(j * 0.12, j * 0.08, j * 0.12);
      p.rotation.z = (j - 1) * 0.08;
      g.add(p);
    }
    for (var k = 0; k < 5; k++) {
      var ln = new THREE.Mesh(
        new THREE.BoxGeometry(k === 0 ? 0.7 : 1.05 - (k % 2) * 0.3, 0.07, 0.01),
        dark,
      );
      ln.position.set(0.24 - (k === 0 ? 0.18 : 0) + (k % 2) * -0.15, 0.62 - k * 0.24, 0.27);
      ln.rotation.z = 0.08;
      g.add(ln);
    }
    g.rotation.set(0.25, -0.5, 0.05);
  } else if (name === 'phone') {
    var b = new THREE.Mesh(rbox(1.05, 2.1, 0.12, 0.18, 0.03), metal);
    g.add(b);
    var s = new THREE.Mesh(rbox(0.95, 2.0, 0.01, 0.15, 0.004), screen);
    s.position.z = 0.065;
    g.add(s);
    var bub = new THREE.Mesh(rbox(0.7, 0.26, 0.02, 0.1, 0.006), white);
    bub.position.set(-0.05, 0.35, 0.08);
    g.add(bub);
    var bub2 = new THREE.Mesh(rbox(0.55, 0.22, 0.02, 0.1, 0.006), mid);
    bub2.position.set(0.1, 0.02, 0.08);
    g.add(bub2);
    var isl = new THREE.Mesh(rbox(0.3, 0.08, 0.01, 0.04, 0.003), dark);
    isl.position.set(0, 0.88, 0.075);
    g.add(isl);
    g.rotation.set(0.3, -0.55, 0.12);
  }
  return g;
}

if (!renderer) {
  body.classList.add('nogl');
}
var DPR = Math.min(window.devicePixelRatio || 1, 2);
var scene, cam, ht, mascot;
if (renderer) {
  renderer.setPixelRatio(DPR);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.autoClear = false;
  scene = new THREE.Scene();
  cam = new THREE.PerspectiveCamera(30, 1, 0.5, 60);
  cam.position.set(0, 0, 12);
  studio(scene);
  mascot = buildMascot();
  scene.add(mascot.root);
  ht = new Halftone(renderer, 5);

  /* thumbnails: render each object once through the same halftone pass */
  (function () {
    var tw = 320,
      th = 240,
      tr = null;
    try {
      tr = new THREE.WebGLRenderer({
        antialias: false,
        alpha: true,
        premultipliedAlpha: true,
        preserveDrawingBuffer: true,
      });
    } catch (e) {
      tr = null;
    }
    if (!tr) return;
    tr.setPixelRatio(2);
    tr.setSize(tw, th, false);
    tr.outputColorSpace = THREE.SRGBColorSpace;
    tr.autoClear = false;
    var tht = new Halftone(tr, 3.6);
    tht.setSize(tw, th, 2);
    var ts = new THREE.Scene();
    studio(ts, 1.05);
    var tc2 = new THREE.PerspectiveCamera(24, tw / th, 0.5, 40);
    tc2.position.set(0, 0, 7.4);
    ['key', 'db', 'laptop', 'docs', 'phone'].forEach(function (n) {
      var o = buildObj(n);
      ts.add(o);
      tht.render(ts, tc2, null, th);
      ts.remove(o);
      q('canvas[data-obj="' + n + '"]').forEach(function (cv) {
        cv.width = tw * 2;
        cv.height = th * 2;
        cv.getContext('2d').drawImage(tr.domElement, 0, 0, tw * 2, th * 2);
      });
    });
    tr.dispose();
    if (tr.forceContextLoss) tr.forceContextLoss();
  })();
}
function worldPerPx() {
  return (2 * cam.position.z * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2))) / H;
}
function renderGL(t) {
  if (!renderer) return;
  var m = mascotAt(t);
  mascot.root.visible = m.vis;
  if (m.vis) {
    var k = worldPerPx();
    var s = (m.h * k) / 2;
    mascot.root.scale.setScalar(s);
    mascot.root.position.set((m.cx - W / 2) * k, (H / 2 - m.cy) * k, 0);
    poseMascot(mascot, m);
  }
  ht.render(scene, cam, m.clip, H);
  var mb = m.clip;
  if (m.clip && !m.vis) renderer.clear();
}

/* =========================================================
   frame loop
   ========================================================= */
function resize() {
  measure();
  if (renderer) {
    renderer.setSize(W, H, false);
    cam.aspect = W / H;
    cam.updateProjectionMatrix();
    ht.setSize(W, H, DPR);
    ht.cellCss = portrait ? 4 : 5;
    ht.mat.uniforms.uCell.value = ht.cellCss * DPR;
  }
  /* scrub ticks */
  var tr = document.querySelector('.scrub .tr');
  q('.scrub .tk').forEach(function (e) {
    e.remove();
  });
  SHOTS.forEach(function (s, i) {
    if (!i) return;
    var k = document.createElement('i');
    k.className = 'tk';
    k.style.left = (s.a / TOTAL) * 100 + '%';
    tr.appendChild(k);
  });
  lastKey = '';
}
function filmP() {
  var r = film.getBoundingClientRect();
  return clamp(-r.top / Math.max(1, film.offsetHeight - innerHeight));
}
function filmScrollFor(t) {
  return film.offsetTop + (t / TOTAL) * (film.offsetHeight - innerHeight);
}
function pad(n) {
  return (n < 10 ? '0' : '') + n;
}
function tcode(t) {
  var s = Math.floor(t),
    f = Math.floor((t - s) * FPS);
  return '00:00:' + pad(s) + ':' + pad(f);
}

var lastKey = '',
  curT = 0,
  tgtT = 0,
  teaseT = 0,
  forcedTease = null,
  last = performance.now(),
  t0 = last,
  active = true;
function teaserToFilm(tt) {
  var acc = 0;
  for (var i = 0; i < TEASER.length; i++) {
    if (tt < acc + TEASER[i][1]) return TEASER[i][0] + (tt - acc);
    acc += TEASER[i][1];
  }
  return TEASER[TEASER.length - 1][0] + TEASER[TEASER.length - 1][1];
}

/* The nav reads the film's tone while the film is on screen, and turns solid after it. */
var tone = 'white';
function navState() {
  var inFilm = film.getBoundingClientRect().bottom > 60;
  body.dataset.tone = inFilm ? tone : 'white';
  nav.classList.toggle('onfilm', inFilm);
  nav.classList.toggle('solid', !inFilm);
}
addEventListener('scroll', navState, { passive: true });

function draw(ft, teasing, shownT) {
  var s = shotAt(ft);
  Object.keys(shots).forEach(function (k) {
    shots[k].classList.toggle('on', k === s.id);
  });
  Object.keys(bgs).forEach(function (k) {
    bgs[k].classList.toggle('on', k === s.bg);
  });
  tone = s.tone;
  navState();
  pin.classList.toggle('teasing', teasing);
  lbl.textContent = teasing ? '// teaser' : s.lbl;
  tc.textContent = tcode(shownT);
  fi.style.width = (teasing ? 0 : (ft / TOTAL) * 100) + '%';
  var wp = whip(ft);
  content.style.transform = wp.x ? 'translateX(' + wp.x.toFixed(2) + 'vw)' : '';
  content.style.filter = wp.b > 0.5 ? 'blur(' + wp.b.toFixed(1) + 'px)' : '';
  domUpdate(ft);
  /* speech bubble follows the mascot */
  if (s.id === 'hook') {
    var m = mascotAt(ft);
    bubble.style.left = m.cx - m.h * 0.58 - bubble.offsetWidth + 'px';
    bubble.style.top = m.cy + m.h * 0.02 - 18 + 'px';
  }
  renderGL(ft);
}
function stillOf(t) {
  var s = shotAt(t);
  return s.still;
}
function frame(now) {
  requestAnimationFrame(frame);
  var dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!active) return;
  var p = filmP();
  tgtT = p * TOTAL;
  var teasing = forcedTease !== null || (p <= 0.0004 && window.scrollY < 4);
  var ft, shown, key;
  if (teasing) {
    if (REDUCE) {
      ft = 38.5;
      shown = 0;
    } else {
      teaseT = forcedTease !== null ? forcedTease : ((now - t0) / 1000) % TEASE;
      ft = teaserToFilm(teaseT);
      shown = teaseT;
    }
    curT = 0;
  } else {
    if (REDUCE) curT = tgtT;
    else curT += (tgtT - curT) * (1 - Math.exp(-dt * 7));
    if (Math.abs(tgtT - curT) < 0.002) curT = tgtT;
    ft = REDUCE ? stillOf(curT) : curT;
    shown = curT;
  }
  key = ft.toFixed(4) + '|' + teasing + '|' + W + 'x' + H;
  if (key === lastKey) return;
  lastKey = key;
  draw(ft, teasing, shown);
}
var io = new IntersectionObserver(
  function (en) {
    active = en[0].isIntersecting;
  },
  { threshold: 0 },
);
io.observe(film);
addEventListener('resize', resize);
document.getElementById('scrub').addEventListener('click', function (e) {
  var r = this.getBoundingClientRect();
  var k = clamp((e.clientX - r.left) / r.width);
  scrollTo({ top: filmScrollFor(k * TOTAL) + 1, behavior: REDUCE ? 'auto' : 'smooth' });
});

/* test hooks: __setScroll(p) with p in 0..1 = film progress; p<0 = teaser (optional teaser time); __setFilm(seconds) */
window.__setScroll = function (p, tt) {
  if (p < 0) {
    scrollTo(0, 0);
    forcedTease = tt === undefined ? 1.2 : tt;
  } else {
    forcedTease = null;
    scrollTo(0, Math.max(5, filmScrollFor(p * TOTAL)));
    curT = tgtT = p * TOTAL;
  }
  lastKey = '';
  var teasing = forcedTease !== null;
  var ft = teasing ? teaserToFilm(forcedTease) : REDUCE ? stillOf(curT) : curT;
  draw(ft, teasing, teasing ? forcedTease : curT);
  lastKey = ft.toFixed(4) + '|' + teasing + '|' + W + 'x' + H;
};
window.__setFilm = function (sec) {
  window.__setScroll(sec / TOTAL);
};

resize();
var go = function () {
  resize();
  requestAnimationFrame(frame);
  window.__ready = true;
  if (qs.has('p')) window.__setScroll(parseFloat(qs.get('p')));
  else if (qs.has('t')) window.__setFilm(parseFloat(qs.get('t')));
};
if (document.fonts && document.fonts.ready) {
  Promise.race([
    document.fonts.ready,
    new Promise(function (r) {
      setTimeout(r, 1500);
    }),
  ]).then(go);
} else go();

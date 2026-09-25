// Small progressive enhancements. The page reads fine without any of this.
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

// Phone menu.
const navEl = document.getElementById('site-nav');
const menuBtn = navEl.querySelector('.menu-btn');
const setMenu = (open) => {
  navEl.classList.toggle('open', open);
  menuBtn.setAttribute('aria-expanded', String(open));
};
menuBtn.addEventListener('click', () => setMenu(!navEl.classList.contains('open')));
navEl.querySelectorAll('nav a').forEach((a) => a.addEventListener('click', () => setMenu(false)));

// Reveal sections as they scroll into view.
const io = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        e.target.classList.add('in');
        io.unobserve(e.target);
      }
    }
  },
  { threshold: 0.12 },
);
document.querySelectorAll('.reveal').forEach((el, i) => {
  el.style.transitionDelay = `${(i % 4) * 70}ms`;
  io.observe(el);
});

// Hero: keep re-encrypting the sample password into fresh ciphertext.
const ct = document.getElementById('ciphertext');
const hex = '0123456789abcdef';
const randomCipher = () =>
  Array.from({ length: 6 }, () =>
    Array.from({ length: 4 }, () => hex[Math.floor(Math.random() * 16)]).join(''),
  ).join('·');
if (ct && !reduced) {
  setInterval(() => {
    let frame = 0;
    const tick = setInterval(() => {
      ct.textContent = randomCipher();
      if (++frame > 8) clearInterval(tick);
    }, 45);
  }, 2600);
}

// Tour carousel: coverflow slides with buttons, dots, arrow keys, swipe and autoplay.
const carousel = document.getElementById('carousel');
const slides = [...carousel.querySelectorAll('.slide')];
const dotsEl = carousel.querySelector('.dots');
const label = document.getElementById('car-label');
const capText = document.getElementById('car-cap');
const caption = label.parentElement;
const AUTOPLAY_MS = 5000;
carousel.style.setProperty('--autoplay', `${AUTOPLAY_MS}ms`);
let current = 0;

const dots = slides.map((s, i) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.setAttribute('role', 'tab');
  b.setAttribute('aria-label', s.dataset.label);
  b.addEventListener('click', () => go(i));
  dotsEl.append(b);
  return b;
});

function layout(dragShift = 0) {
  const n = slides.length;
  slides.forEach((s, i) => {
    // Shortest signed distance around the loop, so it wraps both ways.
    let o = (((i - current) % n) + n) % n;
    if (o > n / 2) o -= n;
    const d = o + dragShift;
    const a = Math.abs(d);
    s.style.setProperty('--o', d.toFixed(3));
    s.style.setProperty('--d', Math.min(a, 3).toFixed(3));
    s.style.setProperty('--op', a > 2.2 ? '0' : String(Math.max(0, 1 - a * 0.35)));
    s.style.setProperty('--br', String(Math.max(0.35, 1 - a * 0.45)));
    s.style.setProperty('--z', String(100 - Math.round(a * 10)));
    s.classList.toggle('current', o === 0);
    s.setAttribute('aria-hidden', String(o !== 0));
  });
}

function go(i) {
  const n = slides.length;
  current = ((i % n) + n) % n;
  layout();
  dots.forEach((d, j) => {
    d.setAttribute('aria-selected', String(j === current));
  });
  label.textContent = slides[current].dataset.label;
  capText.textContent = slides[current].dataset.cap;
  caption.classList.remove('swap');
  void caption.offsetWidth;
  caption.classList.add('swap');
  restart();
}

// Autoplay: pauses on hover, focus, drag, or while the carousel is off screen.
let timer = 0;
let visible = false;
const holds = new Set();
function restart() {
  clearTimeout(timer);
  const paused = reduced || holds.size > 0 || !visible;
  carousel.classList.toggle('paused', paused);
  if (!paused) timer = setTimeout(() => go(current + 1), AUTOPLAY_MS);
}
const hold = (why, on) => {
  if (on) holds.add(why);
  else holds.delete(why);
  if (on) {
    clearTimeout(timer);
    carousel.classList.add('paused');
  } else restart();
};
carousel.addEventListener('mouseenter', () => hold('hover', true));
carousel.addEventListener('mouseleave', () => hold('hover', false));
carousel.addEventListener('focusin', () => hold('focus', true));
carousel.addEventListener('focusout', () => hold('focus', false));
new IntersectionObserver(([e]) => {
  visible = e.isIntersecting;
  restart();
}).observe(carousel);

carousel.querySelector('.prev').addEventListener('click', () => go(current - 1));
carousel.querySelector('.next').addEventListener('click', () => go(current + 1));
carousel.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') go(current - 1);
  else if (e.key === 'ArrowRight') go(current + 1);
  else return;
  e.preventDefault();
});
slides.forEach((s, i) => s.addEventListener('click', () => moved || go(i)));

// Swipe or drag: the deck follows the pointer, then settles on the nearest slide.
let startX = 0;
let dx = 0;
let dragging = false;
let moved = false;
const stage = carousel.querySelector('.stage');
stage.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  dragging = true;
  moved = false;
  startX = e.clientX;
  dx = 0;
  hold('drag', true);
});
window.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  dx = e.clientX - startX;
  if (Math.abs(dx) > 6 && !moved) {
    moved = true;
    carousel.classList.add('dragging');
    stage.setPointerCapture?.(e.pointerId);
  }
  if (moved) layout(dx / (stage.offsetWidth * 0.68));
});
const endDrag = () => {
  if (!dragging) return;
  dragging = false;
  carousel.classList.remove('dragging');
  hold('drag', false);
  if (!moved) return;
  const steps = Math.round(-dx / (stage.offsetWidth * 0.68));
  const nudge = Math.abs(dx) > 50 ? -Math.sign(dx) : 0;
  go(current + (steps || nudge));
  setTimeout(() => (moved = false), 0);
};
window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', endDrag);

go(0);

// Feature tiles: a glow that follows the pointer.
document.querySelectorAll('.tile').forEach((t) =>
  t.addEventListener('pointermove', (e) => {
    const r = t.getBoundingClientRect();
    t.style.setProperty('--mx', `${e.clientX - r.left}px`);
    t.style.setProperty('--my', `${e.clientY - r.top}px`);
  }),
);

// Feature tiles: live text in the little visuals.
const pick = (chars, n) =>
  Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
const tileCipher = document.querySelector('[data-cipher]');
const otp = document.querySelector('[data-otp]');
const gen = document.querySelector('[data-gen]');
if (!reduced) {
  setInterval(() => {
    tileCipher.textContent = [4, 4, 4].map((n) => pick(hex, n)).join('·');
  }, 1400);
  // Matches the 6 s countdown ring.
  setInterval(() => (otp.textContent = `${pick('0123456789', 3)} ${pick('0123456789', 3)}`), 6000);
  const pool = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!#$%&*';
  setInterval(() => {
    let f = 0;
    const t = setInterval(() => {
      gen.textContent = pick(pool, 14);
      if (++f > 10) clearInterval(t);
    }, 40);
  }, 2600);
}

// Waitlist form. Same-origin POST to the API; it answers 204 for every valid form.
const form = document.getElementById('waitlist-form');
const status = document.getElementById('waitlist-status');
const say = (text, kind = '') => {
  status.textContent = text;
  status.className = `status ${kind}`;
};
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  const email = form.elements.email;
  email.setAttribute('aria-invalid', String(!email.checkValidity() || !data.email.trim()));
  if (email.getAttribute('aria-invalid') === 'true') {
    return (say('Please enter a valid email address.', 'error'), email.focus());
  }
  const button = form.querySelector('button');
  button.disabled = true;
  say('Joining…');
  try {
    const res = await fetch('/v1/waitlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (res.ok) {
      form.classList.add('done');
      say("You're on the list. We'll be in touch.", 'ok');
      return;
    }
    say(
      res.status === 429
        ? 'Too many tries from your network. Try again in an hour.'
        : res.status === 400
          ? 'Please check your email address.'
          : 'Something went wrong. Try again in a moment.',
      'error',
    );
  } catch {
    say("Couldn't reach Zvault. Check your connection and try again.", 'error');
  }
  button.disabled = false;
});

// Terminal: type out an example session once it scrolls into view.
const script = [
  ['cmd', 'zv ls zv://payments-api/dev'],
  ['out', 'DATABASE_URL\nSTRIPE_SECRET_KEY'],
  ['cmd', 'zv run --env STRIPE_KEY=zv://payments-api/dev/STRIPE_SECRET_KEY -- npm test'],
  ['ok', 'Approve in Zvault… approved with Touch ID'],
  ['out', '> charging test card with key <span class="mask">********</span>\n✓ 42 tests passed'],
  ['cmd', 'zv agent pair --name "Claude Code"'],
  ['ok', 'Approve "Claude Code" in the Zvault app… paired'],
];
const term = document.getElementById('term');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function play() {
  if (reduced) {
    term.innerHTML = script
      .map(([k, t]) =>
        k === 'cmd'
          ? `<span class="p">$</span> <span class="c">${t}</span>`
          : k === 'ok'
            ? `<span class="ok">${t}</span>`
            : t,
      )
      .join('\n');
    return;
  }
  for (;;) {
    term.innerHTML = '';
    for (const [kind, text] of script) {
      if (kind === 'cmd') {
        const line = document.createElement('span');
        line.innerHTML =
          '<span class="p">$</span> <span class="c"></span><span class="cursor"></span>';
        term.append(line);
        const c = line.querySelector('.c');
        for (const ch of text) {
          c.textContent += ch;
          await sleep(22 + Math.random() * 40);
        }
        await sleep(350);
        line.querySelector('.cursor').remove();
        term.append('\n');
      } else {
        await sleep(kind === 'ok' ? 700 : 250);
        const out = document.createElement('span');
        if (kind === 'ok') out.className = 'ok';
        out.innerHTML = text + '\n';
        term.append(out);
      }
    }
    term.insertAdjacentHTML('beforeend', '<span class="p">$</span> <span class="cursor"></span>');
    await sleep(6000);
  }
}
const termIo = new IntersectionObserver((entries) => {
  if (entries[0].isIntersecting) {
    termIo.disconnect();
    void play();
  }
});
termIo.observe(term);

// Agent flow: the agent asks, Zvault approves, the tool runs. Cycles through tools.
const flows = {
  aws: {
    ask: '"Check CloudWatch for errors"',
    secret: 'AWS_SECRET_ACCESS_KEY',
    icon: '☁️',
    target: 'CloudWatch',
    result: '12 errors in the last hour',
    cmd: 'zv run --env AWS_SECRET_ACCESS_KEY=zv://infra/prod/aws/AWS_SECRET_ACCESS_KEY -- aws logs tail /ecs/api --since 1h',
  },
  azure: {
    ask: '"Why is the web app restarting?"',
    secret: 'AZURE_CLIENT_SECRET',
    icon: '🔷',
    target: 'Azure Monitor',
    result: 'Out of memory at 09:42',
    cmd: 'zv run --env-from zv://infra/prod/azure -- az webapp log tail -n web -g prod',
  },
  stripe: {
    ask: '"Refund order #4821"',
    secret: 'STRIPE_SECRET_KEY',
    icon: '💳',
    target: 'Stripe',
    result: 'Refund issued',
    cmd: 'zv run --env STRIPE_API_KEY=zv://payments-api/prod/STRIPE_SECRET_KEY -- stripe refunds create --charge ch_3Pq…',
  },
  jira: {
    ask: '"File a bug for this crash"',
    secret: 'JIRA_API_TOKEN',
    icon: '📋',
    target: 'Jira',
    result: 'Created ZV-142',
    cmd: 'zv run --env JIRA_API_TOKEN=zv://tools/shared/JIRA_API_TOKEN -- jira issue create -t Bug -s "Crash on unlock"',
  },
  gh: {
    ask: '"Open a PR with the fix"',
    secret: 'GITHUB_TOKEN',
    icon: '🐙',
    target: 'GitHub',
    result: 'Pull request opened',
    cmd: 'zv run --env GH_TOKEN=zv://tools/shared/GITHUB_TOKEN -- gh pr create --fill',
  },
};
const af = document.getElementById('agentflow');
if (af) {
  const $ = (id) => document.getElementById(id);
  const toolBtns = [...af.querySelectorAll('.tools button')];
  const steps = [...af.querySelectorAll('.step')];
  const pipes = [...af.querySelectorAll('.pipe')];
  let run = 0;
  let afVisible = false;
  let afHover = false;
  let touched = 0;
  const show = async (key) => {
    const my = ++run;
    const f = flows[key];
    toolBtns.forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tool === key)));
    $('af-ask').textContent = f.ask;
    $('af-secret').textContent = f.secret;
    $('af-icon').textContent = f.icon;
    $('af-target').textContent = f.target;
    $('af-result').textContent = f.result;
    $('af-cmd').textContent = f.cmd;
    if (reduced) return steps.forEach((s) => s.classList.add('on'));
    steps.forEach((s) => s.classList.remove('on'));
    pipes.forEach((p) => p.classList.remove('on'));
    const seq = [
      () => steps[0].classList.add('on'),
      () => pipes[0].classList.add('on'),
      () => steps[1].classList.add('on'),
      () => pipes[1].classList.add('on'),
      () => steps[2].classList.add('on'),
    ];
    for (const s of seq) {
      await sleep(550);
      if (my !== run) return;
      s();
    }
  };
  const keys = Object.keys(flows);
  let at = 0;
  toolBtns.forEach((b) =>
    b.addEventListener('click', () => {
      at = keys.indexOf(b.dataset.tool);
      touched = Date.now();
      void show(b.dataset.tool);
    }),
  );
  af.addEventListener('mouseenter', () => (afHover = true));
  af.addEventListener('mouseleave', () => (afHover = false));
  new IntersectionObserver(([e]) => (afVisible = e.isIntersecting)).observe(af);
  void show(keys[0]);
  if (!reduced) {
    setInterval(() => {
      // Pause while pointed at, and for a while after someone picks a tool.
      if (!afVisible || afHover || Date.now() - touched < 12000) return;
      at = (at + 1) % keys.length;
      void show(keys[at]);
    }, 5200);
  }
}

// The sections after the film: reveals, the Mac screen tabs, the terminal and the waitlist.
// The page reads fine without any of this. film.js runs the launch film at the top.
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

// Headings reveal word by word, like the film's titles.
document.querySelectorAll('.words').forEach((h) => {
  let i = 0;
  for (const child of [...h.childNodes]) {
    if (child.nodeType === Node.TEXT_NODE) {
      const frag = document.createDocumentFragment();
      for (const p of child.textContent.split(/(\s+)/)) {
        if (!p) continue;
        if (/^\s+$/.test(p)) {
          frag.append(' ');
          continue;
        }
        const w = document.createElement('span');
        w.className = 'w';
        w.style.setProperty('--i', String(i++));
        w.textContent = p;
        frag.append(w);
      }
      child.replaceWith(frag);
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      child.classList.add('w');
      child.style.setProperty('--i', String(i++));
    }
  }
});

// Reveal things as they scroll into view.
const io = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        e.target.classList.add('in');
        io.unobserve(e.target);
      }
    }
  },
  { threshold: 0.15 },
);
document.querySelectorAll('.reveal, .words').forEach((el) => {
  // Siblings in a row (phones, facts) arrive one after another.
  const row = [...el.parentElement.querySelectorAll(':scope > .reveal')];
  const idx = row.indexOf(el);
  if (idx > 0) el.style.transitionDelay = `${Math.min(idx, 5) * 90}ms`;
  io.observe(el);
});

// Mac screens: tabs switch the window; autoplay while the section is on screen.
const show = document.getElementById('show');
const tabs = [...show.querySelectorAll('[role="tab"]')];
const shots = [...show.querySelectorAll('.w-stage img')];
const AUTOPLAY_MS = 5000;
show.style.setProperty('--autoplay', `${AUTOPLAY_MS}ms`);
let current = 0;
let timer = 0;
let visible = false;
let hovering = false;
function schedule() {
  clearTimeout(timer);
  const playing = !reduced && visible && !hovering;
  show.classList.toggle('playing', playing);
  if (playing) timer = setTimeout(() => select(current + 1), AUTOPLAY_MS);
}
function select(i) {
  current = (i + tabs.length) % tabs.length;
  tabs.forEach((t, j) => t.setAttribute('aria-selected', String(j === current)));
  shots.forEach((s, j) => s.classList.toggle('on', j === current));
  // Restart the progress bar on the selected tab.
  show.classList.remove('playing');
  void show.offsetWidth;
  schedule();
}
tabs.forEach((t, i) => t.addEventListener('click', () => select(i)));
show.addEventListener('keydown', (e) => {
  const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
  if (!step) return;
  e.preventDefault();
  select(current + step);
  tabs[current].focus();
});
show.addEventListener('mouseenter', () => {
  hovering = true;
  schedule();
});
show.addEventListener('mouseleave', () => {
  hovering = false;
  select(current);
});
new IntersectionObserver(([e]) => {
  visible = e.isIntersecting;
  schedule();
}).observe(show);

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
const prompt = '<span class="p">$</span> ';
async function play() {
  if (reduced) {
    term.innerHTML = script
      .map(([k, t]) => (k === 'cmd' ? prompt + t : k === 'ok' ? `<span class="ok">${t}</span>` : t))
      .join('\n');
    return;
  }
  for (;;) {
    term.innerHTML = '';
    for (const [kind, text] of script) {
      if (kind === 'cmd') {
        const line = document.createElement('span');
        line.innerHTML = `${prompt}<span class="c"></span><span class="caret"></span>`;
        term.append(line);
        const c = line.querySelector('.c');
        for (const ch of text) {
          c.textContent += ch;
          await sleep(20 + Math.random() * 36);
        }
        await sleep(350);
        line.querySelector('.caret').remove();
        term.append('\n');
      } else {
        await sleep(kind === 'ok' ? 700 : 250);
        const out = document.createElement('span');
        if (kind === 'ok') out.className = 'ok';
        out.innerHTML = text + '\n';
        term.append(out);
      }
    }
    term.insertAdjacentHTML('beforeend', `${prompt}<span class="caret"></span>`);
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

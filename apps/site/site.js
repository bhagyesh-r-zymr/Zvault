// Small progressive enhancements. The page reads fine without any of this.
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

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

// Screenshot tour.
const img = document.getElementById('tour-img');
const cap = document.getElementById('tour-cap');
const tabs = document.querySelectorAll('.tabs [role="tab"]');
tabs.forEach((tab) =>
  tab.addEventListener('click', () => {
    tabs.forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
    img.classList.add('swap');
    setTimeout(() => {
      img.src = `/img/${tab.dataset.img}.webp`;
      img.alt = tab.dataset.cap;
      cap.textContent = tab.dataset.cap;
      img.onload = () => img.classList.remove('swap');
    }, 180);
  }),
);
// Warm the cache so switching tabs is instant.
tabs.forEach((t) => (new Image().src = `/img/${t.dataset.img}.webp`));

// Copy buttons.
document.querySelectorAll('[data-copy]').forEach((btn) =>
  btn.addEventListener('click', async () => {
    const text = document.getElementById(btn.dataset.copy).textContent;
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'Copied';
    } catch {
      btn.textContent = 'Select it';
    }
    setTimeout(() => (btn.textContent = 'Copy'), 1600);
  }),
);

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

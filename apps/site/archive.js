// Hero: the floating archive.
//
// A hexagonal aperture spirals open onto a void of floating drawers. Scrolling
// drifts the camera through it, past six drawers; each slides out and hands you
// a glass card with one part of Zvault, while the matching caption (real text in
// index.html) fades in beside it. Everything is a function of scroll progress,
// so it plays backwards too.
//
// head.js sets html.archive-on when WebGL and full motion are available. With
// reduced motion this renders one still frame in place of the hero screenshot.
// Without WebGL, site.js drops back to the static hero.
import * as THREE from '/vendor/three.module.min.js';

const root = document.documentElement;
const section = document.getElementById('archive');
const canvas = section && section.querySelector('.archive-canvas');
const animated = root.classList.contains('archive-on');
const still = !animated && matchMedia('(prefers-reduced-motion: reduce)').matches;

function start() {
  const small = Math.min(screen.width, screen.height) < 700 || navigator.hardwareConcurrency <= 4;
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    stencil: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, small ? 1.5 : 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 160);
  scene.environment = environment(renderer);
  scene.environmentIntensity = 1.5;
  scene.fog = new THREE.FogExp2(0x080a14, 0.04);

  // ---------- helpers ----------
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const seg = (p, a, b) => clamp((p - a) / (b - a));
  const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  const smooth = (x) => x * x * (3 - 2 * x);
  const lerp = (a, b, t) => a + (b - a) * t;
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

  const brushed = brushedTexture();
  const metal = (color, roughness, metalness = 0.9, extra = {}) =>
    new THREE.MeshStandardMaterial({
      color,
      roughness,
      metalness,
      roughnessMap: brushed,
      ...extra,
    });

  // Interior materials only draw through the aperture until the camera is inside.
  const portalMats = [];
  const inside = (m) => {
    m.stencilWrite = true;
    m.stencilRef = 1;
    m.stencilFunc = THREE.EqualStencilFunc;
    portalMats.push(m);
    return m;
  };
  const setInside = (on) =>
    portalMats.forEach(
      (m) => (m.stencilFunc = on ? THREE.AlwaysStencilFunc : THREE.EqualStencilFunc),
    );

  // ---------- lights ----------
  scene.add(new THREE.HemisphereLight(0xb4bbd4, 0x0b0d14, 0.9));
  const key = new THREE.DirectionalLight(0xe4e9ff, 2.2);
  key.position.set(4, 8, 7);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x6f7dff, 0.9);
  rim.position.set(-6, 2, -4);
  scene.add(rim);
  // A soft lamp that travels a little ahead of the camera, so nearby drawers
  // catch light and far ones fall off into the dark.
  const lamp = new THREE.PointLight(0xc4ccff, 14, 18, 1.5);
  scene.add(lamp);

  // ---------- the aperture ----------
  const RI = 1.8;
  const gate = new THREE.Group();
  scene.add(gate);
  const hex = (r, rot = Math.PI / 6) => {
    const s = new THREE.Shape();
    for (let i = 0; i < 6; i++) {
      const a = rot + (i * Math.PI) / 3;
      if (i) s.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      else s.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    s.closePath();
    return s;
  };
  const gunmetal = metal(0x3a4050, 0.5, 0.7);
  const steel = metal(0x5a6276, 0.34, 0.9);
  const bright = metal(0xb4bccc, 0.3, 1);

  const frameShape = hex(3.0);
  frameShape.holes.push(new THREE.Path(hex(RI + 0.22).getPoints()));
  const frameGeo = new THREE.ExtrudeGeometry(frameShape, {
    depth: 0.6,
    bevelEnabled: true,
    bevelThickness: 0.08,
    bevelSize: 0.08,
    bevelSegments: 4,
  });
  frameGeo.translate(0, 0, -0.3);
  gate.add(new THREE.Mesh(frameGeo, gunmetal));
  // Machined bore: a deeper, brighter ring inside the frame.
  const boreShape = hex(RI + 0.24);
  boreShape.holes.push(new THREE.Path(hex(RI).getPoints()));
  const boreGeo = new THREE.ExtrudeGeometry(boreShape, {
    depth: 1.0,
    bevelEnabled: true,
    bevelThickness: 0.03,
    bevelSize: 0.03,
    bevelSegments: 2,
  });
  boreGeo.translate(0, 0, -0.62);
  gate.add(new THREE.Mesh(boreGeo, steel));
  // Engraved dial ticks around the opening; they turn as it unlocks.
  const dial = new THREE.Group();
  gate.add(dial);
  const tickGeo = new THREE.BoxGeometry(0.018, 0.12, 0.02);
  const tickMajorGeo = new THREE.BoxGeometry(0.03, 0.22, 0.02);
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * Math.PI * 2;
    const t = new THREE.Mesh(i % 6 ? tickGeo : tickMajorGeo, bright);
    const r = i % 6 ? 2.5 : 2.46;
    t.position.set(Math.cos(a) * r, Math.sin(a) * r, 0.39);
    t.rotation.z = a - Math.PI / 2;
    dial.add(t);
  }
  // Six locking bolts at the corners of the opening.
  const bolts = [];
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 6 + (i * Math.PI) / 3;
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.55, 20), bright);
    b.rotation.z = a - Math.PI / 2;
    b.userData.a = a;
    gate.add(b);
    bolts.push(b);
  }
  // Status light under the opening: iris while locked, mint when open.
  const statusMat = new THREE.MeshBasicMaterial({ color: 0x6f7dff });
  const status = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.035, 0.02), statusMat);
  status.position.set(0, -2.62, 0.39);
  gate.add(status);
  // The iris: six blades that spiral out of the way.
  const bladeMat = metal(0x4a5166, 0.32, 0.85);
  const bladeEdgeMat = new THREE.LineBasicMaterial({
    color: 0x8ea0ff,
    transparent: true,
    opacity: 0.35,
  });
  const blades = [];
  for (let i = 0; i < 6; i++) {
    const a0 = Math.PI / 6 + (i * Math.PI) / 3;
    const a1 = a0 + Math.PI / 3;
    const r = RI + 0.04;
    const s = new THREE.Shape();
    s.moveTo(0, 0);
    s.lineTo(Math.cos(a0) * r, Math.sin(a0) * r);
    s.lineTo(Math.cos(a1) * r, Math.sin(a1) * r);
    s.closePath();
    const g = new THREE.ExtrudeGeometry(s, {
      depth: 0.06,
      bevelEnabled: true,
      bevelThickness: 0.012,
      bevelSize: 0.012,
      bevelSegments: 1,
    });
    g.translate(0, 0, -0.03 + i * 0.004);
    const blade = new THREE.Group();
    blade.add(new THREE.Mesh(g, bladeMat));
    blade.add(
      new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          V(0, 0, 0.05),
          V(Math.cos(a0) * r, Math.sin(a0) * r, 0.05),
        ]),
        bladeEdgeMat,
      ),
    );
    blade.userData.mid = (a0 + a1) / 2;
    gate.add(blade);
    blades.push(blade);
  }
  const coreMat = new THREE.MeshStandardMaterial({
    color: 0x111522,
    emissive: 0x6f7dff,
    emissiveIntensity: 1.2,
    metalness: 0.4,
    roughness: 0.3,
  });
  const core = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.08, 6), coreMat);
  core.rotation.x = Math.PI / 2;
  core.position.z = 0.06;
  gate.add(core);
  // Stencil mask for the opening.
  const portal = new THREE.Mesh(
    new THREE.ShapeGeometry(hex(RI), 1),
    new THREE.MeshBasicMaterial({
      colorWrite: false,
      depthWrite: false,
      stencilWrite: true,
      stencilRef: 1,
      stencilFunc: THREE.AlwaysStencilFunc,
      stencilZPass: THREE.ReplaceStencilOp,
    }),
  );
  portal.renderOrder = -1;
  gate.add(portal);

  // ---------- the archive ----------
  const world = new THREE.Group();
  scene.add(world);
  world.add(backdrop(inside));

  // Six drawers along the path, one per chapter. x alternates so the path meanders.
  const STATIONS = [
    V(1.7, 0.2, -9),
    V(-1.8, -0.4, -16),
    V(1.6, 0.6, -23),
    V(-1.7, -0.1, -30),
    V(1.8, 0.4, -37),
    V(-1.6, -0.3, -44),
  ];
  const Z_END = -52;

  // Nominal camera path, only for keeping floating drawers off it.
  const nominal = [V(0, 0, 4), V(0, 0, -3)];
  STATIONS.forEach((s) =>
    nominal.push(V(s.x * 0.1, s.y + 0.6, s.z + 3.6), V(s.x * 0.1, s.y + 0.5, s.z + 2)),
  );
  nominal.push(V(0, 1.2, Z_END));
  const nearPath = (p, r) => {
    for (let i = 0; i < nominal.length - 1; i++) {
      const a = nominal[i];
      const b = nominal[i + 1];
      const ab = b.clone().sub(a);
      const t = clamp(p.clone().sub(a).dot(ab) / ab.lengthSq());
      if (a.clone().addScaledVector(ab, t).distanceTo(p) < r) return true;
    }
    return false;
  };

  // Floating cabinets: one InstancedMesh per part, all sharing one matrix buffer.
  const cabinet = cabinetParts();
  const cells = [];
  const want = small ? 300 : 620;
  for (let tries = 0; cells.length < want && tries < 20000; tries++) {
    const p = V(lerp(-11, 11, rand()), lerp(-7, 7, rand()), lerp(-2.5, -70, rand()));
    if (nearPath(p, 2.1)) continue;
    if (STATIONS.some((s) => s.distanceTo(p) < 2.6)) continue;
    if (cells.some((c) => c.p.distanceTo(p) < 1.25)) continue;
    cells.push({
      p,
      s: lerp(0.75, 1.45, rand()),
      yaw: lerp(-0.5, 0.5, rand()) - p.x * 0.03,
      pitch: lerp(-0.14, 0.14, rand()),
      roll: lerp(-0.08, 0.08, rand()),
      ph: rand() * 6.28,
    });
  }
  const bodyMat = inside(metal(0x2c3140, 0.5, 0.6));
  const frontMat = inside(metal(0x3a4154, 0.38, 0.7));
  const handleMat = inside(metal(0xa9b1c2, 0.28, 1));
  const labelMat = inside(
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0 }),
  );
  const ledMat = inside(new THREE.MeshBasicMaterial({ color: 0xffffff }));
  const bodies = new THREE.InstancedMesh(cabinet.body, bodyMat, cells.length);
  const fronts = new THREE.InstancedMesh(cabinet.front, frontMat, cells.length);
  const handles = new THREE.InstancedMesh(cabinet.handle, handleMat, cells.length);
  const labels = new THREE.InstancedMesh(cabinet.label, labelMat, cells.length);
  const leds = new THREE.InstancedMesh(cabinet.led, ledMat, cells.length);
  bodies.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  [fronts, handles, labels, leds].forEach((m) => (m.instanceMatrix = bodies.instanceMatrix));
  const paper = new THREE.Color(0x3e424c);
  const ledColors = [0x3a46b8, 0x3a46b8, 0x4c5be8, 0x2c7a5e, 0x45d6a0, 0x6b4f8f].map(
    (c) => new THREE.Color(c),
  );
  cells.forEach((c, i) => {
    labels.setColorAt(i, paper.clone().multiplyScalar(lerp(0.55, 1.1, rand())));
    leds.setColorAt(i, ledColors[Math.floor(rand() * ledColors.length)]);
  });
  world.add(bodies, fronts, handles, labels, leds);
  const M = new THREE.Matrix4();
  const Q = new THREE.Quaternion();
  const E = new THREE.Euler();
  const S = new THREE.Vector3();
  const P = new THREE.Vector3();
  const placeCells = (t) => {
    cells.forEach((c, i) => {
      P.set(c.p.x, c.p.y + Math.sin(t * 0.32 + c.ph) * 0.07, c.p.z);
      E.set(
        c.pitch + Math.sin(t * 0.23 + c.ph) * 0.025,
        c.yaw + Math.sin(t * 0.19 + c.ph * 1.3) * 0.05,
        c.roll,
      );
      Q.setFromEuler(E);
      S.setScalar(c.s);
      M.compose(P, Q, S);
      bodies.setMatrixAt(i, M);
    });
    bodies.instanceMatrix.needsUpdate = true;
  };

  // Dust in the air, lit by the lamp.
  const dustN = small ? 500 : 1400;
  const dustPos = new Float32Array(dustN * 3);
  for (let i = 0; i < dustN; i++) {
    dustPos[i * 3] = lerp(-10, 10, rand());
    dustPos[i * 3 + 1] = lerp(-6, 6, rand());
    dustPos[i * 3 + 2] = lerp(-1, -68, rand());
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  const dust = new THREE.Points(
    dustGeo,
    inside(
      new THREE.PointsMaterial({
        color: 0xaab4e8,
        size: 0.028,
        map: dotTexture(),
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
      }),
    ),
  );
  world.add(dust);

  // Faint shafts of light from above.
  const shaftTex = shaftTexture();
  [
    [-5, -14, 0.25],
    [4.5, -27, -0.2],
    [-3.5, -41, 0.15],
  ].forEach(([x, z, tilt]) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(2.4, 26),
      inside(
        new THREE.MeshBasicMaterial({
          map: shaftTex,
          color: 0x8e9cff,
          transparent: true,
          opacity: 0.07,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      ),
    );
    m.position.set(x, 4, z);
    m.rotation.set(0, 0.5, tilt);
    world.add(m);
  });

  // ---------- the six chapter drawers and their cards ----------
  const chapterEls = [...section.querySelectorAll('.chapter')];
  const CARDS = [drawZeroKnowledge, drawAgents, drawProjects, drawSharing, drawCli, drawAndroid];
  const CODES = ['ZK · 01', 'AG · 02', 'PR · 03', 'SH · 04', 'CL · 05', 'AN · 06'];
  const redraws = [];
  const stations = STATIONS.map((pos, i) => {
    const side = Math.sign(pos.x);
    const g = new THREE.Group();
    g.position.copy(pos);
    g.rotation.set(0.04, -side * 0.42, side * 0.03);
    world.add(g);
    const body = new THREE.Mesh(roundedBox(1.9, 0.66, 1.5, 0.05), bodyMat);
    g.add(body);
    // The drawer: front panel, handle, label holder and an open tray behind it.
    const drawer = new THREE.Group();
    g.add(drawer);
    const front = new THREE.Mesh(roundedBox(1.74, 0.52, 0.07, 0.02), frontMat);
    front.position.z = 0.76;
    drawer.add(front);
    const handle = new THREE.Mesh(roundedBox(0.56, 0.06, 0.07, 0.025), handleMat);
    handle.position.set(0, 0.1, 0.83);
    drawer.add(handle);
    const labelTex = labelTexture(CODES[i]);
    const label = new THREE.Mesh(
      new THREE.PlaneGeometry(0.36, 0.1),
      inside(new THREE.MeshStandardMaterial({ map: labelTex, roughness: 0.8, metalness: 0 })),
    );
    label.position.set(0, -0.1, 0.808);
    drawer.add(label);
    const holder = new THREE.Mesh(roundedBox(0.42, 0.14, 0.02, 0.008), handleMat);
    holder.position.set(0, -0.1, 0.795);
    drawer.add(holder);
    const trayMat = inside(metal(0x2a303e, 0.45, 0.6));
    const tray = new THREE.Group();
    tray.position.z = 0.05;
    drawer.add(tray);
    const floor = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.025, 1.4), trayMat);
    floor.position.y = -0.2;
    tray.add(floor);
    [-0.79, 0.79].forEach((x) => {
      const w = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.38, 1.4), trayMat);
      w.position.set(x, -0.02, 0);
      tray.add(w);
    });
    const back = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.38, 0.025), trayMat);
    back.position.set(0, -0.02, -0.69);
    tray.add(back);
    const glowMat = inside(
      new THREE.MeshBasicMaterial({
        color: 0x45d6a0,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      }),
    );
    const glowPlane = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.3), glowMat);
    glowPlane.rotation.x = -Math.PI / 2;
    glowPlane.position.y = -0.185;
    tray.add(glowPlane);
    const light = new THREE.PointLight(0x45d6a0, 0, 3.2, 2);
    light.position.set(0, 0.3, 1.2);
    g.add(light);

    const card = makeCard(CARDS[i]);
    world.add(card);
    return { g, side, drawer, glowMat, light, card };
  });

  // Where each card rests (in its tray) and where it hovers (facing the camera).
  const flatQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
  const layoutStations = (dist) => {
    stations.forEach((st) => {
      st.g.updateMatrixWorld(true);
      st.hover = st.g.localToWorld(V(0, 0.78, 1.05));
      st.dir = V(-st.side * 0.46, 0.12, 1).normalize();
      st.cam = st.hover.clone().addScaledVector(st.dir, dist);
      const o = new THREE.Object3D();
      o.position.copy(st.hover);
      o.lookAt(st.cam);
      st.hoverQ = o.quaternion.clone();
    });
  };

  // ---------- layout: framing for wide screens and for stacked (phone) layout ----------
  const heroCopy = section.querySelector('.hero-copy');
  const shade = section.querySelector('.archive-shade');
  const endEl = section.querySelector('.archive-end');
  const hint = section.querySelector('.archive-hint');
  const L = {
    w: 1,
    h: 1,
    wide: true,
    fovTan: 1,
    zs: 12,
    dist: 3.4,
    hero: V(0, 0, 0),
    chap: V(0, 0, 0),
  };
  let keys = [];

  function resize() {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    L.w = w;
    L.h = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    L.wide = animated ? w >= 900 && w > h : true;
    camera.fov = L.wide ? 35 : 48;
    L.fovTan = Math.tan((camera.fov * Math.PI) / 360);
    if (!animated) {
      // Still frame: the aperture centred and filling most of the square.
      L.zs = (3.15 * (h / 2)) / (Math.min(w, h) * 0.4 * L.fovTan);
      L.hero.set(0, 0, 0);
    } else if (L.wide) {
      const r = Math.min(h * 0.36, w * 0.25);
      L.zs = (3.15 * (h / 2)) / (r * L.fovTan);
      L.hero.set(w * 0.24, 0, 0);
      L.chap.set(w * 0.2, 0, 0);
      L.dist = clamp((0.65 * (h / 2)) / (w * 0.165 * L.fovTan), 2.4, 5);
    } else {
      const copyBottom = heroCopy.offsetTop + heroCopy.offsetHeight;
      const free = Math.max(h - copyBottom - 24, h * 0.3);
      const r = Math.min(free * 0.46, w * 0.44);
      L.zs = (3.15 * (h / 2)) / (r * L.fovTan);
      L.hero.set(0, copyBottom + free / 2 - h / 2, 0);
      L.chap.set(0, -h * 0.19, 0);
      L.dist = clamp(
        Math.max((0.65 * (h / 2)) / (w * 0.42 * L.fovTan), (0.4 * (h / 2)) / (h * 0.2 * L.fovTan)),
        2.4,
        6,
      );
    }
    camera.updateProjectionMatrix();
    layoutStations(L.dist);
    keys = buildKeys();
  }

  // Camera keyframes: [progress, position, look-at, linear drift?]
  const T0 = 0.27;
  const STEP = 0.105;
  const DWELL = 0.055;
  function buildKeys() {
    const k = [
      [0, V(0, 0, L.zs), V(0, 0, 0)],
      [0.12, V(0, 0, L.zs * 0.72), V(0, 0, -1)],
      [0.205, V(0, 0.08, -2.4), V(0, 0.05, -12)],
    ];
    stations.forEach((st, i) => {
      const a = T0 + i * STEP;
      k.push([a, st.cam.clone().addScaledVector(st.dir, 0.55), st.hover.clone()]);
      k.push([
        a + DWELL,
        st.cam
          .clone()
          .addScaledVector(st.dir, -0.3)
          .add(V(0, 0, -0.45)),
        st.hover.clone().add(V(0, 0, -0.2)),
        true,
      ]);
    });
    k.push([0.965, V(0, 1.1, Z_END + 4), V(0, 0.4, Z_END - 40)]);
    k.push([1, V(0, 1.12, Z_END + 3.8), V(0, 0.4, Z_END - 40)]);
    const pos = new THREE.CatmullRomCurve3(
      k.map((x) => x[1]),
      false,
      'centripetal',
    );
    const look = new THREE.CatmullRomCurve3(
      k.map((x) => x[2]),
      false,
      'centripetal',
    );
    return { k, pos, look };
  }
  const curveU = (p) => {
    const k = keys.k;
    let i = 0;
    while (i < k.length - 2 && p >= k[i + 1][0]) i++;
    const s = clamp((p - k[i][0]) / (k[i + 1][0] - k[i][0]));
    const e = k[i + 1][3] ? s : lerp(s, smooth(s), 0.75);
    return (i + e) / (k.length - 1);
  };

  // ---------- per-frame update ----------
  const iris = new THREE.Color(0x6f7dff);
  const mint = new THREE.Color(0x45d6a0);
  const lookAt = new THREE.Vector3();
  const pointer = { x: 0, y: 0, sx: 0, sy: 0 };
  const shift = new THREE.Vector3();
  const domCache = new Map();
  const setStyle = (el, prop, value) => {
    const key = el.className + prop + (chapterEls.indexOf(el) + 1);
    if (domCache.get(key) === value) return;
    domCache.set(key, value);
    el.style.setProperty(prop, value);
  };
  const fade = (el, o, y) => {
    setStyle(el, 'opacity', o.toFixed(3));
    setStyle(el, 'visibility', o > 0.02 ? 'visible' : 'hidden');
    if (y !== undefined) setStyle(el, '--y', y.toFixed(1));
  };

  function update(p, t) {
    // Aperture: unlock, then spiral open.
    const unlock = ease(seg(p, 0.015, 0.07));
    const open = ease(seg(p, 0.055, 0.16));
    coreMat.emissive.copy(iris).lerp(mint, unlock);
    statusMat.color.copy(iris).lerp(mint, unlock);
    core.scale.setScalar(1 - open * 0.999);
    dial.rotation.z = unlock * (Math.PI / 6) + open * 0.2;
    bolts.forEach((b) => {
      const r = RI + 0.02 + unlock * 0.34;
      b.position.set(Math.cos(b.userData.a) * r, Math.sin(b.userData.a) * r, 0);
    });
    blades.forEach((b) => {
      const m = b.userData.mid + open * 0.95;
      b.rotation.z = open * 0.95;
      b.position.set(Math.cos(m) * open * 1.5, Math.sin(m) * open * 1.5, -0.1 * open);
      b.scale.setScalar(1 - 0.45 * open);
      b.visible = open < 0.995;
    });
    // Slow idle turn of the whole gate on the hero screen; settles as you enter.
    const settle = 1 - seg(p, 0.06, 0.18);
    gate.rotation.set(
      (0.06 + pointer.sy * 0.05) * settle,
      (-0.2 + pointer.sx * 0.1 + Math.sin(t * 0.35) * 0.03) * settle,
      0,
    );

    if (animated) placeCells(t);
    dust.position.y = Math.sin(t * 0.07) * 0.3;
    dust.rotation.z = Math.sin(t * 0.03) * 0.02;

    // Camera.
    const u = curveU(p);
    keys.pos.getPoint(u, camera.position);
    keys.look.getPoint(u, lookAt);
    const inWorld = p > 0.19 ? 1 : 0;
    camera.position.x += Math.sin(t * 0.61) * 0.025 * inWorld;
    camera.position.y += Math.sin(t * 0.83 + 1.3) * 0.02 * inWorld;
    lookAt.x += pointer.sx * 0.25 * seg(p, 0.2, 0.3);
    lookAt.y -= pointer.sy * 0.15 * seg(p, 0.2, 0.3);
    camera.lookAt(lookAt);
    setInside(camera.position.z < 0.25);
    gate.visible = camera.position.z > -1;
    lamp.position.copy(camera.position).add(V(0.6, 0.9, -2.5));

    // Framing: shift the picture right (wide) or down/up (stacked) as the story moves.
    const hs = 1 - smooth(seg(p, 0.1, 0.22));
    const es = smooth(seg(p, 0.88, 0.96));
    shift
      .copy(L.hero)
      .multiplyScalar(hs)
      .addScaledVector(L.chap, (1 - hs) * (1 - es));
    camera.setViewOffset(L.w, L.h, -shift.x, -shift.y, L.w, L.h);

    // Drawers and cards.
    let active = -1;
    stations.forEach((st, i) => {
      const a = T0 + i * STEP;
      const dr = ease(seg(p, a - 0.045, a - 0.01));
      const cr = ease(seg(p, a - 0.028, a + 0.022));
      st.drawer.position.z = dr * 1.0;
      st.glowMat.opacity = dr * 0.16;
      st.light.intensity = dr * 2.2 + cr * 1.2;
      // Card: lying in the tray, then lifting and turning to face you.
      st.drawer.updateMatrixWorld(true);
      const rest = st.drawer.localToWorld(V(0, -0.14, 0.05));
      const restQ = st.g.quaternion.clone().multiply(flatQ);
      const c = st.card;
      c.visible = dr > 0.05;
      c.position.lerpVectors(rest, st.hover, cr);
      c.position.y += Math.sin(Math.PI * cr) * 0.25 + Math.sin(t * 0.9 + i) * 0.015 * cr;
      c.quaternion.slerpQuaternions(restQ, st.hoverQ, cr);
      c.userData.edge.color.copy(iris).lerp(mint, cr);
      if (animated) {
        const on = seg(p, a - 0.012, a + 0.02) * (1 - seg(p, a + DWELL + 0.004, a + DWELL + 0.03));
        fade(chapterEls[i], on, (1 - on) * (p < a ? 18 : -18));
        if (on > 0.5) active = i;
      }
    });

    if (animated) {
      setStyle(heroCopy, '--out', seg(p, 0.05, 0.12).toFixed(3));
      setStyle(heroCopy, 'opacity', (1 - seg(p, 0.05, 0.12)).toFixed(3));
      setStyle(heroCopy, 'visibility', p < 0.12 ? 'visible' : 'hidden');
      setStyle(hint, 'opacity', (1 - seg(p, 0.0, 0.03)).toFixed(3));
      const inChapters = seg(p, 0.2, 0.26) * (1 - seg(p, 0.86, 0.9));
      setStyle(shade, 'opacity', (inChapters * (active >= 0 ? 1 : 0.6)).toFixed(3));
      const e = seg(p, 0.9, 0.955);
      fade(endEl, e, (1 - e) * 20);
    }
  }

  // ---------- run ----------
  let target = 0;
  let prog = 0;
  let visible = true;
  const measure = () => {
    const r = section.getBoundingClientRect();
    const max = r.height - innerHeight;
    target = max > 0 ? clamp(-r.top / max) : 0;
  };
  if (still) prog = target = 0.085;
  resize();
  new ResizeObserver(() => {
    resize();
    if (still) render(performance.now());
  }).observe(canvas);

  const render = (now) => {
    update(prog, now / 1000);
    renderer.render(scene, camera);
  };

  if (still) {
    render(0);
    document.fonts.ready.then(() => {
      redraws.forEach((d) => d());
      render(0);
    });
    root.classList.add('archive-still', 'archive-ready');
    return;
  }

  measure();
  prog = target;
  addEventListener('scroll', measure, { passive: true });
  addEventListener('resize', measure);
  new IntersectionObserver(([e]) => (visible = e.isIntersecting), { rootMargin: '200px' }).observe(
    section,
  );
  if (matchMedia('(pointer: fine)').matches) {
    addEventListener('pointermove', (e) => {
      pointer.x = (e.clientX / innerWidth - 0.5) * 2;
      pointer.y = (e.clientY / innerHeight - 0.5) * 2;
    });
  }
  let last = performance.now();
  const frame = (now) => {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!visible) return;
    prog += (target - prog) * (1 - Math.exp(-dt * 5));
    if (Math.abs(target - prog) < 1e-5) prog = target;
    pointer.sx += (pointer.x - pointer.sx) * (1 - Math.exp(-dt * 3));
    pointer.sy += (pointer.y - pointer.sy) * (1 - Math.exp(-dt * 3));
    render(now);
  };
  render(performance.now());
  requestAnimationFrame(frame);
  document.fonts.ready.then(() => redraws.forEach((d) => d()));
  root.classList.add('archive-ready');

  // ======================================================================
  // Builders
  // ======================================================================

  function roundedBox(w, h, d, r) {
    const s = new THREE.Shape();
    const iw = w - 2 * r;
    const ih = h - 2 * r;
    const cr = Math.min(r * 0.6, iw / 2, ih / 2);
    roundRect(s, -iw / 2, -ih / 2, iw, ih, cr);
    const g = new THREE.ExtrudeGeometry(s, {
      depth: Math.max(0.001, d - 2 * r),
      bevelEnabled: true,
      bevelThickness: r,
      bevelSize: r,
      bevelSegments: 3,
      curveSegments: 4,
    });
    g.translate(0, 0, -(d - 2 * r) / 2);
    g.computeVertexNormals();
    return g;
  }

  function cabinetParts() {
    const body = roundedBox(1, 0.6, 0.9, 0.035);
    const front = roundedBox(0.88, 0.46, 0.04, 0.012);
    front.translate(0, 0, 0.465);
    const handle = roundedBox(0.3, 0.04, 0.05, 0.016);
    handle.translate(0, 0.09, 0.5);
    const label = new THREE.PlaneGeometry(0.2, 0.065);
    label.translate(0, -0.08, 0.487);
    const led = new THREE.CircleGeometry(0.014, 10);
    led.translate(0.36, 0.16, 0.487);
    return { body, front, handle, label, led };
  }

  function makeCard(draw) {
    const W = 1.3;
    const H = 0.8;
    const grp = new THREE.Group();
    const s = new THREE.Shape();
    roundRect(s, -W / 2, -H / 2, W, H, 0.07);
    const slab = new THREE.ExtrudeGeometry(s, {
      depth: 0.016,
      bevelEnabled: true,
      bevelThickness: 0.008,
      bevelSize: 0.008,
      bevelSegments: 2,
      curveSegments: 10,
    });
    slab.translate(0, 0, -0.008);
    grp.add(
      new THREE.Mesh(
        slab,
        inside(
          new THREE.MeshPhysicalMaterial({
            color: 0x0c0f18,
            metalness: 0.2,
            roughness: 0.14,
            clearcoat: 1,
            clearcoatRoughness: 0.06,
            transparent: true,
            opacity: 0.94,
            envMapIntensity: 0.8,
          }),
        ),
      ),
    );
    const cv = document.createElement('canvas');
    cv.width = 1024;
    cv.height = 630;
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    const paint = () => {
      const g = cv.getContext('2d');
      g.clearRect(0, 0, cv.width, cv.height);
      // A faint sheen across the top of the glass.
      const sheen = g.createLinearGradient(0, 0, 0, cv.height);
      sheen.addColorStop(0, 'rgba(255,255,255,0.06)');
      sheen.addColorStop(0.4, 'rgba(255,255,255,0)');
      g.fillStyle = sheen;
      g.fillRect(0, 0, cv.width, cv.height);
      draw(g, cv.width, cv.height);
      tex.needsUpdate = true;
    };
    paint();
    redraws.push(paint);
    const face = new THREE.Mesh(
      new THREE.PlaneGeometry(W, H),
      inside(
        new THREE.MeshBasicMaterial({
          map: tex,
          transparent: true,
          depthWrite: false,
          toneMapped: false,
        }),
      ),
    );
    face.position.z = 0.0175;
    const edgeMat = inside(
      new THREE.LineBasicMaterial({ color: 0x6f7dff, transparent: true, opacity: 0.8 }),
    );
    const edge = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(s.getPoints(10).map((v) => V(v.x, v.y, 0.018))),
      edgeMat,
    );
    grp.add(face, edge);
    grp.userData.edge = edgeMat;
    grp.visible = false;
    return grp;
  }
}

// ======================================================================
// Textures and card faces (plain canvas 2D)
// ======================================================================

function environment(renderer) {
  // A dim studio: dark gradient dome with a few soft panels to catch in the metal.
  const s = new THREE.Scene();
  const g = new THREE.SphereGeometry(10, 32, 16);
  const pos = g.attributes.position;
  const cols = [];
  const top = new THREE.Color(0x2a3274);
  const mid = new THREE.Color(0x0e111b);
  const bot = new THREE.Color(0x030407);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 10;
    const c = y > 0 ? mid.clone().lerp(top, y) : mid.clone().lerp(bot, -y);
    cols.push(c.r, c.g, c.b);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  s.add(
    new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })),
  );
  const panel = (w, h, rgb, x, y, z) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
    );
    m.material.color.setRGB(...rgb);
    m.position.set(x, y, z);
    m.lookAt(0, 0, 0);
    s.add(m);
  };
  panel(9, 1.8, [2.4, 2.4, 2.7], 0, 7, 3);
  panel(1.2, 7, [0.55, 0.65, 2.6], -8, 1, 2);
  panel(2.2, 4, [1.2, 1.25, 1.5], 7.5, 0, -3);
  panel(5, 1.5, [0.34, 0.3, 0.28], 0, -3, -8);
  const pm = new THREE.PMREMGenerator(renderer);
  const tex = pm.fromScene(s, 0.04).texture;
  pm.dispose();
  return tex;
}

function backdrop(inside) {
  const g = new THREE.SphereGeometry(110, 32, 16);
  const pos = g.attributes.position;
  const cols = [];
  const top = new THREE.Color(0x1a1f4a);
  const mid = new THREE.Color(0x0a0c18);
  const bot = new THREE.Color(0x030406);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 110;
    const c =
      y > 0 ? mid.clone().lerp(top, Math.pow(y, 0.8)) : mid.clone().lerp(bot, Math.pow(-y, 0.6));
    cols.push(c.r, c.g, c.b);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  const m = new THREE.Mesh(
    g,
    inside(
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        side: THREE.BackSide,
        fog: false,
        depthWrite: false,
      }),
    ),
  );
  m.position.z = -30;
  m.renderOrder = 0.5;
  return m;
}

function brushedTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#9a9a9a';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 2600; i++) {
    const v = Math.random() < 0.5 ? 255 : 0;
    g.fillStyle = `rgba(${v},${v},${v},${Math.random() * 0.12})`;
    g.fillRect(Math.random() * 256, Math.random() * 256, 20 + Math.random() * 90, 1);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(2, 2);
  return t;
}

function dotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(255,255,255,1)');
  r.addColorStop(0.35, 'rgba(255,255,255,0.5)');
  r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function shaftTexture() {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 256;
  const g = c.getContext('2d');
  const v = g.createLinearGradient(0, 0, 0, 256);
  v.addColorStop(0, 'rgba(255,255,255,0.9)');
  v.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = v;
  g.fillRect(0, 0, 64, 256);
  g.globalCompositeOperation = 'destination-in';
  const h = g.createLinearGradient(0, 0, 64, 0);
  h.addColorStop(0, 'rgba(0,0,0,0)');
  h.addColorStop(0.5, 'rgba(0,0,0,1)');
  h.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = h;
  g.fillRect(0, 0, 64, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function labelTexture(text) {
  const c = document.createElement('canvas');
  c.width = 360;
  c.height = 100;
  const g = c.getContext('2d');
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const draw = () => {
    g.fillStyle = '#b9bcc4';
    g.fillRect(0, 0, 360, 100);
    g.fillStyle = 'rgba(0,0,0,0.05)';
    for (let i = 0; i < 400; i++) g.fillRect(Math.random() * 360, Math.random() * 100, 2, 2);
    g.fillStyle = '#23262e';
    g.font = '600 46px "Geist Mono", ui-monospace, monospace';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, 180, 54);
    t.needsUpdate = true;
  };
  draw();
  document.fonts.ready.then(draw);
  return t;
}

function roundRect(s, x, y, w, h, r) {
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
}

const C = {
  text: '#e9edf5',
  text2: '#a3abbd',
  muted: '#7e879b',
  line: 'rgba(142,160,255,0.16)',
  iris: '#8ea0ff',
  irisSolid: '#4c5be8',
  mint: '#45d6a0',
  amber: '#f2b64c',
  violet: '#d9a3f5',
};
const SANS = 'Geist, -apple-system, system-ui, sans-serif';
const MONO = '"Geist Mono", ui-monospace, Menlo, monospace';

function header(g, w, left, right, rightColor = C.mint) {
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  g.font = `500 28px ${MONO}`;
  g.fillStyle = C.muted;
  g.fillText(left.toUpperCase(), 64, 92);
  if (right) {
    g.textAlign = 'right';
    g.fillStyle = rightColor;
    g.fillText(right, w - 64, 92);
    const tw = g.measureText(right).width;
    g.beginPath();
    g.arc(w - 64 - tw - 20, 83, 7, 0, Math.PI * 2);
    g.fill();
    g.textAlign = 'left';
  }
}
function pill(g, x, y, w, h, fill, stroke) {
  g.beginPath();
  roundRect(g, x, y, w, h, h / 2 > 18 ? 16 : h / 2);
  if (fill) {
    g.fillStyle = fill;
    g.fill();
  }
  if (stroke) {
    g.strokeStyle = stroke;
    g.lineWidth = 2;
    g.stroke();
  }
}
function rule(g, w, y) {
  g.fillStyle = C.line;
  g.fillRect(64, y, w - 128, 2);
}

function drawZeroKnowledge(g, w) {
  header(g, w, 'Personal · GitHub', 'Encrypted');
  g.font = `500 24px ${MONO}`;
  g.fillStyle = C.muted;
  g.fillText('PASSWORD', 64, 170);
  g.font = `500 54px ${MONO}`;
  g.fillStyle = C.text;
  g.fillText('correct-horse-battery', 64, 232);
  g.fillStyle = C.mint;
  g.fillRect(76, 262, 3, 58);
  g.font = `500 26px ${MONO}`;
  g.fillText('XChaCha20-Poly1305 · on your Mac', 104, 302);
  g.fillStyle = C.muted;
  g.font = `500 24px ${MONO}`;
  g.fillText('WHAT THE SERVER STORES', 64, 384);
  g.font = `500 46px ${MONO}`;
  g.fillStyle = C.iris;
  g.fillText('e828·a89b·a707·3ab5·0e9a', 64, 444);
  rule(g, w, 510);
  g.font = `400 26px ${SANS}`;
  g.fillStyle = C.text2;
  g.fillText('Argon2id  ·  Secret Key  ·  SRP sign-in', 64, 566);
}

function drawAgents(g, w) {
  header(g, w, 'Agent request', 'Needs approval', C.amber);
  // Agent glyph.
  pill(g, 64, 138, 104, 104, '#1d2440');
  g.fillStyle = C.iris;
  g.fillRect(92, 178, 14, 14);
  g.fillRect(126, 178, 14, 14);
  g.fillRect(96, 208, 40, 6);
  g.font = `600 48px ${SANS}`;
  g.fillStyle = C.text;
  g.fillText('Use STRIPE_KEY?', 196, 188);
  g.font = `500 26px ${MONO}`;
  g.fillStyle = C.muted;
  g.fillText('zv run -- stripe balance retrieve', 196, 232);
  rule(g, w, 290);
  g.font = `500 26px ${MONO}`;
  g.fillStyle = C.text2;
  g.fillText('project  payments-api / prod', 64, 350);
  pill(g, 64, 420, 190, 80, null, 'rgba(142,160,255,0.35)');
  pill(g, 276, 420, 250, 80, C.irisSolid);
  g.font = `500 32px ${SANS}`;
  g.textAlign = 'center';
  g.fillStyle = C.text2;
  g.fillText('Deny', 159, 471);
  g.fillStyle = '#fff';
  g.fillText('Approve', 401, 471);
  g.textAlign = 'right';
  g.font = `500 26px ${MONO}`;
  g.fillStyle = C.mint;
  g.fillText('output masked ✓', w - 64, 471);
  g.textAlign = 'left';
}

function drawProjects(g, w) {
  header(g, w, 'Payments API', 'You · Manage', C.iris);
  const envs = ['Dev', 'Staging', 'Prod'];
  let x = 64;
  g.font = `500 30px ${SANS}`;
  envs.forEach((e, i) => {
    const tw = g.measureText(e).width + 56;
    const on = i === 2;
    pill(
      g,
      x,
      132,
      tw,
      64,
      on ? 'rgba(76,91,232,0.3)' : null,
      on ? C.iris : 'rgba(142,160,255,0.22)',
    );
    g.fillStyle = on ? C.text : C.text2;
    g.fillText(e, x + 28, 175);
    x += tw + 14;
  });
  const rows = [
    ['STRIPE_KEY', 'sk_live_••••4f2a'],
    ['DATABASE_URL', 'postgres://••••'],
    ['WEBHOOK_SECRET', 'whsec_••••91c0'],
  ];
  rows.forEach(([k, v], i) => {
    const y = 290 + i * 96;
    g.font = `500 30px ${MONO}`;
    g.fillStyle = C.text;
    g.fillText(k, 64, y);
    g.textAlign = 'right';
    g.fillStyle = i ? C.text2 : C.violet;
    g.fillText(v, w - 64, y);
    g.textAlign = 'left';
    if (i < 2) rule(g, w, y + 38);
  });
}

function drawSharing(g, w) {
  header(g, w, 'Shared by email', 'Expires in 7 days', C.text2);
  g.font = `500 24px ${MONO}`;
  g.fillStyle = C.muted;
  g.fillText('TO', 64, 170);
  g.font = `500 48px ${SANS}`;
  g.fillStyle = C.text;
  g.fillText('priya@acme.com', 64, 228);
  g.font = `500 24px ${MONO}`;
  g.fillStyle = C.muted;
  g.fillText('ONE-TIME CODE', 64, 306);
  '481902'.split('').forEach((d, i) => {
    const x = 64 + i * 112;
    pill(g, x, 330, 92, 112, 'rgba(69,214,160,0.08)', 'rgba(69,214,160,0.45)');
    g.font = `500 56px ${MONO}`;
    g.fillStyle = C.mint;
    g.textAlign = 'center';
    g.fillText(d, x + 46, 405);
    g.textAlign = 'left';
  });
  g.font = `400 26px ${SANS}`;
  g.fillStyle = C.text2;
  g.fillText('Decrypts in their browser. Works once.', 64, 540);
}

function drawCli(g, w) {
  ['#ff5f57', '#febc2e', '#28c840'].forEach((c, i) => {
    g.fillStyle = c;
    g.beginPath();
    g.arc(78 + i * 34, 82, 10, 0, Math.PI * 2);
    g.fill();
  });
  g.font = `500 26px ${MONO}`;
  g.fillStyle = C.muted;
  g.textAlign = 'right';
  g.fillText('zsh', w - 64, 92);
  g.textAlign = 'left';
  rule(g, w, 120);
  const lines = [
    [
      ['$ ', C.mint],
      ['zv run -- npm test', C.text],
    ],
    [['✓ approved in Zvault', C.mint]],
    [
      ['STRIPE_KEY=', C.text2],
      ['********', C.iris],
    ],
    [
      ['DATABASE_URL=', C.text2],
      ['********', C.iris],
    ],
    [['PASS  42 tests', C.text]],
  ];
  g.font = `500 34px ${MONO}`;
  lines.forEach((parts, i) => {
    let x = 64;
    parts.forEach(([t, c]) => {
      g.fillStyle = c;
      g.fillText(t, x, 196 + i * 78);
      x += g.measureText(t).width;
    });
  });
}

function drawAndroid(g, w) {
  header(g, w, 'Android · Paired', 'Keystore');
  pill(g, 64, 130, 190, 400, '#10131c', 'rgba(142,160,255,0.35)');
  g.fillStyle = '#1b2033';
  g.fillRect(84, 170, 150, 320);
  pill(g, 124, 290, 70, 70, C.irisSolid);
  g.font = `700 40px ${SANS}`;
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.fillText('Z', 159, 339);
  g.textAlign = 'left';
  g.font = `600 48px ${SANS}`;
  g.fillStyle = C.text;
  g.fillText('Pixel 8', 300, 196);
  g.font = `500 30px ${MONO}`;
  g.fillStyle = C.mint;
  g.fillText('code 480 644 ✓', 300, 262);
  g.font = `400 28px ${SANS}`;
  g.fillStyle = C.text2;
  g.fillText('Fingerprint unlock on', 300, 350);
  g.fillText('Items and project secrets', 300, 400);
  g.fillStyle = C.muted;
  g.fillText('Paired by QR from your Mac', 300, 470);
}

// Start last, once every helper above is defined.
if (canvas && (animated || still)) {
  try {
    start();
  } catch (err) {
    root.classList.remove('archive-on', 'archive-still', 'archive-ready');
    console.warn('3D hero unavailable', err);
  }
}

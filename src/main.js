import * as THREE from 'three';

const canvas = document.querySelector('#c');

/** Resolves `public/` files on GitHub Pages and local dev (Vite `base: './'`). */
function publicAsset(path) {
  const p = path.startsWith('/') ? path.slice(1) : path;
  const base = import.meta.env.BASE_URL;
  return base.endsWith('/') ? `${base}${p}` : `${base}/${p}`;
}
const scoreEl = document.querySelector('#score');
const speedEl = document.querySelector('#speed');
const coinsEl = document.querySelector('#coins');
const overlay = document.querySelector('#overlay');

const LANE_WIDTH = 2.2;
const LANES = [-1, 0, 1];
const laneX = (i) => i * LANE_WIDTH;

let scene, camera, renderer;
let playerGroup;
let worldGroup;
let speed = 12;
let baseSpeed = 12;
/** Extra speed from distance; ramps up so the run gets faster over time. */
const SPEED_RAMP_PER_UNIT = 0.022;
const SPEED_MAX_BONUS = 36;
let distance = 0;
let coinCount = 0;
let alive = true;
let pointerDownX = 0;
let pointerDownY = 0;
let activePointerId = null;
let mouseLaneAccum = 0;
let didDragLaneChange = false;

let playerLane = 0;
let targetLaneX = 0;
let playerY = 0;
let playerVy = 0;
const GRAVITY = -45;
const JUMP_V = 14;
/** Boost pad: higher launch than jump + brief forward surge. */
const BOOST_PAD_VY = 27;
const BOOST_SPEED_MULT = 1.45;
const BOOST_SPEED_SEC = 1.05;

const obstacles = [];
const coins = [];
const boostPads = [];
let speedBoostRemain = 0;
let nextSpawnZ = 20;
let rng = mulberry32(0x9e3779b9);

/**
 * Background music: `public/sounds/` first (same folder as SFX), then `public/bgsound/`.
 * First URL that fetch succeeds wins.
 */
const BGM_URLS = [
  'sounds/BGSOUND.mp3',
  'sounds/bgsound.mp3',
  'sounds/bgm.mp3',
  'sounds/BGM.mp3',
  'sounds/bg.mp3',
  'sounds/background.mp3',
  'sounds/music.mp3',
  'sounds/Music.mp3',
  'sounds/track.mp3',
  'sounds/song.mp3',
  'sounds/theme.mp3',
  'sounds/loop.mp3',
  'sounds/audio.mp3',
  'sounds/track.ogg',
  'sounds/bgsound.m4a',
  'sounds/bgsound.wav',
  'sound/bgsound.mp3',
  'sound/bgm.mp3',
  'sound/music.mp3',
  'bgsound/bgsound.mp3',
  'bgsound/bgm.mp3',
  'bgsound/BGM.mp3',
  'bgsound/bg.mp3',
  'bgsound/background.mp3',
  'bgsound/music.mp3',
  'bgsound/Music.mp3',
  'bgsound/track.mp3',
  'bgsound/song.mp3',
  'bgsound/theme.mp3',
  'bgsound/loop.mp3',
  'bgsound/audio.mp3',
  'bgsound/track.ogg',
];
let bgmAudio = null;
let bgmObjectUrl = null;
let bgmUnlocked = false;
const BGM_VOLUME = 0.38;
const BGM_RATE_MIN = 1;
/** Max BGM speed-up; tied to the same 0..1 ramp as travel speed (not boost pads). */
const BGM_RATE_MAX = 1.32;

/** Set in `tick` from the same `distance` used to compute `speed` that frame (boost ignored). */
let difficultyRampT = 0;

/** After a normal jump, play land once when feet touch the ground. */
let pendingLandSfx = false;
/** HTML Audio run loop (lightweight vs Web Audio stretch). */
let runAudio = null;
/** Throttle expensive per-frame mesh updates. */
let tickFrame = 0;
/** Each coin raises playbackRate (higher pitch); capped so it stays usable. */
const COIN_PITCH_STEP = 0.07;
const COIN_PITCH_MAX_RATE = 2.35;

function initRunSfx() {
  const r = new Audio(publicAsset('sounds/run.mp3'));
  r.loop = true;
  r.preload = 'auto';
  r.volume = 0.32;
  r.addEventListener(
    'canplaythrough',
    () => {
      runAudio = r;
    },
    { once: true },
  );
  r.addEventListener('error', () => {
    runAudio = null;
  });
  r.load();
}

function playJumpSfx() {
  if (!bgmUnlocked) return;
  const a = new Audio(publicAsset('sounds/jump.mp3'));
  a.volume = 0.55;
  a.play().catch(() => {});
}

function playLandSfx() {
  if (!bgmUnlocked) return;
  const a = new Audio(publicAsset('sounds/land.mp3'));
  a.volume = 0.48;
  a.play().catch(() => {});
}

function playCoinSfx(totalCoins) {
  if (!bgmUnlocked) return;
  const a = new Audio(publicAsset('sounds/coin.mp3'));
  a.volume = 0.52;
  const n = Math.max(1, totalCoins);
  a.playbackRate = Math.min(COIN_PITCH_MAX_RATE, 1 + (n - 1) * COIN_PITCH_STEP);
  a.play().catch(() => {});
}

function playBoostSfx() {
  if (!bgmUnlocked) return;
  const a = new Audio(publicAsset('sounds/boost.mp3'));
  a.volume = 0.58;
  a.play().catch(() => {});
}

function playGameOverSfx() {
  if (!bgmUnlocked) return;
  const a = new Audio(publicAsset('sounds/gameover.mp3'));
  a.volume = 0.62;
  a.play().catch(() => {});
}

function updateRunSfx() {
  if (!runAudio || !bgmUnlocked) return;
  if (!alive) {
    if (!runAudio.paused) runAudio.pause();
    return;
  }
  const grounded = playerY < 0.02;
  if (grounded) {
    if (runAudio.paused) runAudio.play().catch(() => {});
    runAudio.playbackRate = THREE.MathUtils.clamp(0.92 + difficultyRampT * 0.42, 0.75, 1.5);
  } else if (!runAudio.paused) {
    runAudio.pause();
  }
}

function syncBgmPlayState() {
  if (!bgmAudio || !bgmUnlocked) return;
  if (!alive) {
    bgmAudio.pause();
    return;
  }
  const p = bgmAudio.play();
  if (p) p.catch(() => {});
}

function revokeBgmBlobUrl() {
  if (bgmObjectUrl) {
    URL.revokeObjectURL(bgmObjectUrl);
    bgmObjectUrl = null;
  }
}

function setupBgmFromUrl(index) {
  if (index >= BGM_URLS.length) return;
  const url = publicAsset(BGM_URLS[index]);
  fetch(url)
    .then((res) => {
      if (!res.ok) throw new Error('bgm 404');
      return res.blob();
    })
    .then((blob) => {
      revokeBgmBlobUrl();
      bgmObjectUrl = URL.createObjectURL(blob);
      const a = new Audio(bgmObjectUrl);
      a.preload = 'auto';
      a.loop = true;
      a.volume = BGM_VOLUME;
      const onReady = () => {
        bgmAudio = a;
        syncBgmPlayState();
      };
      a.addEventListener('canplay', onReady, { once: true });
      a.addEventListener('canplaythrough', onReady, { once: true });
      a.addEventListener(
        'error',
        () => {
          revokeBgmBlobUrl();
          if (bgmAudio === a) bgmAudio = null;
          setupBgmFromUrl(index + 1);
        },
        { once: true },
      );
      a.load();
    })
    .catch(() => {
      setupBgmFromUrl(index + 1);
    });
}

function initBgm() {
  setupBgmFromUrl(0);
}

function unlockBgm() {
  bgmUnlocked = true;
  syncBgmPlayState();
}

function updateBgmPlayback() {
  if (!bgmAudio || !bgmUnlocked) return;
  if (!alive) {
    if (!bgmAudio.paused) bgmAudio.pause();
    return;
  }
  const targetRate = BGM_RATE_MIN + difficultyRampT * (BGM_RATE_MAX - BGM_RATE_MIN);
  bgmAudio.playbackRate = THREE.MathUtils.clamp(targetRate, 0.85, 2);
  syncBgmPlayState();
}

function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeBlockPlayer() {
  const g = new THREE.Group();
  const matBody = new THREE.MeshPhongMaterial({
    color: 0x4ecdc4,
    shininess: 35,
    specular: 0x224444,
  });
  const matAccent = new THREE.MeshPhongMaterial({
    color: 0xff6b6b,
    shininess: 25,
    specular: 0x442222,
  });
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.65, 0.35), matBody);
  torso.position.y = 0.85;
  g.add(torso);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.42, 0.42), matAccent);
  head.position.y = 1.38;
  g.add(head);
  const legL = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.45, 0.22), matBody);
  legL.position.set(-0.14, 0.28, 0);
  const legR = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.45, 0.22), matBody);
  legR.position.set(0.14, 0.28, 0);
  g.add(legL, legR);
  g.userData.legs = [legL, legR];
  return g;
}

function makeGroundStripe(z0, length) {
  const g = new THREE.Group();
  g.userData.zStart = z0;
  g.userData.zEnd = z0 + length;
  const matDark = new THREE.MeshPhongMaterial({
    color: 0x2d3340,
    shininess: 8,
    specular: 0x111111,
  });
  const matRail = new THREE.MeshPhongMaterial({
    color: 0x5c6370,
    shininess: 40,
    specular: 0x444444,
  });
  const matLine = new THREE.MeshPhongMaterial({
    color: 0xf4d35e,
    emissive: 0x332200,
    shininess: 12,
    specular: 0x222222,
  });

  const slab = new THREE.Mesh(
    new THREE.BoxGeometry(LANE_WIDTH * 3.6, 0.35, length),
    matDark,
  );
  slab.position.set(0, -0.2, z0 + length / 2);
  g.add(slab);

  for (const lx of [-LANE_WIDTH, 0, LANE_WIDTH]) {
    const strip = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.05, length), matLine);
    strip.position.set(lx, 0.02, z0 + length / 2);
    g.add(strip);
  }

  for (const rx of [-LANE_WIDTH * 1.55, LANE_WIDTH * 1.55]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.2, length), matRail);
    rail.position.set(rx, 0.08, z0 + length / 2);
    g.add(rail);
  }

  return g;
}

function spawnChunk(endZ) {
  const len = 24 + rng() * 16;
  const z0 = endZ;
  worldGroup.add(makeGroundStripe(z0, len));
  return z0 + len;
}

function spawnObstacle(z) {
  const lane = LANES[Math.floor(rng() * 3)];
  const roll = rng();
  let mesh;
  let kind;

  if (roll < 0.45) {
    kind = 'train';
    const mat = new THREE.MeshPhongMaterial({
      color: new THREE.Color().setHSL(rng() * 0.08, 0.5, 0.45 + rng() * 0.15),
      shininess: 28,
      specular: 0x333333,
    });
    mesh = new THREE.Mesh(
      new THREE.BoxGeometry(LANE_WIDTH * 0.85, 1.35, 3.2),
      mat,
    );
    mesh.position.set(laneX(lane), 0.75, z);
  } else {
    kind = 'low';
    const mat = new THREE.MeshPhongMaterial({ color: 0x8b4513, shininess: 12, specular: 0x221100 });
    mesh = new THREE.Mesh(new THREE.BoxGeometry(LANE_WIDTH * 0.75, 0.45, 0.55), mat);
    mesh.position.set(laneX(lane), 0.22, z);
  }

  scene.add(mesh);
  obstacles.push({ mesh, z, lane, kind });
}

function spawnCoinRow(z) {
  const lane = LANES[Math.floor(rng() * 3)];
  const n = 3 + Math.floor(rng() * 4);
  const mat = new THREE.MeshPhongMaterial({
    color: 0xffd60a,
    emissive: 0x553300,
    shininess: 60,
    specular: 0xffffaa,
  });
  for (let i = 0; i < n; i++) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.35, 0.12), mat);
    const zz = z + i * 1.1;
    mesh.position.set(laneX(lane), 0.55, zz);
    mesh.rotation.y = Math.PI / 4;
    scene.add(mesh);
    coins.push({ mesh, z: zz, lane, collected: false });
  }
}

function spawnBoostPad(z) {
  const lane = LANES[Math.floor(rng() * 3)];
  const g = new THREE.Group();
  const w = LANE_WIDTH * 0.88;
  const d = 1.4;
  const stripD = d / 5;
  const h = 0.09;
  const matA = new THREE.MeshPhongMaterial({
    color: 0x00e5c8,
    emissive: 0x004433,
    shininess: 45,
    specular: 0x88ffee,
  });
  const matB = new THREE.MeshPhongMaterial({
    color: 0xff2d95,
    emissive: 0x440022,
    shininess: 40,
    specular: 0xff88cc,
  });
  for (let i = 0; i < 5; i++) {
    const strip = new THREE.Mesh(
      new THREE.BoxGeometry(w * 0.97, h, stripD * 0.92),
      i % 2 === 0 ? matA : matB,
    );
    strip.position.set(0, h / 2 + 0.02, -d / 2 + stripD / 2 + i * stripD);
    strip.receiveShadow = true;
    g.add(strip);
  }
  g.position.set(laneX(lane), 0, z);
  scene.add(g);
  boostPads.push({ mesh: g, z, lane, used: false, pulse: 0 });
}

function init() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87ceeb);
  scene.fog = new THREE.Fog(0xa8d8f0, 25, 95);

  camera = new THREE.PerspectiveCamera(58, 1, 0.1, 200);
  // Player runs toward +Z; camera stays behind (-Z) and looks ahead (+Z).
  camera.position.set(0, 4.2, -6.5);
  camera.lookAt(0, 0.8, 10);

  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    powerPreference: 'high-performance',
    stencil: false,
    depth: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.BasicShadowMap;

  const hemi = new THREE.HemisphereLight(0xffffff, 0x334455, 0.9);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff5e6, 1.05);
  sun.position.set(8, 18, 10);
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(1024);
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 80;
  sun.shadow.camera.left = -20;
  sun.shadow.camera.right = 20;
  sun.shadow.camera.top = 25;
  sun.shadow.camera.bottom = -5;
  scene.add(sun);

  worldGroup = new THREE.Group();
  scene.add(worldGroup);

  let zEnd = 0;
  for (let i = 0; i < 6; i++) zEnd = spawnChunk(zEnd);

  playerGroup = makeBlockPlayer();
  playerGroup.position.set(0, 0, 0);
  playerGroup.castShadow = true;
  playerGroup.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  scene.add(playerGroup);

  canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', 'Game');

  window.addEventListener('resize', onResize);
  window.addEventListener('keydown', onKeyDown);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('lostpointercapture', () => {
    activePointerId = null;
  });

  overlay.addEventListener('click', restart);

  initBgm();
  initRunSfx();
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function tryJump() {
  if (!alive) return;
  if (playerY <= 0.001) {
    playerVy = JUMP_V;
    pendingLandSfx = true;
    playJumpSfx();
  }
}

function shiftLane(dir) {
  if (!alive) return;
  playerLane = THREE.MathUtils.clamp(playerLane + dir, -1, 1);
  targetLaneX = laneX(playerLane);
}

function onKeyDown(e) {
  unlockBgm();
  // Screen-left / screen-right match world X when camera is behind the runner (+Z forward).
  if (e.code === 'ArrowLeft' || e.code === 'KeyA') {
    e.preventDefault();
    shiftLane(1);
    return;
  }
  if (e.code === 'ArrowRight' || e.code === 'KeyD') {
    e.preventDefault();
    shiftLane(-1);
    return;
  }
  if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') {
    e.preventDefault();
    if (!alive) restart();
    else tryJump();
  }
}

const MOUSE_DRAG_LANE_PX = 95;

function onPointerDown(e) {
  if (e.isPrimary === false) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  unlockBgm();
  pointerDownX = e.clientX;
  pointerDownY = e.clientY;
  activePointerId = e.pointerId;
  mouseLaneAccum = 0;
  didDragLaneChange = false;
  canvas.focus({ preventScroll: true });
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {
    /* setPointerCapture may fail in edge cases */
  }
}

function onPointerMove(e) {
  if (!alive) return;
  if (e.pointerType !== 'mouse') return;
  if (!(e.buttons & 1)) return;
  if (activePointerId == null || e.pointerId !== activePointerId) return;
  mouseLaneAccum += e.movementX;
  if (mouseLaneAccum >= MOUSE_DRAG_LANE_PX) {
    shiftLane(-1);
    mouseLaneAccum = 0;
    didDragLaneChange = true;
  } else if (mouseLaneAccum <= -MOUSE_DRAG_LANE_PX) {
    shiftLane(1);
    mouseLaneAccum = 0;
    didDragLaneChange = true;
  }
}

function onPointerUp(e) {
  if (activePointerId == null || e.pointerId !== activePointerId) return;
  activePointerId = null;
  try {
    canvas.releasePointerCapture(e.pointerId);
  } catch {
    /* noop */
  }
  const dx = e.clientX - pointerDownX;
  const dy = e.clientY - pointerDownY;
  const swipePx = 24;
  if (!didDragLaneChange && Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > swipePx) {
    shiftLane(dx > 0 ? -1 : 1);
  } else if (!didDragLaneChange) {
    tryJump();
  }
  mouseLaneAccum = 0;
  didDragLaneChange = false;
}

function onPointerCancel(e) {
  if (activePointerId != null && e.pointerId === activePointerId) {
    activePointerId = null;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
  }
}

function restart() {
  unlockBgm();
  overlay.classList.add('hidden');
  alive = true;
  speed = baseSpeed;
  distance = 0;
  coinCount = 0;
  playerLane = 0;
  targetLaneX = 0;
  playerY = 0;
  playerVy = 0;
  nextSpawnZ = 20;
  rng = mulberry32(0x9e3779b9 + Date.now() % 1e6);

  for (const o of obstacles) scene.remove(o.mesh);
  obstacles.length = 0;
  for (const c of coins) scene.remove(c.mesh);
  coins.length = 0;
  for (const p of boostPads) scene.remove(p.mesh);
  boostPads.length = 0;
  speedBoostRemain = 0;

  while (worldGroup.children.length) worldGroup.remove(worldGroup.children[0]);
  let zEnd = 0;
  for (let i = 0; i < 6; i++) zEnd = spawnChunk(zEnd);

  scoreEl.textContent = '0';
  speedEl.textContent = `spd ${Math.round(baseSpeed)}`;
  coinsEl.textContent = 'coins: 0';
  if (bgmAudio) bgmAudio.playbackRate = BGM_RATE_MIN;
  pendingLandSfx = false;
  difficultyRampT = 0;
  if (runAudio) runAudio.pause();
}

function playerXZRect() {
  const px = playerGroup.position.x;
  const pz = playerGroup.position.z;
  const hw = 0.38;
  const hd = 0.42;
  return { minX: px - hw, maxX: px + hw, minZ: pz - hd, maxZ: pz + hd };
}

function overlapsObstacle(rect, o) {
  const m = o.mesh;
  const ox = m.position.x;
  const oz = m.position.z;
  let hw, hd;
  if (o.kind === 'train') {
    hw = (LANE_WIDTH * 0.85) / 2;
    hd = 3.2 / 2;
  } else {
    hw = (LANE_WIDTH * 0.75) / 2;
    hd = 0.55 / 2;
  }
  const minX = ox - hw;
  const maxX = ox + hw;
  const minZ = oz - hd;
  const maxZ = oz + hd;
  if (rect.maxX < minX || rect.minX > maxX || rect.maxZ < minZ || rect.minZ > maxZ) return false;

  const foot = playerY;
  const top = playerY + 1.45;
  const obsBot = m.position.y - (o.kind === 'train' ? 0.675 : 0.225);
  const obsTop = m.position.y + (o.kind === 'train' ? 0.675 : 0.225);
  return !(top < obsBot || foot > obsTop + 0.05);
}

function tick(dt) {
  if (!alive) return;

  tickFrame += 1;

  const speedBonus = Math.min(SPEED_MAX_BONUS, distance * SPEED_RAMP_PER_UNIT);
  difficultyRampT = SPEED_MAX_BONUS > 0 ? speedBonus / SPEED_MAX_BONUS : 0;
  speed = baseSpeed + speedBonus;
  let travelSpeed = speed;
  if (speedBoostRemain > 0) {
    speedBoostRemain = Math.max(0, speedBoostRemain - dt);
    travelSpeed *= BOOST_SPEED_MULT;
  }
  distance += travelSpeed * dt;
  speedEl.textContent = `spd ${Math.round(travelSpeed)}`;

  playerGroup.position.x = THREE.MathUtils.lerp(
    playerGroup.position.x,
    targetLaneX,
    1 - Math.pow(0.0002, dt),
  );

  const wasAboveGround = playerY > 0.04;
  playerVy += GRAVITY * dt;
  playerY += playerVy * dt;
  if (playerY < 0) {
    playerY = 0;
    playerVy = 0;
    if (wasAboveGround && pendingLandSfx) playLandSfx();
    pendingLandSfx = false;
  }
  playerGroup.position.y = playerY;

  const runPhase = distance * 0.35;
  const legs = playerGroup.userData.legs;
  if (legs) {
    const swing = Math.sin(runPhase) * 0.35;
    legs[0].rotation.x = swing;
    legs[1].rotation.x = -swing;
  }

  const pz = distance;
  playerGroup.position.z = pz;

  camera.position.z = pz - 6.5;
  camera.position.x = THREE.MathUtils.lerp(camera.position.x, playerGroup.position.x * 0.35, 0.06);
  camera.lookAt(playerGroup.position.x * 0.4, 1.1, pz + 10);

  while (nextSpawnZ < pz + 70) {
    const roll = rng();
    if (roll < 0.38) spawnObstacle(nextSpawnZ + 8 + rng() * 6);
    else if (roll < 0.66) spawnCoinRow(nextSpawnZ + 5);
    else if (roll < 0.78) spawnBoostPad(nextSpawnZ + 6 + rng() * 5);
    nextSpawnZ += 5 + rng() * 7;
  }

  const oldest = worldGroup.children[0];
  if (oldest?.userData.zEnd != null && pz > oldest.userData.zEnd + 22) {
    worldGroup.remove(oldest);
    const last = worldGroup.children[worldGroup.children.length - 1];
    const lastEnd = last?.userData.zEnd ?? pz + 40;
    spawnChunk(lastEnd);
  }

  const rect = playerXZRect();

  const padHalfW = (LANE_WIDTH * 0.88) / 2;
  const padHalfD = 1.4 / 2;
  for (const pad of boostPads) {
    if (pad.used) continue;
    const mx = pad.mesh.position.x;
    const mz = pad.mesh.position.z;
    if (Math.abs(mz - pz) > padHalfD + 0.35) continue;
    if (rect.minX > mx + padHalfW || rect.maxX < mx - padHalfW) continue;
    if (rect.minZ > mz + padHalfD || rect.maxZ < mz - padHalfD) continue;
    if (playerY > 0.42) continue;
    pad.used = true;
    pendingLandSfx = false;
    playBoostSfx();
    playerVy = BOOST_PAD_VY;
    playerY = Math.max(playerY, 0.52);
    playerGroup.position.y = playerY;
    speedBoostRemain = BOOST_SPEED_SEC;
    pad.mesh.traverse((o) => {
      if (o.isMesh && o.material && o.material.emissiveIntensity != null) {
        o.material.emissiveIntensity *= 0.35;
      }
    });
  }

  for (const o of obstacles) {
    if (o.mesh.position.z < pz - 3) continue;
    if (overlapsObstacle(rect, o)) {
      alive = false;
      playGameOverSfx();
      overlay.classList.remove('hidden');
      break;
    }
  }

  for (const c of coins) {
    if (c.collected) continue;
    if (Math.abs(c.mesh.position.z - pz) > 0.55) continue;
    if (Math.abs(c.mesh.position.x - playerGroup.position.x) > 0.65) continue;
    c.collected = true;
    c.mesh.visible = false;
    coinCount += 1;
    coinsEl.textContent = `coins: ${coinCount}`;
    playCoinSfx(coinCount);
  }

  const score = Math.floor(distance) + coinCount;
  scoreEl.textContent = String(score);

  for (let i = obstacles.length - 1; i >= 0; i--) {
    if (obstacles[i].mesh.position.z < pz - 25) {
      scene.remove(obstacles[i].mesh);
      obstacles.splice(i, 1);
    }
  }
  for (let i = coins.length - 1; i >= 0; i--) {
    if (coins[i].mesh.position.z < pz - 15 && coins[i].collected) {
      scene.remove(coins[i].mesh);
      coins.splice(i, 1);
    } else if (coins[i].mesh.position.z < pz - 25) {
      scene.remove(coins[i].mesh);
      coins.splice(i, 1);
    }
  }

  for (let i = boostPads.length - 1; i >= 0; i--) {
    if (boostPads[i].mesh.position.z < pz - 22) {
      scene.remove(boostPads[i].mesh);
      boostPads.splice(i, 1);
    }
  }

  for (const c of coins) {
    if (!c.collected && (tickFrame & 1) === 0) c.mesh.rotation.y += dt * 5;
  }

  if ((tickFrame & 1) === 0) {
    for (const pad of boostPads) {
      if (pad.used) continue;
      pad.pulse += dt * 8;
      let idx = 0;
      pad.mesh.traverse((o) => {
        if (o.isMesh && o.material && 'emissiveIntensity' in o.material) {
          const base = idx % 2 === 0 ? 0.55 : 0.5;
          o.material.emissiveIntensity = base + Math.sin(pad.pulse + idx * 0.7) * 0.18;
          idx += 1;
        }
      });
    }
  }
}

let last = performance.now();
function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  tick(dt);
  updateBgmPlayback();
  updateRunSfx();
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}

init();
onResize();
requestAnimationFrame(loop);

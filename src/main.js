import * as THREE from 'three';
import { PMREMGenerator } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { clone as cloneSkinnedModel, retargetClip } from 'three/addons/utils/SkeletonUtils.js';

const canvas = document.querySelector('#c');

/** Hide OS cursor during a run; show large pointer on start + game-over UI only. */
function syncPlayCursor() {
  if (typeof document === 'undefined' || !document.body) return;
  const inActiveRun = gameStarted && alive && runGameplayActive;
  const menuCursor =
    (startScreenEl && !startScreenEl.classList.contains('hidden')) ||
    (overlay && !overlay.classList.contains('hidden'));
  document.body.classList.toggle('game-running', inActiveRun);
  document.body.classList.toggle('menu-cursor', menuCursor);
}

/** Resolves `public/` files on GitHub Pages and local dev (Vite `base: './'`). */
function publicAsset(path) {
  const p = path.startsWith('/') ? path.slice(1) : path;
  const base = import.meta.env.BASE_URL;
  return base.endsWith('/') ? `${base}${p}` : `${base}/${p}`;
}
const hudMetersEl = document.querySelector('#hud-meters');
const hudCoinsEl = document.querySelector('#hud-coins');
const hudScoreEl = document.querySelector('#hud-score');
const hudCoinsWrap = document.querySelector('#hud-coins-wrap');
const speedHudEl = document.querySelector('#speed-hud');
const overlay = document.querySelector('#overlay');
const overlayStatsEl = document.querySelector('#overlay-stats');
const overlayMetersEl = document.querySelector('#overlay-meters');
const overlayCoinsEl = document.querySelector('#overlay-coins');
const overlayScoreEl = document.querySelector('#overlay-score');
const overlayTitleEl = document.querySelector('.overlay-title');

/** Monotonic token so stale game-over count-up animations do not write after restart. */
let overlayAnimGeneration = 0;
const startScreenEl = document.getElementById('start-screen');
const startBtnEl = document.getElementById('start-btn');
const startStatusEl = document.getElementById('start-status');

const LANE_WIDTH = 2.2;
const LANES = [-1, 0, 1];
const laneX = (i) => i * LANE_WIDTH;
/** Outer X edges of the three-lane strip (for gap-wall collision). */
const TRACK_X_MIN = laneX(-1) - LANE_WIDTH * 0.5;
const TRACK_X_MAX = laneX(1) + LANE_WIDTH * 0.5;
/** Two side blocks, one lane gap (Beat Saber-style). */
const GAP_WALL_DEPTH = 3.5;
const GAP_WALL_Y = 0.75;
const GAP_WALL_HALF_H = 0.675;

/** 1 world unit along the track ≈ 1 m for HUD / score; `travelSpeed` ≈ m/s → km/h. */
function travelSpeedToKph(travelSpeed) {
  return travelSpeed * 3.6;
}

function updateSpeedHud(travelSpeed) {
  const kph = Math.round(travelSpeedToKph(travelSpeed));
  if (speedHudEl) speedHudEl.textContent = `${kph} km/h`;
}

/** 1 world unit along the track ≈ 1 m for HUD / score. */
function calcRunScore(metersInt, coins) {
  return Math.floor(coins * metersInt);
}

function showGameOverRollup(metersRun, coinsCollected, finalScore) {
  overlayAnimGeneration += 1;
  const gen = overlayAnimGeneration;

  if (overlayMetersEl) overlayMetersEl.textContent = '0 m';
  if (overlayCoinsEl) overlayCoinsEl.textContent = '0';
  if (overlayScoreEl) overlayScoreEl.textContent = '0';

  if (overlayTitleEl) {
    overlayTitleEl.classList.remove('overlay-title--run');
    void overlayTitleEl.offsetWidth;
    overlayTitleEl.classList.add('overlay-title--run');
  }
  if (overlayStatsEl) {
    overlayStatsEl.classList.remove('stats-enter');
    void overlayStatsEl.offsetWidth;
    overlayStatsEl.classList.add('stats-enter');
  }

  function runCount(el, target, duration, delay, format) {
    if (!el) return;
    const t0 = performance.now() + delay;
    function frame(now) {
      if (gen !== overlayAnimGeneration) return;
      if (now < t0) {
        requestAnimationFrame(frame);
        return;
      }
      const u = Math.min(1, (now - t0) / duration);
      const eased = 1 - (1 - u) ** 3;
      const v = Math.round(target * eased);
      el.textContent = format(v);
      if (u < 1) requestAnimationFrame(frame);
      else el.textContent = format(target);
    }
    requestAnimationFrame(frame);
  }

  runCount(overlayMetersEl, metersRun, 620, 90, (v) => `${v} m`);
  runCount(overlayCoinsEl, coinsCollected, 480, 320, (v) => String(v));
  runCount(overlayScoreEl, finalScore, 950, 580, (v) => String(v));
}

/** Touch phones/tablets: fewer pixels + no shadow pass (biggest WebGL wins on weak GPUs). */
function preferMobilePerf() {
  const coarse =
    typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
  const uaMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  return coarse || uaMobile;
}

let scene, camera, renderer;
/** Set in init: skip shadow map + tune resolution. */
let mobilePerf = false;
/** True after `init()` completes (WebGL + scene). Used to avoid double init on retry. */
let graphicsInited = false;
let playerGroup;
/** GLTF run cycle; null while using block placeholder. */
let playerMixer = null;
let playerRunAction = null;
let playerJumpAction = null;
/** While true, tick does not drive run cycle speed (jump clip owns the pose). */
let playerJumpAnimOverride = false;
let jumpAnimSetupGeneration = 0;
let jumpAnimWatchdog = null;
let playerStartAction = null;
/** World sim (movement, spawns) runs only after optional start intro clip finishes. */
let runGameplayActive = true;
let introSetupGeneration = 0;
/** Start-sequence camera dolly (tick skips camera while !runGameplayActive). */
let introCameraActive = false;
let introCameraElapsed = 0;
let introCameraDuration = 2.5;

/**
 * Tries these GLBs in order (first load wins). Prefer `char_ani/` when run + stretch + jump
 * live in **one** file. The Tripo export `ab99…glb` is static (no skeleton or clips).
 */
const PLAYER_GLTF_CANDIDATES = [
  'sounds/char/char_ani/pink+space+explorer+3d+model.glb',
  'sounds/char/char_ani/char.glb',
  'sounds/char/char_ani/character.glb',
  'sounds/char/char.glb',
  'sounds/char/player.glb',
  'sounds/char/character.glb',
  'sounds/char/runner.glb',
  'sounds/char/ab99f594-afb4-408f-be12-3473d9f21ed3.glb',
];
/** Jump clip: prefer `jump.glb` (same skeleton as `char.glb`). */
const JUMP_GLTF_CANDIDATES = [
  'sounds/char/jump.glb',
  'sounds/char/Jump.glb',
  'sounds/char/jumo.glb',
  'sounds/char/jump animation.glb',
  'sounds/char/jump_animation.glb',
  'sounds/char/jumpAnimation.glb',
];
/** Pre-run intro: prefer `stretch.glb`, then other start-style files. */
const START_GLTF_CANDIDATES = [
  'sounds/char/stretch.glb',
  'sounds/char/Stretch.glb',
  'sounds/char/start.glb',
  'sounds/char/Start.glb',
  'sounds/char/start_animation.glb',
  'sounds/char/start animation.glb',
];
/** First load wins; scaled to ~0.36 m for pickup. */
const COIN_GLTF_CANDIDATES = [
  'sounds/char/coin.glb',
  'sounds/char/Coin.glb',
  'sounds/coin.glb',
  'sounds/coins/coin.glb',
  'sounds/items/coin.glb',
];
/** Template group (not in scene); clones become collectibles. */
let coinPrefab = null;
let coinPrefabIsSkinned = false;
/**
 * Fine-tune after auto-orient (default faces down +Z, away from camera). Use ±Math.PI/2 if your GLB is sideways.
 */
const PLAYER_MODEL_Y_ROTATION = 0;
/** Yaw added during start intro so the character faces the camera (run uses +Z away from cam). */
const PLAYER_INTRO_FACE_CAMERA_YAW = Math.PI;
let worldGroup;
let speed = 12;
let baseSpeed = 12;
/** Extra speed from distance; ramps up so the run gets faster over time. */
const SPEED_RAMP_PER_UNIT = 0.022;
const SPEED_MAX_BONUS = 36;
let distance = 0;
let coinCount = 0;
let alive = true;
/** False until Play preloads audio and unlocks the run (fixes prod / autoplay / stutter). */
let gameStarted = false;
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
/** Collision box top offset from feet: standing vs ducked (e.g. low obstacles). */
const PLAYER_STAND_TOP = 1.45;
const PLAYER_DUCK_TOP = 0.74;
/** Duck in quickly; stand up slowly (~2s) after key-up. */
const DUCK_LERP_IN = 13;
const DUCK_LERP_OUT = 1.55;
/**
 * Rigged character: blend a slide/duck clip using `playerGroup.userData.duckAmount` (0–1) or
 * `playerGroup.userData.visualRoot.userData.duckBlend` (same value each frame while grounded).
 */
let duckHeld = false;
let duckAmount = 0;
/** Boost pad: higher launch than jump + brief forward surge. */
const BOOST_PAD_VY = 27;
const BOOST_SPEED_MULT = 1.45;
const BOOST_SPEED_SEC = 1.05;
/** Jump pad length along Z; keep collision `padHalfD` in sync. */
const BOOST_PAD_DEPTH = 2.85;
/** After a jump pad, base run speed bonus climbs faster for a few seconds. */
const BOOST_PAD_ACCEL_SEC = 3.75;
const BOOST_PAD_EXTRA_BONUS_RATE = 12;
/** Ramps up along +Z (front lip); keep in sync with `makeCurvedJumpPadGeometry`. */
const BOOST_PAD_MAX_LIFT = 0.34;

/** Ground speed-only pad (red / pink); long strip like Wipeout — keep `powerHalfD` in sync. */
const POWER_PAD_DEPTH = 7.2;
const POWER_SPEED_MULT = 1.28;
const POWER_SPEED_SEC = 1.45;

const obstacles = [];
const coins = [];
const boostPads = [];
const powerPads = [];
/** Global time for hologram / boost shader animation (synced in render loop). */
let holoTime = 0;
let speedBoostRemain = 0;
/** Jump-pad: temporary faster climb toward `SPEED_MAX_BONUS`. */
let boostRampRemain = 0;
/** Separate from jump-pad boost; stacks multiplicatively in `tick`. */
let powerSpeedRemain = 0;
let nextSpawnZ = 20;
/** Center Z of last hazard; used to enforce forward spacing. */
let lastObstacleCenterZ = -1e9;
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
/** Shared context for BGM FFT (one `MediaElementSource` per `<audio>`). */
let bgmAudioContext = null;
let bgmAnalyser = null;
let bgmFreqData = null;
/** Lowpass on BGM graph for tunnel “enclosed” muffling; null if Web Audio graph failed. */
let bgmTunnelLowpass = null;
let bgmTunnelMuffle = 0;
/** Eased FFT bands — backdrop uses these so bass hits don’t flash (photosensitivity). */
let bgmEaseBass = 0;
let bgmEaseMid = 0;
let bgmEaseHigh = 0;

/** Music-reactive backdrop (follows the run along +Z). */
let musicBackdropGroup = null;
let musicSkyMaterial = null;
let musicStarsMaterial = null;
let musicGridFloorMaterial = null;
let musicGridCeilingMaterial = null;
let musicPulseTime = 0;
/** Single shader slab: soft neon lanes + rails (no mesh seams); colors track sky; foot/jump pulse. */
let runwaySlabMat = null;
let runwayLanePulse = 0;
/** Fast decaying flash when feet hit the deck (slab shader; linear 0–1, shader squares for tight core). */
let runwayFootFlash = 0;
/** Footstep rhythm while grounded (sine zero-cross → pulse under player). */
let runFootPhase = 0;
let lastRunFootSin = 1;
/** After land/boost, ignore one footstep cross so we don’t double-fire with impact. */
let skipNextFootstepDetect = false;
/** Decaying landing punch for subtle camera shake (jump land). */
let landShakeMag = 0;
let landShakePhase = 0;
/** Eased camera height; tracks vertical jump. */
let cameraSmoothedY = 4.2;
const CAM_Y_AT_REST = 4.2;
const CAM_Y_LIFT_PER_PLAYER_Y = 0.58;
const CAM_LOOK_Y_AT_REST = 1.05;
const CAM_LOOK_LIFT_PER_PLAYER_Y = 0.46;
const CAM_Y_SMOOTH_RATE = 12;
/** Camera sits this far behind the runner on +Z (gameplay). */
const CAM_GAME_Z_OFFSET = 6.5;
/** Dolly distance behind player during intro close-up (smaller = tighter on character). */
const CAM_INTRO_Z_CLOSE = 2.45;
let hemiLightRef = null;
let dirLightRef = null;
const tmpMusicColor = new THREE.Color();
const tmpMusicFogTarget = new THREE.Color();
const BGM_VOLUME = 0.38;
const BGM_RATE_MIN = 1;
/** Max BGM speed-up; tied to the same 0..1 ramp as travel speed (not boost pads). */
const BGM_RATE_MAX = 1.32;
/** BGM lowpass when outside tunnels (Hz); inside tunnels lerps toward `BGM_TUNNEL_MUFFLE_HZ`. */
const BGM_OPEN_LOWPASS_HZ = 16000;
const BGM_TUNNEL_MUFFLE_HZ = 620;
const BGM_TUNNEL_MUFFLE_SMOOTH = 5.2;
/** BGM ramps 0 → BGM_VOLUME while the start intro plays (see `updateBgmPlayback`). */
let bgmIntroFadeActive = false;
let bgmIntroFadeT = 0;
let bgmIntroFadeDuration = 2.4;

/** Set in `tick` from the same `distance` used to compute `speed` that frame (boost ignored). */
let difficultyRampT = 0;

function makeRunwaySlabShaderMaterial() {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uScroll: { value: 0 },
      uTime: { value: 0 },
      uPulse: { value: 0 },
      uImpact: { value: 0 },
      uLaneW: { value: LANE_WIDTH },
      uCyan: { value: new THREE.Color(0x00f5ff) },
      uMagenta: { value: new THREE.Color(0xff0a78) },
      uVoid: { value: new THREE.Color(0x030009) },
      uEnvMap: { value: null },
      uCamPos: { value: new THREE.Vector3() },
      uEnvIntensity: { value: 1.32 },
      uFootFlash: { value: 0 },
      uPlayerX: { value: 0 },
      uPlayerZ: { value: 0 },
    },
    fog: false,
    transparent: false,
    depthWrite: true,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
    vertexShader: `
      varying vec3 vWPos;
      varying vec3 vWorldNormal;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWPos = wp.xyz;
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      varying vec3 vWPos;
      varying vec3 vWorldNormal;
      uniform float uScroll;
      uniform float uTime;
      uniform float uPulse;
      uniform float uImpact;
      uniform float uLaneW;
      uniform vec3 uCyan;
      uniform vec3 uMagenta;
      uniform vec3 uVoid;
      uniform samplerCube uEnvMap;
      uniform vec3 uCamPos;
      uniform float uEnvIntensity;
      uniform float uFootFlash;
      uniform float uPlayerX;
      uniform float uPlayerZ;

      void main() {
        float ax = abs(vWPos.x);
        float z = vWPos.z + uScroll;

        float toL = abs(vWPos.x + uLaneW);
        float toC = abs(vWPos.x);
        float toR = abs(vWPos.x - uLaneW);
        float w2 = uLaneW * uLaneW * 0.34;
        float wL = exp(-toL * toL / w2);
        float wC = exp(-toC * toC / w2);
        float wR = exp(-toR * toR / w2);
        float ws = wL + wC + wR + 1e-4;
        wL /= ws;
        wC /= ws;
        wR /= ws;
        vec3 laneNeon = uCyan * (wL * 0.52 + wC * 0.78) + uMagenta * (wR * 0.58);

        float mist = 0.5 + 0.5 * sin(z * 0.07 + uTime * 0.9 + vWPos.x * 0.12);
        vec3 haze = mix(uMagenta * 0.14, uCyan * 0.16, mist);

        float depth = smoothstep(100.0, -15.0, vWPos.z);
        float beat = 0.3 + uPulse * 0.24;
        float intf = sin(z * 0.32 + uTime * 2.0) * sin(ax * 2.0 - uTime * 1.55) * 0.5 + 0.5;
        float scanY = sin(vWPos.y * 16.0 - uTime * 4.0) * 0.5 + 0.5;
        float scanXZ = sin(dot(vWPos.xz, vec2(6.8, 4.9)) + uTime * 3.2) * 0.5 + 0.5;
        float holoScan = scanY * 0.52 + scanXZ * 0.48;
        laneNeon *= 0.9 + intf * 0.16 * (1.0 + uPulse * 0.85);

        // Side rails: gradient magenta (inboard) → cyan tint → soft void (outboard), like a light tube.
        float railWide =
          smoothstep(uLaneW * 1.415, uLaneW * 1.448, ax) * (1.0 - smoothstep(uLaneW * 1.598, uLaneW * 1.655, ax));
        float railCore =
          smoothstep(uLaneW * 1.428, uLaneW * 1.442, ax) * (1.0 - smoothstep(uLaneW * 1.608, uLaneW * 1.628, ax));
        float rIn = uLaneW * 1.415;
        float rOut = uLaneW * 1.68;
        float tRail = clamp((ax - rIn) / max(rOut - rIn, 0.001), 0.0, 1.0);
        vec3 railInn = uMagenta * 0.62;
        vec3 railMid = mix(uMagenta, uCyan, 0.42) * 0.48;
        vec3 railOut = mix(uVoid.rgb * 0.42, uMagenta * 0.1, 0.55);
        vec3 railGradCol = mix(mix(railInn, railMid, smoothstep(0.0, 0.5, tRail)), railOut, smoothstep(0.38, 1.0, tRail));
        vec3 railGlow = railGradCol * (railWide * 0.32 + railCore * 0.72) * (0.58 + uPulse * 0.1);
        float railOuter =
          smoothstep(uLaneW * 1.72, uLaneW * 1.82, ax) * (1.0 - smoothstep(uLaneW * 1.96, uLaneW * 2.12, ax));
        vec3 railHalo = mix(uMagenta, uCyan, 0.35) * railOuter * (0.05 + uPulse * 0.03 + beat * 0.025);

        vec3 base = uVoid.rgb * 1.05 + vec3(0.028, 0.022, 0.048);
        vec3 underGlow = laneNeon * beat * (0.22 + depth * 0.16);
        underGlow += haze * beat * 0.2 * (1.0 - railWide * 0.85);
        vec3 holoTint = mix(uCyan * 0.42, uMagenta * 0.38, 0.5);
        underGlow += holoTint * (0.1 + uPulse * 0.12) * (0.38 + holoScan * 0.62);
        underGlow += railGlow;
        underGlow += railHalo;
        float corridorAura = exp(-ax * ax / (uLaneW * uLaneW * 3.6)) * (0.1 + beat * 0.055 + uPulse * 0.04);
        underGlow += mix(uCyan * 0.45, uMagenta * 0.38, 0.5) * corridorAura * (1.0 - railCore * 0.7);

        vec3 N = normalize(vWorldNormal);
        vec3 V = normalize(uCamPos - vWPos);
        float ndv = clamp(dot(N, V), 0.0, 1.0);
        float fresnel = pow(1.0 - ndv, 4.5) * 0.65 + 0.04;
        float haloRim = pow(1.0 - ndv, 2.15) * (0.38 + beat * 0.12);
        vec3 haloTint = mix(uCyan * 0.6, uMagenta * 0.55, 0.48 + uPulse * 0.18);
        vec3 haloAdd = haloTint * haloRim * (1.0 - railCore * 0.22);
        float holoFres = pow(1.0 - ndv, 2.85) * (0.2 + uPulse * 0.16 + holoScan * 0.08);
        haloAdd += mix(uCyan, uMagenta, 0.42) * holoFres;
        vec3 R = reflect(-V, N);
        R.xz *= vec2(1.0, 1.1);
        vec3 envCol = textureCube(uEnvMap, R).rgb;
        vec3 reflection = envCol * uEnvIntensity * fresnel * (0.34 + beat * 0.14);
        reflection += haloTint * fresnel * (0.15 + beat * 0.07);

        vec3 jumpPulse = (uCyan * 0.42 + uMagenta * 0.48) * uImpact * 0.2;

        float fLin = clamp(uFootFlash, 0.0, 1.0);
        float fCore = fLin * fLin;
        float pd = length(vec2(vWPos.x - uPlayerX, vWPos.z - uPlayerZ));
        float footCore = fCore * exp(-pd * 0.48) * 0.82;
        float rippleOut = (1.0 - fLin) * 10.5;
        float footRing1 =
          fLin * 0.52 * exp(-pow(pd - rippleOut * 0.52, 2.0) / (5.8 + rippleOut * 0.45));
        float footRing2 =
          fLin * 0.34 * exp(-pow(pd - rippleOut * 0.95, 2.0) / (18.0 + rippleOut * 0.85));
        vec3 footCol = mix(uCyan, uMagenta, sin(pd * 0.5 - uTime * 5.5) * 0.5 + 0.5);
        vec3 footAdd = footCol * (footCore * 0.72 + footRing1 + footRing2);
        footAdd += (uCyan + uMagenta) * 0.042 * fLin * exp(-pd * 0.075);

        vec3 rgb = base + underGlow + haloAdd + reflection + jumpPulse + footAdd;
        rgb = min(rgb, vec3(1.14));
        gl_FragColor = vec4(rgb, 1.0);
      }
    `,
  });
  return mat;
}

function ensureRunwayMaterials() {
  if (runwaySlabMat) return;

  runwaySlabMat = makeRunwaySlabShaderMaterial();
  if (scene?.environment) {
    runwaySlabMat.uniforms.uEnvMap.value = scene.environment;
  }
}

function bumpRunwayLanePulse(amount = 1) {
  runwayLanePulse = Math.min(1, runwayLanePulse + amount);
}

/** Landing / foot contact: bright ring on slab + lane color burst. */
function bumpRunwayFootImpact(strength = 1) {
  runwayFootFlash = Math.min(1, runwayFootFlash + strength);
  bumpRunwayLanePulse(0.5 * strength);
}

/** After a normal jump, play land once when feet touch the ground. */
let pendingLandSfx = false;
/** HTML Audio run loop (lightweight vs Web Audio stretch). */
let runAudio = null;
/** Blob URLs for one-shots (preloaded on start screen). */
let sfxObjectUrls = {};
/** Rotate through clips so rapid coin pickups do not cancel each other. */
let coinAudioPool = [];
let coinPoolIdx = 0;
/** Throttle expensive per-frame mesh updates. */
let tickFrame = 0;
/** Each coin raises playbackRate (higher pitch); capped so it stays usable. */
const COIN_PITCH_STEP = 0.07;
const COIN_PITCH_MAX_RATE = 2.35;

const SFX_PRELOAD_PATHS = {
  run: 'sounds/run.mp3',
  jump: 'sounds/jump.mp3',
  land: 'sounds/land.mp3',
  coin: 'sounds/coin.mp3',
  boost: 'sounds/boost.mp3',
  gameover: 'sounds/gameover.mp3',
};

function waitAudioElementReady(audioEl, timeoutMs = 12000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(tid);
      resolve();
    };
    const tid = window.setTimeout(done, timeoutMs);
    if (audioEl.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
      done();
      return;
    }
    const onReady = () => done();
    audioEl.addEventListener('canplaythrough', onReady, { once: true });
    audioEl.addEventListener('canplay', onReady, { once: true });
    audioEl.addEventListener('error', onReady, { once: true });
    try {
      audioEl.load();
    } catch {
      done();
    }
  });
}

async function fetchFirstWorkingBgmBlob() {
  for (const rel of BGM_URLS) {
    try {
      const r = await fetch(publicAsset(rel));
      if (!r.ok) continue;
      const ct = r.headers.get('content-type');
      if (ct && ct.includes('text/html')) continue;
      return await r.blob();
    } catch {
      /* try next */
    }
  }
  return null;
}

function revokeAllSfxObjectUrls() {
  for (const u of Object.values(sfxObjectUrls)) {
    if (u) URL.revokeObjectURL(u);
  }
  sfxObjectUrls = {};
}

async function fetchAllSfxObjectUrls() {
  const out = {};
  await Promise.all(
    Object.entries(SFX_PRELOAD_PATHS).map(async ([key, path]) => {
      try {
        const r = await fetch(publicAsset(path));
        if (!r.ok) return;
        const ct = r.headers.get('content-type');
        if (ct && ct.includes('text/html')) return;
        out[key] = URL.createObjectURL(await r.blob());
      } catch {
        /* skip */
      }
    }),
  );
  return out;
}

function initCoinAudioPool() {
  coinAudioPool = [];
  coinPoolIdx = 0;
  const url = sfxObjectUrls.coin;
  if (!url) return;
  for (let i = 0; i < 4; i += 1) {
    const a = new Audio(url);
    a.preload = 'auto';
    a.volume = 0.52;
    coinAudioPool.push(a);
  }
}

function playOneShotFromCache(key, volume, playbackRate = 1) {
  if (!bgmUnlocked || !sfxObjectUrls[key]) return;
  const a = new Audio(sfxObjectUrls[key]);
  a.volume = volume;
  a.playbackRate = playbackRate;
  a.play().catch(() => {});
}

function playJumpSfx() {
  playOneShotFromCache('jump', 0.55);
}

function playLandSfx() {
  playOneShotFromCache('land', 0.48);
}

function playCoinSfx(totalCoins) {
  if (!bgmUnlocked || coinAudioPool.length === 0) return;
  const n = Math.max(1, totalCoins);
  const rate = Math.min(COIN_PITCH_MAX_RATE, 1 + (n - 1) * COIN_PITCH_STEP);
  const a = coinAudioPool[coinPoolIdx % coinAudioPool.length];
  coinPoolIdx += 1;
  a.pause();
  a.currentTime = 0;
  a.playbackRate = rate;
  a.play().catch(() => {});
}

function playBoostSfx() {
  playOneShotFromCache('boost', 0.58);
}

function playPowerPadSfx() {
  playOneShotFromCache('boost', 0.44, 1.22);
}

function playGameOverSfx() {
  playOneShotFromCache('gameover', 0.62);
}

function updateRunSfx() {
  if (!gameStarted || !runGameplayActive || !runAudio || !bgmUnlocked) return;
  if (!alive) {
    if (!runAudio.paused) runAudio.pause();
    return;
  }
  const onTunnelRoof =
    getTunnelStripeAtZ(distance) &&
    (() => {
      const { roofTopY } = tunnelGeomConsts();
      return playerY >= roofTopY - 0.09 && playerY <= roofTopY + 0.26 && playerVy <= 0.08;
    })();
  const grounded = playerY < 0.02 || onTunnelRoof;
  if (grounded) {
    if (runAudio.paused) runAudio.play().catch(() => {});
    runAudio.playbackRate = THREE.MathUtils.clamp(
      0.92 + difficultyRampT * 0.42 + (powerSpeedRemain > 0 ? 0.14 : 0),
      0.75,
      1.65,
    );
  } else if (!runAudio.paused) {
    runAudio.pause();
  }
}

function syncBgmPlayState() {
  if (!gameStarted || !bgmAudio || !bgmUnlocked) return;
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

function unlockBgm() {
  bgmUnlocked = true;
  if (bgmAudioContext && bgmAudioContext.state === 'suspended') {
    bgmAudioContext.resume().catch(() => {});
  }
  if (bgmAudio) {
    if (!runGameplayActive) {
      bgmAudio.volume = 0;
      bgmIntroFadeActive = true;
      bgmIntroFadeT = 0;
    } else {
      bgmAudio.volume = BGM_VOLUME;
      bgmIntroFadeActive = false;
    }
  }
  syncBgmPlayState();
}

function updateBgmPlayback(dt) {
  updateBgmTunnelLowpassFilter(dt);
  if (!gameStarted || !bgmAudio || !bgmUnlocked) return;
  if (!alive) {
    if (!bgmAudio.paused) bgmAudio.pause();
    return;
  }
  if (bgmIntroFadeActive && !runGameplayActive) {
    bgmIntroFadeT += dt;
    const d = Math.max(bgmIntroFadeDuration, 0.25);
    const u = Math.min(1, bgmIntroFadeT / d);
    const s = u * u * (3 - 2 * u);
    bgmAudio.volume = BGM_VOLUME * s;
    const targetRate = BGM_RATE_MIN + difficultyRampT * (BGM_RATE_MAX - BGM_RATE_MIN);
    bgmAudio.playbackRate = THREE.MathUtils.clamp(targetRate, 0.85, 2);
    syncBgmPlayState();
    return;
  }
  if (bgmIntroFadeActive && runGameplayActive) {
    bgmIntroFadeActive = false;
    bgmAudio.volume = BGM_VOLUME;
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

function isBindOrPoseClipName(name) {
  const n = name.toLowerCase();
  return (
    /t[-_\s]?pose|tpose|a[-_\s]?pose|apose|bind|rest\s*pose|reference|default\s*pose|skinning|armature/i.test(
      n,
    ) || (n.includes('idle') && !/run|jog|sprint|walk|move|locomotion/.test(n))
  );
}

/**
 * For **dedicated** motion GLBs (`jump.glb`, `stretch.glb`): clip names often contain
 * `Armature|...` — that must not count as a bind pose or we never accept the only clip.
 */
function isStrictStaticAnimationClipName(name) {
  const n = String(name).toLowerCase();
  return (
    /t[-_\s]?pose|tpose|a[-_\s]?pose|apose|bind\s*pose|rest\s*pose|reference\s*pose|default\s*pose|^\s*armature\s*$/i.test(
      n,
    ) || (n.includes('idle') && !/run|jog|sprint|walk|move|locomotion|jump|leap|hop|vault/.test(n))
  );
}

/** Pick a clip from an external GLB when name-based heuristics miss (e.g. `Armature|Layer0`). */
function pickClipFromExternalMotionGltf(animations) {
  const anims = animations ?? [];
  if (!anims.length) return null;
  const usable = anims.filter((a) => !isStrictStaticAnimationClipName(a.name));
  const pool = usable.length ? usable : anims;
  if (pool.length === 1) return pool[0];
  if (pool.length > 1) {
    const sorted = [...pool].sort((a, b) => (b.duration || 0) - (a.duration || 0));
    return sorted[0];
  }
  return null;
}

function getFirstSkinnedMesh(root) {
  let found = null;
  root?.traverse?.((o) => {
    if (o.isSkinnedMesh && !found) found = o;
  });
  return found;
}

function guessHipBoneName(skeleton) {
  const bones = skeleton?.bones;
  if (!bones?.length) return 'Hips';
  for (const b of bones) {
    const n = b.name.toLowerCase();
    if (n.includes('hip') && !n.includes('thumb')) return b.name;
  }
  return bones[0].name;
}

/**
 * `SkeletonUtils.retargetClip` emits `.bones[name].quaternion` paths that only bind when the
 * mixer root **is** the SkinnedMesh. Our mixer root is the whole GLTF scene, so prefix with the
 * mesh node name (same pattern GLTFLoader uses for tracks).
 */
function prefixRetargetedClipForSkinnedMesh(clip, skinnedMesh) {
  const raw = skinnedMesh.name || 'PlayerSkinned';
  const meshName = THREE.PropertyBinding.sanitizeNodeName(raw) || 'PlayerSkinned';
  const tracks = clip.tracks.map((t) => {
    const nt = t.clone();
    nt.name = t.name.startsWith('.') ? meshName + t.name : `${meshName}.${t.name}`;
    return nt;
  });
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}

/**
 * Blender/Tripo NLA: `NlaTrack` names with no semantics. Typical 3-clip export (Tripo):
 * **longest** = stretch/hold, **middle** = jump (single action), **shortest** = run loop.
 * Two clips: longer = run, shorter = jump.
 */
function resolveBlenderNlaStyleClips(animations) {
  if (!animations?.length) return null;
  const lower = animations.map((c) => c.name.toLowerCase());
  const pool = animations.filter((_, i) => !isBindOrPoseClipName(lower[i]));
  if (pool.length < 2) return null;
  const nlaStyle = (raw) => {
    const n = String(raw).trim().toLowerCase();
    return (
      n.includes('nlatrack') || n.startsWith('nla_') || /^nla[^a-z]?track/i.test(String(raw).trim())
    );
  };
  if (!pool.every((c) => nlaStyle(c.name))) return null;
  const sorted = [...pool].sort((a, b) => (b.duration || 0) - (a.duration || 0));
  if (pool.length === 2) {
    return { run: sorted[0], jump: sorted[1] };
  }
  if (pool.length === 3) {
    return {
      run: sorted[2],
      jump: sorted[1],
    };
  }
  const runIdx = sorted.length - 1;
  const jumpIdx = Math.max(1, sorted.length - 2);
  return {
    run: sorted[runIdx],
    jump: sorted[jumpIdx],
  };
}

/**
 * Three+ motion clips, any names: longest = hold/stretch, second-shortest = jump, shortest = run
 * (same convention as NLA 3-pack and `resolveBlenderNlaStyleClips` for 4+ tracks).
 * Requires **at least** three clips — exports with a bind pose + 3 motions were previously rejected
 * when `pool.length === 4` and jump never resolved.
 */
function resolveThreeClipDurationPack(animations) {
  if (!animations?.length) return null;
  const lower = animations.map((c) => c.name.toLowerCase());
  const pool = animations.filter((_, i) => !isBindOrPoseClipName(lower[i]));
  if (pool.length < 3) return null;
  const sorted = [...pool].sort((a, b) => (b.duration || 0) - (a.duration || 0));
  const run = sorted[sorted.length - 1];
  const jump = sorted[sorted.length - 2];
  if (!run || !jump || run === jump) return null;
  return { run, jump };
}

function pickRunAnimationClip(clips) {
  if (!clips?.length) return null;
  const lower = clips.map((c) => c.name.toLowerCase());
  const motion = [
    'run',
    'sprint',
    'jog',
    'running',
    'locomotion',
    'fast run',
    'fast_run',
    'walk',
    'move',
  ];
  const candidates = clips.filter((_, i) => !isBindOrPoseClipName(lower[i]));
  const pool = candidates.length ? candidates : clips;
  const poolLower = pool.map((c) => c.name.toLowerCase());
  for (const k of motion) {
    const i = poolLower.findIndex((n) => n.includes(k));
    if (i >= 0) return pool[i];
  }
  const nonIdle = pool.filter((_, i) => !poolLower[i].includes('idle'));
  if (nonIdle.length) return nonIdle[0];
  return pool[0];
}

/**
 * Pick a jump clip. `excludeClip` is usually the run clip so we never treat the same
 * animation as both run and jump (e.g. a clip named "Running Jump").
 */
function pickJumpAnimationClip(clips, excludeClip = null) {
  if (!clips?.length) return null;
  const lower = clips.map((c) => c.name.toLowerCase());
  const candidates = clips.filter((_, i) => !isBindOrPoseClipName(lower[i]));
  const pool = candidates.length ? candidates : clips;
  const poolLower = pool.map((c) => c.name.toLowerCase());
  const keys = ['jump', 'leap', 'hop', 'vault', 'bounce', 'spring', 'takeoff', 'aerial', 'bound', 'lift'];
  for (const k of keys) {
    for (let i = 0; i < pool.length; i++) {
      if (excludeClip && pool[i] === excludeClip) continue;
      if (poolLower[i].includes(k)) return pool[i];
    }
  }
  return null;
}

function isProbablyStartOrIdleClipName(name) {
  const n = String(name).toLowerCase();
  return (
    /stretch|start|intro|ready|countdown|\bcount\b|mark|idle|walk|strafe|stand|breathe|look|t[-_\s]?pose/i.test(
      n,
    ) && !/jump|leap|hop|vault|bounce|run|jog|sprint|locomotion|move/i.test(n)
  );
}

/**
 * Jump clip when names are generic (`Take 001`, `Animation`) or there are 3+ clips on one GLB.
 * `alsoExclude` should be the resolved **intro/start** clip (same file) so only run + start + jump
 * leaves a single jump candidate.
 */
function pickFallthroughJumpClip(clips, runClip, alsoExclude = null) {
  if (!clips?.length || !runClip) return null;
  const lower = clips.map((c) => c.name.toLowerCase());
  const pool = clips.filter((_, i) => !isBindOrPoseClipName(lower[i]));
  const others = pool.filter((c) => c !== runClip && c !== alsoExclude);
  if (others.length === 0) return null;
  for (const c of others) {
    if (/jump|leap|hop|vault|bounce|aerial|spring|takeoff|bound/i.test(c.name)) return c;
  }
  const notStartIdle = others.filter((c) => !isProbablyStartOrIdleClipName(c.name));
  const narrowed = notStartIdle.length ? notStartIdle : others;
  if (narrowed.length === 1) return narrowed[0];
  if (narrowed.length > 1) {
    return [...narrowed].sort((a, b) => (a.duration || 0) - (b.duration || 0))[0];
  }
  return null;
}

/** Start only when the name hints intro; never guess from a lone extra clip (avoids using jump as intro). */
function pickFallthroughStartClip(clips, runClip) {
  if (!clips?.length || !runClip) return null;
  const lower = clips.map((c) => c.name.toLowerCase());
  const pool = clips.filter((_, i) => !isBindOrPoseClipName(lower[i]));
  const others = pool.filter((c) => c !== runClip);
  for (const c of others) {
    if (/stretch|start|intro|ready|countdown|\bcount\b|mark/i.test(c.name)) return c;
  }
  return null;
}

function isUsableAnimClip(c) {
  return c != null && typeof c.duration === 'number' && c.duration >= 0.05;
}

/**
 * Start / intro clip. `excludeClip` is the run clip so we never use one animation for both
 * (e.g. "intro run"). Single-clip fallback only if that clip is not the run clip.
 */
function pickStartAnimationClip(clips, excludeClip = null) {
  if (!clips?.length) return null;
  const lower = clips.map((c) => c.name.toLowerCase());
  const candidates = clips.filter((_, i) => !isBindOrPoseClipName(lower[i]));
  const pool = candidates.length ? candidates : clips;
  const poolLower = pool.map((c) => c.name.toLowerCase());
  const keys = ['stretch', 'start', 'intro', 'ready', 'countdown', 'count', 'mark'];
  for (const k of keys) {
    for (let i = 0; i < pool.length; i++) {
      if (excludeClip && pool[i] === excludeClip) continue;
      if (poolLower[i].includes(k)) return pool[i];
    }
  }
  if (pool.length === 1 && pool[0] !== excludeClip) return pool[0];
  return null;
}

function removePlayerStartIntroListener() {
  const m = playerMixer;
  if (m?.userData._startWatchdog != null) {
    window.clearTimeout(m.userData._startWatchdog);
    delete m.userData._startWatchdog;
  }
  if (m?.userData._startFinishedHandler) {
    m.removeEventListener('finished', m.userData._startFinishedHandler);
    delete m.userData._startFinishedHandler;
  }
}

/** Start intro faces the camera; run faces down the track (+Z). */
function applyIntroFacingTowardCamera() {
  const vr = playerGroup?.userData?.visualRoot;
  if (!vr || vr.userData.introFacingApplied) return;
  vr.userData.baseRunYaw = vr.rotation.y;
  vr.rotation.y = vr.userData.baseRunYaw + PLAYER_INTRO_FACE_CAMERA_YAW;
  vr.userData.introFacingApplied = true;
}

function restoreRunFacingAfterIntro() {
  const vr = playerGroup?.userData?.visualRoot;
  if (!vr || !vr.userData.introFacingApplied) return;
  vr.rotation.y = vr.userData.baseRunYaw;
  delete vr.userData.baseRunYaw;
  delete vr.userData.introFacingApplied;
}

/** 0 = gameplay framing, 1 = tight on character; synced to intro clip length. */
function introCamZoomCloseAmount(u) {
  const x = THREE.MathUtils.clamp(u, 0, 1);
  const sp = (t) => t * t * (3 - 2 * t);
  if (x < 0.34) return sp(x / 0.34);
  if (x < 0.56) return 1;
  return 1 - sp((x - 0.56) / 0.44);
}

function updateIntroCamera() {
  if (!camera || !playerGroup || !introCameraActive) return;
  const pz = distance;
  const denom = Math.max(introCameraDuration, 0.2);
  const u = Math.min(1, introCameraElapsed / denom);
  const closeAmt = introCamZoomCloseAmount(u);
  const backDist = THREE.MathUtils.lerp(CAM_GAME_Z_OFFSET, CAM_INTRO_Z_CLOSE, closeAmt);
  camera.position.z = pz - backDist;
  camera.position.x = THREE.MathUtils.lerp(
    camera.position.x,
    playerGroup.position.x * 0.48,
    0.14,
  );
  const baseY = CAM_Y_AT_REST + playerY * CAM_Y_LIFT_PER_PLAYER_Y;
  camera.position.y = baseY + closeAmt * 0.55;
  const lookY =
    CAM_LOOK_Y_AT_REST + playerY * CAM_LOOK_LIFT_PER_PLAYER_Y + closeAmt * 0.52;
  const lookAhead = pz + THREE.MathUtils.lerp(10, 3.6, closeAmt);
  camera.lookAt(playerGroup.position.x * (0.42 + closeAmt * 0.12), lookY, lookAhead);
}

function startRunAnimationImmediately() {
  if (introCameraActive) {
    cameraSmoothedY = camera.position.y;
  }
  introCameraActive = false;
  introCameraElapsed = 0;
  runGameplayActive = true;
  bgmIntroFadeActive = false;
  if (bgmAudio) bgmAudio.volume = BGM_VOLUME;
  restoreRunFacingAfterIntro();
  if (playerStartAction) {
    playerStartAction.stop();
    playerStartAction.setEffectiveWeight(0);
    playerStartAction = null;
  }
  if (playerRunAction) {
    playerRunAction.enabled = true;
    /** Avoid `stop()` here: run may never have been activated yet; deactivate/rebind can break the clip. */
    playerRunAction.reset();
    playerRunAction.setLoop(THREE.LoopRepeat, Infinity);
    playerRunAction.clampWhenFinished = false;
    playerRunAction.setEffectiveWeight(1);
    playerRunAction.paused = false;
    playerRunAction.timeScale = 1;
    playerRunAction.play();
  }
  syncPlayCursor();
}

function finishStartIntroAndRun() {
  if (runGameplayActive) return;
  removePlayerStartIntroListener();
  if (playerStartAction) {
    playerStartAction.stop();
    playerStartAction.setEffectiveWeight(0);
    playerStartAction = null;
  }
  startRunAnimationImmediately();
  last = performance.now();
}

function setupPlayerStartIntro(startClip) {
  if (!playerMixer || !playerRunAction || !startClip || !isUsableAnimClip(startClip)) {
    startRunAnimationImmediately();
    return;
  }
  if (startClip === playerRunAction.getClip()) {
    startRunAnimationImmediately();
    return;
  }
  removePlayerStartIntroListener();
  if (playerStartAction) playerStartAction.stop();
  applyIntroFacingTowardCamera();
  bgmIntroFadeDuration = THREE.MathUtils.clamp(startClip.duration * 0.95, 0.9, 5);
  bgmIntroFadeActive = true;
  bgmIntroFadeT = 0;
  if (bgmAudio) {
    bgmAudio.volume = 0;
  }
  /** Do not `stop()` run before first `play()` — keep mixer bindings consistent while start plays. */
  playerRunAction.setEffectiveWeight(0);
  playerRunAction.paused = true;
  introCameraDuration = Math.max(startClip.duration, 0.35);
  introCameraElapsed = 0;
  introCameraActive = true;
  playerStartAction = playerMixer.clipAction(startClip);
  playerStartAction.setLoop(THREE.LoopOnce, 1);
  playerStartAction.clampWhenFinished = true;
  playerStartAction.enabled = true;
  runGameplayActive = false;
  playerStartAction.stop();
  playerStartAction.reset();
  playerStartAction.setEffectiveWeight(1);
  playerStartAction.play();
  const handler = (e) => {
    if (e.action !== playerStartAction) return;
    finishStartIntroAndRun();
  };
  playerMixer.addEventListener('finished', handler);
  playerMixer.userData._startFinishedHandler = handler;
  const wMs = Math.max((startClip.duration + 0.75) * 1000, 2500);
  playerMixer.userData._startWatchdog = window.setTimeout(() => {
    if (playerMixer?.userData._startWatchdog != null) {
      delete playerMixer.userData._startWatchdog;
    }
    finishStartIntroAndRun();
  }, wMs);
}

async function tryLoadExternalStartClip() {
  const loader = new GLTFLoader();
  for (const rel of START_GLTF_CANDIDATES) {
    try {
      const sgltf = await loader.loadAsync(publicAsset(rel));
      let c = pickStartAnimationClip(sgltf.animations);
      if (!c) c = pickClipFromExternalMotionGltf(sgltf.animations);
      if (c && isUsableAnimClip(c)) return c;
    } catch {
      /* try next path */
    }
  }
  return null;
}

function removePlayerJumpFinishedListener() {
  if (jumpAnimWatchdog != null) {
    window.clearTimeout(jumpAnimWatchdog);
    jumpAnimWatchdog = null;
  }
  const m = playerMixer;
  if (m?.userData._jumpFinishedHandler) {
    m.removeEventListener('finished', m.userData._jumpFinishedHandler);
    delete m.userData._jumpFinishedHandler;
  }
}

function resumeRunAfterJumpAnim() {
  if (!playerJumpAnimOverride) return;
  removePlayerJumpFinishedListener();
  if (!playerRunAction || !playerJumpAction || !playerMixer) {
    playerJumpAnimOverride = false;
    return;
  }
  playerJumpAnimOverride = false;
  playerJumpAction.stopFading();
  playerJumpAction.stop();
  playerJumpAction.setEffectiveWeight(0);
  playerJumpAction.enabled = false;
  playerJumpAction.paused = true;
  playerRunAction.stopFading();
  playerRunAction.enabled = true;
  playerRunAction.reset();
  playerRunAction.setLoop(THREE.LoopRepeat, Infinity);
  playerRunAction.clampWhenFinished = false;
  playerRunAction.paused = false;
  playerRunAction.setEffectiveWeight(1);
  playerRunAction.timeScale = 1;
  playerRunAction.play();
}

function setupPlayerJumpAction(clip) {
  if (!playerMixer || !playerRunAction || !clip || !isUsableAnimClip(clip)) return;
  const runClip = playerRunAction.getClip();
  if (clip === runClip || clip.uuid === runClip.uuid) return;
  if (!clip.tracks?.length) return;
  removePlayerJumpFinishedListener();
  if (playerJumpAction) playerJumpAction.stop();
  playerJumpAction = playerMixer.clipAction(clip);
  playerJumpAction.setLoop(THREE.LoopOnce, 1);
  playerJumpAction.clampWhenFinished = true;
  /** New actions default to weight 1 — would blend against run and kill the skeleton until jump. */
  playerJumpAction.stop();
  playerJumpAction.setEffectiveWeight(0);
  playerJumpAction.enabled = false;
  playerJumpAction.paused = true;
  const handler = (e) => {
    if (e.action !== playerJumpAction || !playerRunAction) return;
    resumeRunAfterJumpAnim();
  };
  playerMixer.addEventListener('finished', handler);
  playerMixer.userData._jumpFinishedHandler = handler;
}

/**
 * Load `jump.glb` and bake its motion onto the **player** rig. Raw clips from another GLB target
 * different scene node UUIDs/names, so `clipAction` on the player mixer was a no-op.
 */
async function tryLoadExternalJumpClip(playerRoot) {
  const targetMesh = getFirstSkinnedMesh(playerRoot);
  if (!targetMesh?.skeleton) return null;

  const loader = new GLTFLoader();
  for (const rel of JUMP_GLTF_CANDIDATES) {
    try {
      const jgltf = await loader.loadAsync(publicAsset(rel));
      let c = pickJumpAnimationClip(jgltf.animations);
      if (!c) c = pickClipFromExternalMotionGltf(jgltf.animations);
      if (!c || !isUsableAnimClip(c)) continue;

      let srcHasSkinned = false;
      jgltf.scene.traverse((o) => {
        if (o.isSkinnedMesh) srcHasSkinned = true;
      });
      const srcScene = srcHasSkinned ? cloneSkinnedModel(jgltf.scene) : jgltf.scene.clone(true);
      const sourceMesh = getFirstSkinnedMesh(srcScene);
      if (!sourceMesh?.skeleton) {
        disposeObjectSubtree(srcScene);
        continue;
      }

      let retargeted;
      try {
        retargeted = retargetClip(targetMesh, sourceMesh, c, {
          hip: guessHipBoneName(targetMesh.skeleton),
          useFirstFramePosition: true,
        });
      } catch (err) {
        console.warn(`[SubwayBlocks] jump retarget failed (${rel}):`, err);
        disposeObjectSubtree(srcScene);
        continue;
      }

      disposeObjectSubtree(srcScene);

      if (!retargeted?.tracks?.length) continue;

      const prefixed = prefixRetargetedClipForSkinnedMesh(retargeted, targetMesh);
      if (prefixed.tracks.length && isUsableAnimClip(prefixed)) return prefixed;
    } catch {
      /* try next path */
    }
  }
  return null;
}

/** Run → jump: short crossfade so the rig doesn’t pop or freeze at a hard stop/disable. */
const PLAYER_RUN_TO_JUMP_CROSSFADE = 0.11;

function playPlayerJumpAnimation() {
  if (!playerMixer || !playerRunAction) return;
  const jumpRef =
    playerMixer.userData?.playerJumpClipRef ?? playerMixer.getRoot()?.userData?.playerJumpClipRef;
  if (!jumpRef?.tracks?.length || !isUsableAnimClip(jumpRef)) return;
  const runClip = playerRunAction.getClip();
  if (!runClip || jumpRef.uuid === runClip.uuid) return;
  if (!playerJumpAction || playerJumpAction.getClip()?.uuid !== jumpRef.uuid) {
    setupPlayerJumpAction(jumpRef);
  }
  if (!playerJumpAction) return;
  if (jumpAnimWatchdog != null) {
    window.clearTimeout(jumpAnimWatchdog);
    jumpAnimWatchdog = null;
  }
  playerJumpAnimOverride = true;
  removePlayerJumpFinishedListener();

  const fadeSec = PLAYER_RUN_TO_JUMP_CROSSFADE;
  playerJumpAction.stopFading();
  playerRunAction.stopFading();
  playerJumpAction.enabled = true;
  playerJumpAction.paused = false;
  playerJumpAction.reset();
  playerJumpAction.setLoop(THREE.LoopOnce, 1);
  playerJumpAction.clampWhenFinished = true;
  /**
   * `crossFadeTo` uses fadeIn: effectiveWeight = `this.weight` × fade interpolant (0→1).
   * If `weight` is 0, jump never influences the skeleton (looks like a frozen pose).
   */
  playerJumpAction.setEffectiveWeight(1);
  playerJumpAction.play();

  if (playerRunAction.isRunning() && playerRunAction.getEffectiveWeight() > 0.01) {
    playerRunAction.enabled = true;
    playerRunAction.paused = false;
    playerRunAction.crossFadeTo(playerJumpAction, fadeSec, false);
  } else {
    playerJumpAction.stopFading();
    playerJumpAction.setEffectiveWeight(1);
    playerRunAction.stop();
    playerRunAction.setEffectiveWeight(0);
    playerRunAction.paused = true;
    playerRunAction.enabled = false;
  }

  const handler = (e) => {
    if (e.action !== playerJumpAction || !playerRunAction) return;
    resumeRunAfterJumpAnim();
  };
  playerMixer.addEventListener('finished', handler);
  playerMixer.userData._jumpFinishedHandler = handler;
  const dur = Math.max(playerJumpAction.getClip()?.duration ?? 0.85, 0.12);
  jumpAnimWatchdog = window.setTimeout(() => {
    jumpAnimWatchdog = null;
    if (playerJumpAnimOverride) resumeRunAfterJumpAnim();
  }, (dur + 0.45 + fadeSec) * 1000);
}

/**
 * IBL so MeshStandard / glTF baseColor textures read clearly (not flat black).
 */
function setupImageBasedLighting() {
  if (!renderer || !scene) return;
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const envScene = new RoomEnvironment();
  scene.environment = pmrem.fromScene(envScene, 0.04).texture;
  pmrem.dispose();
}

/** glTF clones: enforce sRGB maps + IBL response; disable fog on character so tints stay visible. */
function enhancePlayerGltfMaterials(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      if (m.map) {
        m.map.colorSpace = THREE.SRGBColorSpace;
        m.map.needsUpdate = true;
      }
      if (m.emissiveMap) {
        m.emissiveMap.colorSpace = THREE.SRGBColorSpace;
        m.emissiveMap.needsUpdate = true;
      }
      if (m.isMeshStandardMaterial || m.isMeshPhysicalMaterial) {
        m.envMapIntensity = 1.35;
        m.fog = false;
        if (m.map) {
          if (m.metalness >= 0.95) m.metalness = 0.08;
          if (m.roughness <= 0.05) m.roughness = 0.65;
        }
        m.needsUpdate = true;
      }
    }
  });
}

/** Coins: same as player IBL fix, but brighter so thin GLBs read from the runner cam. */
function enhanceCoinGltfMaterials(root) {
  enhancePlayerGltfMaterials(root);
  root.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      if (m.isMeshStandardMaterial || m.isMeshPhysicalMaterial) {
        m.envMapIntensity = Math.max(m.envMapIntensity ?? 1.2, 1.65);
        m.emissiveIntensity = Math.max(m.emissiveIntensity ?? 0, 0.22);
        if (!m.emissive || m.emissive.getHex() === 0) {
          m.emissive = new THREE.Color(0xffe8a8);
          m.emissiveIntensity = Math.max(m.emissiveIntensity, 0.28);
        }
        m.needsUpdate = true;
      }
    }
  });
}

function disposeObjectSubtree(obj) {
  obj.traverse((o) => {
    if (o.isMesh) {
      o.geometry?.dispose();
      const mat = o.material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose?.());
      else mat?.dispose?.();
    }
  });
}

async function loadCoinPrefab() {
  coinPrefab = null;
  coinPrefabIsSkinned = false;
  const loader = new GLTFLoader();
  for (const rel of COIN_GLTF_CANDIDATES) {
    try {
      const gltf = await loader.loadAsync(publicAsset(rel));
      const root = gltf.scene;
      root.name = 'coinPrefabRoot';
      root.updateMatrixWorld(true);
      coinPrefabIsSkinned = false;
      root.traverse((o) => {
        if (o.isSkinnedMesh) coinPrefabIsSkinned = true;
      });
      const box = new THREE.Box3().setFromObject(root);
      const size = new THREE.Vector3();
      box.getSize(size);
      let maxDim = Math.max(size.x, size.y, size.z, 1e-3);
      if (maxDim < 0.04) maxDim = 0.35;
      const target = 0.58;
      root.scale.setScalar(target / maxDim);
      root.updateMatrixWorld(true);
      const box2 = new THREE.Box3().setFromObject(root);
      root.position.set(0, -box2.min.y, 0);
      root.updateMatrixWorld(true);
      enhanceCoinGltfMaterials(root);
      root.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = false;
          o.receiveShadow = false;
          o.frustumCulled = true;
        }
      });
      coinPrefab = root;
      console.info(`Coin model loaded (${rel}) skinned=${coinPrefabIsSkinned}`);
      return;
    } catch {
      /* try next path */
    }
  }
  console.warn('No coin GLB found; using hologram boxes.', COIN_GLTF_CANDIDATES);
}

function makeFallbackCoinVisual() {
  const core = new THREE.Color(0xffd24a);
  const edge = new THREE.Color(0x66fff0);
  const mat = makeHologramBoxMaterial(core, edge, 0.38, 1.12);
  const inner = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.35, 0.12), mat);
  inner.rotation.y = Math.PI / 4;
  const g = new THREE.Group();
  g.add(inner);
  g.userData.isFallbackCoin = true;
  return g;
}

/** Clone GLB coin or build fallback; returns a Group at origin (feet on y=0 for GLB). */
function cloneCoinVisual() {
  if (coinPrefab) {
    const g = coinPrefabIsSkinned ? cloneSkinnedModel(coinPrefab) : coinPrefab.clone(true);
    enhanceCoinGltfMaterials(g);
    g.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = false;
        o.receiveShadow = false;
      }
    });
    g.userData.isCoinGltf = true;
    g.renderOrder = 8;
    return g;
  }
  return makeFallbackCoinVisual();
}

/** Roof “mega” coins: obvious purple so they read on top of tunnels. */
function applyPurpleTunnelCoinTint(root) {
  const core = new THREE.Color().setHSL(0.76, 0.78, 0.5);
  const edge = new THREE.Color().setHSL(0.8, 1, 0.68);
  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      if (m.uniforms?.uCoreColor && m.uniforms?.uEdgeColor) {
        m.uniforms.uCoreColor.value.copy(core);
        m.uniforms.uEdgeColor.value.copy(edge);
        m.needsUpdate = true;
      } else if (m.color) {
        m.color.copy(core);
        if (m.emissive) {
          m.emissive.copy(edge);
          m.emissiveIntensity = Math.max(m.emissiveIntensity || 0, 0.52);
        }
        m.needsUpdate = true;
      }
    }
  });
}

function clearPlayerVisuals() {
  removePlayerJumpFinishedListener();
  removePlayerStartIntroListener();
  restoreRunFacingAfterIntro();
  introCameraActive = false;
  introCameraElapsed = 0;
  playerJumpAction = null;
  playerJumpAnimOverride = false;
  playerStartAction = null;
  runGameplayActive = true;
  bgmIntroFadeActive = false;
  if (bgmAudio) bgmAudio.volume = BGM_VOLUME;
  if (playerMixer) {
    playerMixer.stopAllAction();
    playerMixer = null;
  }
  playerRunAction = null;
  if (!playerGroup) return;
  while (playerGroup.children.length) {
    const ch = playerGroup.children[0];
    playerGroup.remove(ch);
    disposeObjectSubtree(ch);
  }
  playerGroup.userData.legs = null;
  playerGroup.userData.visualRoot = null;
  playerGroup.userData.gltfStaticPose = false;
  playerGroup.userData.blockTorso = null;
  playerGroup.userData.blockHead = null;
}

/**
 * Swap block man for GLB; scale to ~1.6m tall, feet on y=0, play run clip if present.
 */
async function loadAndApplyPlayerCharacter() {
  if (!playerGroup || !scene) return;
  const loader = new GLTFLoader();
  let gltf = null;
  let loadedPath = null;
  for (const rel of PLAYER_GLTF_CANDIDATES) {
    const url = publicAsset(rel);
    try {
      gltf = await loader.loadAsync(url);
      loadedPath = rel;
      break;
    } catch {
      /* try next candidate */
    }
  }
  if (!gltf) {
    console.warn('No player GLB found in', PLAYER_GLTF_CANDIDATES);
    if (playerGroup.children.length === 0) {
      const fb = makeBlockPlayer();
      while (fb.children.length) playerGroup.add(fb.children[0]);
      playerGroup.userData.legs = fb.userData.legs;
    }
    return;
  }

  try {
    clearPlayerVisuals();

    let hasSkinned = false;
    gltf.scene.traverse((o) => {
      if (o.isSkinnedMesh) hasSkinned = true;
    });
    const model = hasSkinned ? cloneSkinnedModel(gltf.scene) : gltf.scene.clone(true);
    model.name = 'playerGltfVisual';
    /**
     * Run is +Z; camera sits at −Z. 3π/2 yaw faces the character down the track (away from camera).
     * (If your export differs, use PLAYER_MODEL_Y_ROTATION.)
     */
    const autoYaw = (3 * Math.PI) / 2;
    model.rotation.y = autoYaw + PLAYER_MODEL_Y_ROTATION;
    model.updateMatrixWorld(true);

    const box = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3();
    box.getSize(size);
    const targetH = 1.58;
    const s = targetH / Math.max(size.y, 1e-3);
    model.scale.setScalar(s);
    model.updateMatrixWorld(true);

    const box2 = new THREE.Box3().setFromObject(model);
    model.position.set(0, -box2.min.y, 0);
    model.userData.groundAlignY = model.position.y;

    playerGroup.add(model);
    playerGroup.userData.visualRoot = model;
    playerGroup.castShadow = !mobilePerf;
    model.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = !mobilePerf;
        o.receiveShadow = !mobilePerf;
      }
    });
    enhancePlayerGltfMaterials(model);

    const skinnedForAnim = getFirstSkinnedMesh(model);
    if (skinnedForAnim && !String(skinnedForAnim.name || '').trim()) {
      skinnedForAnim.name = 'PlayerSkinned';
    }

    const nlaPack =
      resolveBlenderNlaStyleClips(gltf.animations) ?? resolveThreeClipDurationPack(gltf.animations);
    const clip = nlaPack?.run ?? pickRunAnimationClip(gltf.animations);
    if (clip) {
      jumpAnimSetupGeneration += 1;
      const jumpSetupGen = jumpAnimSetupGeneration;
      introSetupGeneration += 1;
      playerMixer = new THREE.AnimationMixer(model);
      /** AnimationMixer is not an Object3D — it has no `userData` until we add it (clip refs, event handler ids). */
      playerMixer.userData = {};
      playerRunAction = playerMixer.clipAction(clip);
      playerRunAction.reset();
      playerRunAction.setLoop(THREE.LoopRepeat, Infinity);
      playerRunAction.clampWhenFinished = false;
      playerRunAction.paused = true;
      playerRunAction.setEffectiveWeight(0);
      playerGroup.userData.gltfStaticPose = false;
      if (nlaPack) {
        console.info(
          `Player loaded (${loadedPath}) — NLA mapping: run="${clip.name}" (${clip.duration?.toFixed?.(2) ?? '?'}s)`,
        );
      } else {
        console.info(`Player loaded (${loadedPath}) with animation: "${clip.name}"`);
      }
      /** Run + jump only (no intro/stretch). Jump clip must be ready before gameplay `tick` runs. */
      let jumpClipFinal = null;
      if (nlaPack?.jump && isUsableAnimClip(nlaPack.jump) && nlaPack.jump !== clip) {
        jumpClipFinal = nlaPack.jump;
      }
      if (!jumpClipFinal) {
        let jumpFromPlayer = pickJumpAnimationClip(gltf.animations, clip);
        if (!jumpFromPlayer) {
          jumpFromPlayer = pickFallthroughJumpClip(gltf.animations, clip, null);
        }
        if (isUsableAnimClip(jumpFromPlayer)) jumpClipFinal = jumpFromPlayer;
      }
      /** Only use `jump.glb` when we have no jump from the character file (retarget can be wrong and block motion). */
      if (!jumpClipFinal) {
        try {
          const extJump = await tryLoadExternalJumpClip(model);
          if (
            extJump &&
            isUsableAnimClip(extJump) &&
            jumpSetupGen === jumpAnimSetupGeneration &&
            playerMixer &&
            playerMixer.getRoot() === model
          ) {
            jumpClipFinal = extJump;
          }
        } catch {
          /* optional jump.glb */
        }
      }

      model.userData.playerRunClipRef = clip;
      model.userData.playerJumpClipRef = jumpClipFinal || null;
      playerMixer.userData.playerRunClipRef = clip;
      playerMixer.userData.playerJumpClipRef = jumpClipFinal || null;
      if (jumpClipFinal) setupPlayerJumpAction(jumpClipFinal);

      startRunAnimationImmediately();

      const clipNames = gltf.animations.map((a) => a.name).join(', ');
      console.info(
        `[SubwayBlocks] clips: ${clipNames || '(none)'} | run: "${clip.name}" | jump: ${jumpClipFinal ? `"${jumpClipFinal.name}"` : '—'}`,
      );
    } else {
      playerGroup.userData.gltfStaticPose = true;
      console.info(
        `Player mesh loaded (${loadedPath}) but this GLB has **no animation clips** (Tripo/static export). ` +
          'Add a rigged GLB with a run clip in `public/sounds/char/` or `public/sounds/char/char_ani/` — see PLAYER_GLTF_CANDIDATES order.',
      );
    }
  } catch (err) {
    console.warn('Player GLB failed after load, using block character:', err);
    if (playerGroup.children.length === 0) {
      const fb = makeBlockPlayer();
      while (fb.children.length) playerGroup.add(fb.children[0]);
      playerGroup.userData.legs = fb.userData.legs;
      playerGroup.userData.blockTorso = fb.userData.blockTorso;
      playerGroup.userData.blockHead = fb.userData.blockHead;
    }
  }
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
  g.userData.blockTorso = torso;
  g.userData.blockHead = head;
  return g;
}

function makeGroundStripe(z0, length) {
  ensureRunwayMaterials();
  const g = new THREE.Group();
  g.userData.zStart = z0;
  g.userData.zEnd = z0 + length;

  const slab = new THREE.Mesh(
    new THREE.BoxGeometry(LANE_WIDTH * 3.6, 0.35, length),
    runwaySlabMat,
  );
  slab.position.set(0, -0.2, z0 + length / 2);
  g.add(slab);

  const rcv = !mobilePerf;
  g.traverse((o) => {
    if (o.isMesh) o.receiveShadow = rcv;
  });

  return g;
}

/** Chance each chunk is a long enclosed tunnel (walls + ceiling); rest stay open runway. */
const TUNNEL_CHUNK_CHANCE = 0.29;
const TUNNEL_LENGTH_MIN = 48;
const TUNNEL_LENGTH_RANGE = 58;

/** Matches `makeTunnelStripe` mesh layout (used for roof / ceiling physics). */
function tunnelGeomConsts() {
  const wallT = mobilePerf ? 0.11 : 0.15;
  const wallH = mobilePerf ? 4.45 : 5.45;
  const ceilT = mobilePerf ? 0.12 : 0.17;
  const innerHalf = LANE_WIDTH * 1.8;
  const yWall = wallH * 0.5 - 0.28;
  const ceilCenterY = wallH - 0.15 + ceilT * 0.5;
  const ceilBottomY = ceilCenterY - ceilT * 0.5;
  const roofTopY = ceilCenterY + ceilT * 0.5;
  return { wallT, wallH, ceilT, innerHalf, yWall, ceilCenterY, ceilBottomY, roofTopY };
}

function getTunnelStripeAtZ(pz) {
  if (!worldGroup) return null;
  for (let i = 0; i < worldGroup.children.length; i++) {
    const ch = worldGroup.children[i];
    if (!ch.userData?.isTunnel) continue;
    const z0 = ch.userData.zStart;
    const z1 = ch.userData.zEnd;
    if (pz >= z0 && pz <= z1) return ch;
  }
  return null;
}

/**
 * Tunnel roof contact for gameplay (duck, jump). Looser `vyMax` for jump so brief
 * gravity ticks do not block jump; duck keeps a tight vy so we stay "standing".
 */
function isPlayerOnTunnelRoof(opts = {}) {
  const vyMax = opts.vyMax ?? 0.12;
  if (!getTunnelStripeAtZ(distance)) return false;
  const { roofTopY } = tunnelGeomConsts();
  return (
    playerY >= roofTopY - 0.12 &&
    playerY <= roofTopY + 0.4 &&
    playerVy <= vyMax
  );
}

/** Jump on tunnel roof: looser vertical velocity than duck, so small gravity/snap ticks still allow a hop. */
function canPlayerJumpFromTunnelRoof() {
  if (!getTunnelStripeAtZ(distance)) return false;
  const { roofTopY } = tunnelGeomConsts();
  return (
    playerY >= roofTopY - 0.16 &&
    playerY <= roofTopY + 0.52 &&
    playerVy <= 0.55
  );
}

function zRangeOverlapsAnyTunnel(zMin, zMax) {
  if (!worldGroup) return false;
  for (let i = 0; i < worldGroup.children.length; i++) {
    const ch = worldGroup.children[i];
    if (!ch.userData?.isTunnel) continue;
    const ts = ch.userData.zStart;
    const te = ch.userData.zEnd;
    if (zMax >= ts && zMin <= te) return true;
  }
  return false;
}

/** Nudge Z forward until jump pad fits outside tunnel segments (real boost only). */
function findBoostZOutsideTunnel(preferredZ) {
  const halfD = BOOST_PAD_DEPTH * 0.5;
  let z = preferredZ;
  for (let t = 0; t < 16; t++) {
    if (!zRangeOverlapsAnyTunnel(z - halfD, z + halfD)) return { z, ok: true };
    z += 4.5 + rng() * 8.5;
  }
  return { z: preferredZ, ok: false };
}

function makeTunnelStripe(z0, length) {
  ensureRunwayMaterials();
  const g = new THREE.Group();
  g.userData.zStart = z0;
  g.userData.zEnd = z0 + length;
  g.userData.isTunnel = true;

  const slab = new THREE.Mesh(
    new THREE.BoxGeometry(LANE_WIDTH * 3.6, 0.35, length),
    runwaySlabMat,
  );
  slab.position.set(0, -0.2, z0 + length / 2);
  g.add(slab);

  const d = tunnelGeomConsts();
  const zc = z0 + length * 0.5;

  const Lc = 0.065 + rng() * 0.045;
  const Le = 0.26 + rng() * 0.09;
  const core = new THREE.Color().setHSL(0.59, 0.045, Lc);
  const edge = new THREE.Color().setHSL(0.5, 0.11, Le);
  const matL = makeHologramBoxMaterial(core, edge, 0.3, 0.9, rng() * Math.PI * 2);
  const matR = makeHologramBoxMaterial(
    core.clone().multiplyScalar(0.94),
    edge.clone(),
    0.3,
    0.86,
    rng() * Math.PI * 2,
  );
  const matC = makeHologramBoxMaterial(
    core.clone().multiplyScalar(0.9),
    edge,
    0.24,
    0.92,
    rng() * Math.PI * 2,
  );

  const left = new THREE.Mesh(new THREE.BoxGeometry(d.wallT, d.wallH, length), matL);
  left.position.set(-(d.innerHalf + d.wallT * 0.5), d.yWall, zc);
  left.castShadow = false;
  left.receiveShadow = false;
  g.add(left);

  const right = new THREE.Mesh(new THREE.BoxGeometry(d.wallT, d.wallH, length), matR);
  right.position.set(d.innerHalf + d.wallT * 0.5, d.yWall, zc);
  right.castShadow = false;
  right.receiveShadow = false;
  g.add(right);

  const ceilW = d.innerHalf * 2 + d.wallT * 2 + 0.08;
  const ceil = new THREE.Mesh(new THREE.BoxGeometry(ceilW, d.ceilT, length), matC);
  ceil.position.set(0, d.ceilCenterY, zc);
  ceil.castShadow = false;
  ceil.receiveShadow = false;
  g.add(ceil);

  slab.receiveShadow = !mobilePerf;

  return g;
}

const HOLO_BOX_VS = `
  varying vec3 vNormal;
  varying vec3 vViewDir;
  varying vec3 vWorldPos;
  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
    vViewDir = -mvPos.xyz;
    gl_Position = projectionMatrix * mvPos;
  }
`;

const HOLO_BOX_FS = `
  uniform vec3 uCoreColor;
  uniform vec3 uEdgeColor;
  uniform float uAlpha;
  uniform float uTime;
  uniform float uHalo;
  uniform float uPhase;
  varying vec3 vNormal;
  varying vec3 vViewDir;
  varying vec3 vWorldPos;
  void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(vViewDir);
    float ndv = abs(dot(N, V));
    float fresnel = pow(1.0 - ndv, 3.1);

    float tP = uTime + uPhase;
    float scanV = sin(vWorldPos.y * 15.0 - tP * 5.2) * 0.5 + 0.5;
    float scanH = sin(dot(vWorldPos.xz, vec2(6.5, 4.8)) + tP * 3.8) * 0.5 + 0.5;
    float scan = scanV * 0.52 + scanH * 0.48;

    float layerX = sin(vWorldPos.x * 3.1 + tP * 2.9) * sin(vWorldPos.z * 2.5 - tP * 2.15);
    float layerY = sin(vWorldPos.y * 4.2 - tP * 3.4);
    float phased = clamp(layerX * 0.55 + layerY * 0.4, -1.0, 1.0);
    float planeSweep = sin(dot(vWorldPos, vec3(1.8, 1.1, 1.6)) + tP * 4.5) * 0.5 + 0.5;
    float holoBeat = 0.82 + 0.18 * sin(tP * 2.7 + vWorldPos.z * 0.08);

    float haloPulse = 0.76 + 0.24 * sin(tP * 3.1 + vWorldPos.z * 0.12);
    vec3 rim = uEdgeColor * fresnel * (1.05 + 0.45 * haloPulse) * uHalo;
    rim *= 1.0 + phased * 0.2 + (planeSweep - 0.5) * 0.14;
    rim *= holoBeat;
    vec3 core = uCoreColor * (0.32 + scan * 0.48 + fresnel * 0.22);
    core += uEdgeColor * (0.05 + abs(phased) * 0.12) * fresnel;
    core += uCoreColor * planeSweep * 0.06;
    vec3 col = core + rim;

    float flick = 0.9 + 0.1 * sin(tP * 10.5 + vWorldPos.x * 3.5);
    col *= flick;

    float alpha = uAlpha + fresnel * 0.52 * uHalo;
    alpha += abs(phased) * 0.06 + planeSweep * 0.05;
    alpha = clamp(alpha, 0.14, 0.92);
    gl_FragColor = vec4(col, alpha);
  }
`;

function makeHologramBoxMaterial(coreColor, edgeColor, alpha = 0.32, halo = 1, phase = 0) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uCoreColor: { value: coreColor.clone() },
      uEdgeColor: { value: edgeColor.clone() },
      uAlpha: { value: alpha },
      uHalo: { value: halo },
      uPhase: { value: phase },
    },
    vertexShader: HOLO_BOX_VS,
    fragmentShader: HOLO_BOX_FS,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

const BOOST_VS = `
  varying vec3 vLocalPos;
  varying vec3 vNormal;
  varying vec3 vViewDir;
  void main() {
    vLocalPos = position;
    vNormal = normalize(normalMatrix * normal);
    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
    vViewDir = -mvPos.xyz;
    gl_Position = projectionMatrix * mvPos;
  }
`;

const BOOST_FS = `
  uniform float uTime;
  uniform float uUsed;
  uniform float uDecoy;
  uniform vec3 uColor;
  uniform vec3 uGlow;
  varying vec3 vLocalPos;
  varying vec3 vNormal;
  varying vec3 vViewDir;
  void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(vViewDir);
    float fresnel = pow(1.0 - abs(dot(N, V)), 2.6);

    float z = vLocalPos.z;
    float x = vLocalPos.x;
    float scroll = z * 2.35 - uTime * 6.2;
    float t = fract(scroll * 0.5);
    float tri = abs(t - 0.5) * 2.0;
    float wing = smoothstep(tri - 0.04, tri + 0.14, abs(x) * 1.65);
    float chev1 = (1.0 - wing) * (0.35 + 0.65 * tri);

    float scroll2 = z * 2.35 - uTime * 6.2 + 0.5;
    float t2 = fract(scroll2 * 0.5);
    float tri2 = abs(t2 - 0.5) * 2.0;
    float wing2 = smoothstep(tri2 - 0.04, tri2 + 0.14, abs(x) * 1.65);
    float chev2 = (1.0 - wing2) * (0.35 + 0.65 * tri2);

    float arrows = clamp(chev1 + chev2 * 0.85, 0.0, 1.0);
    arrows *= mix(1.0, 0.25, uDecoy);
    float pulse = 0.9 + 0.1 * sin(uTime * 5.2);

    vec3 col = mix(uColor, uGlow, fresnel * 0.62 + arrows * 0.48 * pulse);
    col += uGlow * arrows * 0.38 * pulse;
    col += uGlow * 0.08 * fresnel;
    float dim = mix(1.0, 0.42, uUsed);
    col *= dim;
    col *= mix(1.0, 0.52, uDecoy);
    float alpha = (0.48 + fresnel * 0.38 + arrows * 0.32) * dim * pulse;
    alpha *= mix(1.0, 0.58, uDecoy);
    gl_FragColor = vec4(col, clamp(alpha, 0.28, 0.92));
  }
`;

function makeBoostHologramMaterial(isDecoy = false) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uUsed: { value: 0 },
      uDecoy: { value: isDecoy ? 1 : 0 },
      uColor: { value: new THREE.Color(0x061c32) },
      uGlow: { value: new THREE.Color(0x38d6ff) },
    },
    vertexShader: BOOST_VS,
    fragmentShader: BOOST_FS,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

const POWER_FS = `
  uniform float uTime;
  uniform float uUsed;
  uniform vec3 uColorDeep;
  uniform vec3 uColorPink;
  varying vec3 vLocalPos;
  varying vec3 vNormal;
  varying vec3 vViewDir;
  void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(vViewDir);
    float fresnel = pow(1.0 - abs(dot(N, V)), 2.35);

    float gx = vLocalPos.x * 0.42 + vLocalPos.z * 0.36;
    float flow = sin(gx * 2.85 - uTime * 5.2) * 0.5 + 0.5;
    float gz = sin(vLocalPos.z * 1.15 + uTime * 2.1) * 0.22;
    float grad = clamp(flow * 0.72 + gz + fresnel * 0.38, 0.0, 1.0);
    vec3 base = mix(uColorDeep, uColorPink, grad);

    float pulse = 0.9 + 0.1 * sin(uTime * 6.4);
    vec3 col = base * (0.58 + fresnel * 0.42) * pulse;
    col += uColorPink * (0.12 + fresnel * 0.42) * pulse;
    float dim = mix(1.0, 0.4, uUsed);
    col *= dim;
    float alpha = (0.5 + fresnel * 0.36 + grad * 0.22) * dim * pulse;
    gl_FragColor = vec4(col, clamp(alpha, 0.3, 0.9));
  }
`;

function makePowerPadMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uUsed: { value: 0 },
      uColorDeep: { value: new THREE.Color(0x9a0028) },
      uColorPink: { value: new THREE.Color(0xff8ec8) },
    },
    vertexShader: BOOST_VS,
    fragmentShader: POWER_FS,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

/** Curved launch strip: low at rear (-Z), rises toward +Z (direction of run). */
function makeCurvedJumpPadGeometry(w, d, sx = 10, sz = 16) {
  const geo = new THREE.BufferGeometry();
  const verts = [];
  const indices = [];
  const maxLift = BOOST_PAD_MAX_LIFT;
  const row = sx + 1;
  for (let j = 0; j <= sz; j++) {
    const fz = j / sz;
    const z = (fz - 0.5) * d;
    const t = (z + d * 0.5) / d;
    const y = maxLift * t * t;
    for (let i = 0; i <= sx; i++) {
      const fx = i / sx;
      const x = (fx - 0.5) * w;
      verts.push(x, y, z);
    }
  }
  for (let j = 0; j < sz; j++) {
    for (let i = 0; i < sx; i++) {
      const a = j * row + i;
      const b = j * row + i + 1;
      const c = (j + 1) * row + i;
      const e = (j + 1) * row + i + 1;
      indices.push(a, c, b, b, c, e);
    }
  }
  geo.setIndex(indices);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.computeVertexNormals();
  return geo;
}

function setPadUsedUniform(root, used) {
  root.traverse((obj) => {
    const m = obj.material;
    if (!m?.uniforms?.uUsed) return;
    m.uniforms.uUsed.value = used;
  });
}

function syncHologramTimeUniforms(t) {
  if (!scene) return;
  scene.traverse((obj) => {
    const m = obj.material;
    if (!m) return;
    const list = Array.isArray(m) ? m : [m];
    for (const mat of list) {
      if (!mat?.uniforms?.uTime) continue;
      if (
        mat === runwaySlabMat ||
        mat === musicGridFloorMaterial ||
        mat === musicGridCeilingMaterial
      ) {
        continue;
      }
      mat.uniforms.uTime.value = t;
    }
  });
}

function spawnChunk(endZ) {
  const z0 = endZ;
  if (rng() < TUNNEL_CHUNK_CHANCE) {
    const tLen = TUNNEL_LENGTH_MIN + rng() * TUNNEL_LENGTH_RANGE;
    worldGroup.add(makeTunnelStripe(z0, tLen));
    return z0 + tLen;
  }
  const len = 24 + rng() * 16;
  worldGroup.add(makeGroundStripe(z0, len));
  return z0 + len;
}

function minObstacleZSeparation(travelSpeed) {
  return THREE.MathUtils.clamp(11 + travelSpeed * 0.52, 15, 34);
}

function spawnObstacle(z, travelSpeed) {
  const minSep = minObstacleZSeparation(travelSpeed);
  const minZ = lastObstacleCenterZ + minSep;
  if (z < minZ) z = minZ;

  let lane = LANES[Math.floor(rng() * 3)];
  const roll = rng();
  let mesh;
  let kind;
  let extra = {};

  if (roll < 0.36) {
    kind = 'train';
    const Lc = 0.09 + rng() * 0.05;
    const Le = 0.34 + rng() * 0.1;
    const core = new THREE.Color().setHSL(0.6, 0.03, Lc);
    const edge = new THREE.Color().setHSL(0.58, 0.06, Le);
    const mat = makeHologramBoxMaterial(core, edge, 0.34, 0.92, rng() * Math.PI * 2);
    mesh = new THREE.Mesh(new THREE.BoxGeometry(LANE_WIDTH * 0.85, 1.35, 3.2), mat);
    mesh.position.set(laneX(lane), 0.75, z);
  } else if (roll < 0.62) {
    kind = 'gap';
    const px = playerGroup ? playerGroup.position.x : 0;
    const refLane = THREE.MathUtils.clamp(Math.round(px / LANE_WIDTH), -1, 1);
    const laneOpts = [refLane];
    if (refLane > -1) laneOpts.push(refLane - 1);
    if (refLane < 1) laneOpts.push(refLane + 1);
    const openLane = laneOpts[Math.floor(rng() * laneOpts.length)];
    lane = openLane;
    const g0 = laneX(openLane) - LANE_WIDTH * 0.5;
    const g1 = laneX(openLane) + LANE_WIDTH * 0.5;
    const Lc = 0.1 + rng() * 0.04;
    const Le = 0.36 + rng() * 0.09;
    const core = new THREE.Color().setHSL(0.58, 0.05, Lc);
    const edge = new THREE.Color().setHSL(0.52, 0.1, Le);
    const mat = makeHologramBoxMaterial(core, edge, 0.35, 0.94, rng() * Math.PI * 2);
    mesh = new THREE.Group();
    mesh.position.set(0, 0, z);
    const h = 1.35;
    const bwMul = 0.9;
    if (g0 > TRACK_X_MIN + 0.04) {
      const w = g0 - TRACK_X_MIN;
      const cx = (TRACK_X_MIN + g0) * 0.5;
      const blk = new THREE.Mesh(new THREE.BoxGeometry(w * bwMul, h, GAP_WALL_DEPTH), mat);
      blk.position.set(cx, GAP_WALL_Y, 0);
      blk.castShadow = false;
      mesh.add(blk);
    }
    if (TRACK_X_MAX > g1 + 0.04) {
      const w = TRACK_X_MAX - g1;
      const cx = (g1 + TRACK_X_MAX) * 0.5;
      const blk = new THREE.Mesh(new THREE.BoxGeometry(w * bwMul, h, GAP_WALL_DEPTH), mat);
      blk.position.set(cx, GAP_WALL_Y, 0);
      blk.castShadow = false;
      mesh.add(blk);
    }
    extra = {
      openLane,
      gapMin: g0,
      gapMax: g1,
      trackMin: TRACK_X_MIN,
      trackMax: TRACK_X_MAX,
    };
  } else {
    kind = 'low';
    const Lc = 0.11 + rng() * 0.04;
    const Le = 0.36 + rng() * 0.08;
    const core = new THREE.Color().setHSL(0.62, 0.025, Lc);
    const edge = new THREE.Color().setHSL(0.58, 0.05, Le);
    const mat = makeHologramBoxMaterial(core, edge, 0.36, 0.9, rng() * Math.PI * 2);
    mesh = new THREE.Mesh(new THREE.BoxGeometry(LANE_WIDTH * 0.75, 0.45, 0.55), mat);
    mesh.position.set(laneX(lane), 0.22, z);
  }

  mesh.castShadow = false;
  scene.add(mesh);
  lastObstacleCenterZ = z;
  obstacles.push({ mesh, z, lane, kind, ...extra });
}

function spawnCoinRow(z) {
  const lane = LANES[Math.floor(rng() * 3)];
  const n = 3 + Math.floor(rng() * 4);
  for (let i = 0; i < n; i++) {
    const visual = cloneCoinVisual();
    const zz = z + i * 1.1;
    visual.position.set(laneX(lane), 0.55, zz);
    if (visual.userData.isCoinGltf) {
      visual.rotation.y = rng() * Math.PI * 2;
      visual.rotation.x = 0.52;
      visual.rotation.z = rng() * 0.28 - 0.14;
    } else if (!visual.userData.isFallbackCoin) {
      visual.rotation.y = rng() * Math.PI * 2;
    }
    scene.add(visual);
    coins.push({
      mesh: visual,
      z: zz,
      lane,
      collected: false,
      collecting: false,
      collectTime: 0,
      baseScale: visual.scale.x,
      pendingDispose: false,
      coinValue: 1,
    });
  }
  const rowEnd = z + (n - 1) * 1.1;
  if (zRangeOverlapsAnyTunnel(z - 1, rowEnd + 1)) spawnMegaRoofCoinsAlongRow(z, n, lane);
}

/**
 * Larger purple coins on tunnel roof along a ground row’s Z span; denser spacing + lane weave
 * so more actually appear inside the tunnel stripe (per-zz tunnel check).
 */
function spawnMegaRoofCoinsAlongRow(z, n, lane) {
  const { roofTopY } = tunnelGeomConsts();
  const y = roofTopY + 0.55;
  const rowEnd = z + (n - 1) * 1.1;
  const laneBase = LANES.indexOf(lane);
  let idx = 0;
  for (let zz = z; zz <= rowEnd + 0.02; zz += 0.72) {
    if (!getTunnelStripeAtZ(zz)) continue;
    const li = ((laneBase >= 0 ? laneBase : 1) + idx) % 3;
    const useLane = LANES[li];
    idx += 1;
    const visual = cloneCoinVisual();
    applyPurpleTunnelCoinTint(visual);
    visual.position.set(laneX(useLane), y, zz);
    visual.scale.multiplyScalar(1.48);
    if (visual.userData.isCoinGltf) {
      visual.rotation.y = rng() * Math.PI * 2;
      visual.rotation.x = 0.52;
      visual.rotation.z = rng() * 0.28 - 0.14;
    } else if (!visual.userData.isFallbackCoin) {
      visual.rotation.y = rng() * Math.PI * 2;
    }
    scene.add(visual);
    coins.push({
      mesh: visual,
      z: zz,
      lane: useLane,
      collected: false,
      collecting: false,
      collectTime: 0,
      baseScale: visual.scale.x,
      pendingDispose: false,
      mega: true,
      tunnelPurple: true,
      coinValue: 2,
    });
  }
}

/** Long purple coin trail on tunnel ceiling (only spawns at Z where a tunnel exists). */
function spawnPurpleTunnelRoofTrail(z0, lengthZ) {
  const { roofTopY } = tunnelGeomConsts();
  const y = roofTopY + 0.55;
  const step = 0.86;
  let laneRot = Math.floor(rng() * 3);
  for (let t = 0; t < lengthZ; t += step) {
    const zz = z0 + t;
    if (!getTunnelStripeAtZ(zz)) continue;
    const useLane = LANES[laneRot % 3];
    laneRot += 1 + Math.floor(rng() * 2);
    const visual = cloneCoinVisual();
    applyPurpleTunnelCoinTint(visual);
    visual.position.set(laneX(useLane), y, zz);
    visual.scale.multiplyScalar(1.42);
    if (visual.userData.isCoinGltf) {
      visual.rotation.y = rng() * Math.PI * 2;
      visual.rotation.x = 0.52;
      visual.rotation.z = rng() * 0.28 - 0.14;
    } else if (!visual.userData.isFallbackCoin) {
      visual.rotation.y = rng() * Math.PI * 2;
    }
    scene.add(visual);
    coins.push({
      mesh: visual,
      z: zz,
      lane: useLane,
      collected: false,
      collecting: false,
      collectTime: 0,
      baseScale: visual.scale.x,
      pendingDispose: false,
      mega: true,
      tunnelPurple: true,
      coinValue: 2,
    });
  }
}

function spawnBoostPad(z, opts = {}) {
  const decoy = opts.decoy === true;
  const lane = LANES[Math.floor(rng() * 3)];
  const w = LANE_WIDTH * 0.88;
  const d = BOOST_PAD_DEPTH;
  const geo = makeCurvedJumpPadGeometry(w, d);
  const mesh = new THREE.Mesh(geo, makeBoostHologramMaterial(decoy));
  mesh.position.set(laneX(lane), 0.028, z);
  mesh.receiveShadow = false;
  mesh.castShadow = false;
  scene.add(mesh);
  boostPads.push({ mesh, z, lane, used: false, pulse: 0, decoy });
}

function spawnPowerPad(z) {
  const lane = LANES[Math.floor(rng() * 3)];
  const w = LANE_WIDTH * 0.86;
  const d = POWER_PAD_DEPTH;
  const h = 0.09;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), makePowerPadMaterial());
  mesh.position.set(laneX(lane), h / 2 + 0.02, z);
  mesh.receiveShadow = false;
  mesh.castShadow = false;
  scene.add(mesh);
  powerPads.push({ mesh, z, lane, used: false });
}

function getOrCreateBgmAudioContext() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!bgmAudioContext) bgmAudioContext = new AC();
  return bgmAudioContext;
}

/** Call synchronously on Play tap so Safari will allow audio graph + FFT later. */
function primeBgmAudioContext() {
  const ctx = getOrCreateBgmAudioContext();
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
}

/**
 * Route BGM through an analyser so the sky can pulse with bass/mids.
 * Falls back to procedural motion if this throws (strict browsers).
 */
function tryAttachBgmAnalyser() {
  if (!bgmAudio || bgmAnalyser) return;
  const ctx = getOrCreateBgmAudioContext();
  if (!ctx) return;
  try {
    const src = ctx.createMediaElementSource(bgmAudio);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = BGM_OPEN_LOWPASS_HZ;
    lp.Q.value = 0.85;
    const an = ctx.createAnalyser();
    an.fftSize = 256;
    an.smoothingTimeConstant = 0.88;
    src.connect(lp);
    lp.connect(an);
    an.connect(ctx.destination);
    bgmTunnelLowpass = lp;
    bgmTunnelMuffle = 0;
    bgmAnalyser = an;
    bgmFreqData = new Uint8Array(an.frequencyBinCount);
  } catch {
    bgmAnalyser = null;
    bgmFreqData = null;
    bgmTunnelLowpass = null;
  }
}

function updateBgmTunnelLowpassFilter(dt) {
  if (!bgmTunnelLowpass) return;
  const inTunnel =
    gameStarted &&
    alive &&
    runGameplayActive &&
    getTunnelStripeAtZ(distance);
  const target = inTunnel ? 1 : 0;
  const k = 1 - Math.exp(-Math.min(0.1, dt) * BGM_TUNNEL_MUFFLE_SMOOTH);
  bgmTunnelMuffle += (target - bgmTunnelMuffle) * k;
  bgmTunnelLowpass.frequency.value =
    BGM_OPEN_LOWPASS_HZ * (1 - bgmTunnelMuffle) + BGM_TUNNEL_MUFFLE_HZ * bgmTunnelMuffle;
}

function sampleBgmBands() {
  if (bgmAnalyser && bgmFreqData && bgmAudio && !bgmAudio.paused) {
    bgmAnalyser.getByteFrequencyData(bgmFreqData);
    const n = bgmFreqData.length;
    let bass = 0;
    const iBassEnd = Math.min(12, n);
    for (let i = 0; i < iBassEnd; i++) bass += bgmFreqData[i];
    bass /= iBassEnd * 255;
    let mid = 0;
    const iMidEnd = Math.min(56, n);
    for (let i = iBassEnd; i < iMidEnd; i++) mid += bgmFreqData[i];
    mid /= Math.max(1, (iMidEnd - iBassEnd) * 255);
    let high = 0;
    for (let i = iMidEnd; i < n; i++) high += bgmFreqData[i];
    high /= Math.max(1, (n - iMidEnd) * 255);
    return { bass, mid, high };
  }
  const t = musicPulseTime;
  const w = 0.5 + 0.5 * Math.sin(t * 1.1);
  const w2 = 0.5 + 0.5 * Math.sin(t * 1.45 + 1.1);
  return { bass: w * 0.1, mid: w2 * 0.09, high: (w * 0.5 + w2 * 0.5) * 0.08 };
}

function makeNeonGridShaderMaterial(ceiling) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPulse: { value: 0 },
      uMid: { value: 0 },
      uHigh: { value: 0 },
      uColorA: { value: new THREE.Color(0xff00aa) },
      uColorB: { value: new THREE.Color(0x00ffea) },
      uCeiling: { value: ceiling ? 1.0 : 0.0 },
    },
    transparent: true,
    depthWrite: false,
    fog: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    vertexShader: `
      varying vec3 vPos;
      void main() {
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vPos;
      uniform float uTime;
      uniform float uPulse;
      uniform float uMid;
      uniform float uHigh;
      uniform vec3 uColorA;
      uniform vec3 uColorB;
      uniform float uCeiling;
      float gridLine(vec2 p, float scale) {
        vec2 f = fract(p * scale);
        float ax = min(f.x, 1.0 - f.x);
        float ay = min(f.y, 1.0 - f.y);
        float lx = smoothstep(0.0, 0.045, ax);
        float ly = smoothstep(0.0, 0.045, ay);
        return 1.0 - min(lx, ly);
      }
      void main() {
        float scroll = uTime * (0.58 + uPulse * 0.32);
        vec2 p = vec2(vPos.x, vPos.z + scroll);
        float g1 = gridLine(p, 0.14 + uMid * 0.02);
        float g2 = gridLine(p + vec2(17.3, 9.1), 0.28) * 0.45;
        vec2 wob = vec2(sin(uTime * 0.35), cos(uTime * 0.28)) * 2.2;
        float g3 = gridLine(p * 1.55 + wob, 0.19 + uMid * 0.015) * 0.42;
        float lines = clamp(g1 + g2 + g3, 0.0, 1.0);
        float lane = abs(vPos.x) * 0.08;
        float lanePulse = 0.15 + 0.25 * exp(-lane * lane);
        vec3 col = mix(uColorA, uColorB, sin(vPos.z * 0.06 + uTime * 0.45) * 0.5 + 0.5);
        float beat = 0.58 + uPulse * 0.32 + uMid * 0.12;
        float depth = smoothstep(-20.0, 120.0, vPos.z);
        float saberWave = sin(vPos.z * 0.055 - uTime * (1.6 + uPulse * 2.4)) * 0.5 + 0.5;
        float wallPulse = pow(abs(sin(vPos.x * 0.09 + uMid * 4.0)), 10.0);
        float travelDot = sin(vPos.z * 0.095 - uTime * 2.35) * 0.5 + 0.5;
        float beatLift =
          uPulse * (0.07 * saberWave + 0.055 * wallPulse + 0.05 * travelDot) * (0.5 + depth * 0.5);
        float alpha = lines * beat * (0.4 + depth * 0.62) * lanePulse * (1.0 + beatLift);
        vec3 saberTint = mix(uColorA, uColorB, saberWave * 0.35 + uPulse * 0.2);
        col = mix(col, saberTint, lines * uPulse * 0.14 + wallPulse * uMid * 0.12);
        col += (uColorA + uColorB) * 0.055 * uHigh * lines * depth;
        if (uCeiling > 0.5) alpha *= 0.42;
        gl_FragColor = vec4(col * lines * beat, alpha);
      }
    `,
  });
}

function createMusicBackdrop() {
  musicBackdropGroup = new THREE.Group();
  musicBackdropGroup.name = 'musicBackdrop';

  const skySegs = mobilePerf ? 12 : 20;
  const skyRings = mobilePerf ? 8 : 14;
  const skyGeo = new THREE.SphereGeometry(145, skySegs, skyRings);
  musicSkyMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uMagenta: { value: new THREE.Color(0xff0a78) },
      uCyan: { value: new THREE.Color(0x00f5ff) },
      uVoid: { value: new THREE.Color(0x06051a) },
      uPulse: { value: 0 },
      uShimmer: { value: 0 },
      uMid: { value: 0 },
      uHigh: { value: 0 },
      uFlow: { value: 0 },
    },
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vDir;
      uniform vec3 uMagenta;
      uniform vec3 uCyan;
      uniform vec3 uVoid;
      uniform float uPulse;
      uniform float uShimmer;
      uniform float uMid;
      uniform float uHigh;
      uniform float uFlow;
      void main() {
        float h = vDir.y;
        float horizon = pow(1.0 - abs(h), 5.5);
        float nearBand = pow(max(0.0, 1.0 - abs(h + 0.06)), 3.8);
        float ring = sin(length(vec2(vDir.x, vDir.z)) * 9.0 - uShimmer * 0.35) * 0.5 + 0.5;
        vec3 neon = mix(uMagenta, uCyan, sin(uShimmer * 0.05 + vDir.x * 2.0) * 0.5 + 0.5);
        vec3 glow = neon * horizon * (0.48 + uPulse * 0.42 + uMid * 0.14);
        float scan = sin(vDir.x * 12.0 + uShimmer * 0.4) * sin(vDir.z * 10.0 + uShimmer * 0.25);
        glow += (uCyan + uMagenta) * 0.016 * scan * (0.28 + uPulse * 0.38) * (1.0 - abs(h));
        float saberVert = pow(abs(sin(vDir.x * 7.0 + uMid * 2.8)), 14.0);
        glow += mix(uCyan, uMagenta, 0.45) * saberVert * uMid * 0.13 * nearBand * horizon;
        float sweep = sin(vDir.z * 11.0 - uShimmer * 0.1) * 0.5 + 0.5;
        glow += neon * sweep * uPulse * 0.065 * nearBand;
        float arcBeat = pow(abs(sin(atan(vDir.z, vDir.x) * 5.0 + uPulse * 2.5)), 6.0);
        glow += (uCyan * 0.5 + uMagenta * 0.5) * arcBeat * uPulse * 0.052 * horizon;
        glow += (uCyan + uMagenta) * 0.032 * uHigh * nearBand * ring;
        float ribbon = pow(abs(sin(vDir.z * 17.0 + uFlow * 1.12 + uPulse * 2.0)), 5.0);
        glow += neon * ribbon * 0.082 * horizon * (0.22 + uPulse * 0.45);
        float driftW = sin(vDir.y * 5.5 + uFlow * 0.11) * sin(vDir.x * 13.5 - uFlow * 0.085);
        glow += (uCyan + uMagenta) * 0.024 * driftW * horizon * (0.22 + uMid * 0.38);
        float blob = sin(vDir.x * 9.0 + uFlow * 0.65) * sin(vDir.z * 8.0 - uFlow * 0.5);
        glow += mix(uCyan, uMagenta, 0.5) * blob * 0.045 * (1.0 - abs(h)) * (0.12 + uHigh * 0.55);
        float slowRing = sin(length(vec2(vDir.x, vDir.z)) * 14.0 - uFlow * 0.45) * 0.5 + 0.5;
        glow += neon * slowRing * 0.035 * uMid * (1.0 - abs(h));
        vec3 c = uVoid + glow;
        float vignette = 0.9 + 0.1 * (1.0 - length(vec2(vDir.x, vDir.z)));
        gl_FragColor = vec4(c * vignette, 1.0);
      }
    `,
  });
  const skyMesh = new THREE.Mesh(skyGeo, musicSkyMaterial);
  skyMesh.renderOrder = -500;
  musicBackdropGroup.add(skyMesh);

  const gridW = mobilePerf ? 200 : 260;
  const gridD = mobilePerf ? 320 : 400;
  const floorGeo = new THREE.PlaneGeometry(gridW, gridD, 1, 1);
  musicGridFloorMaterial = makeNeonGridShaderMaterial(false);
  const floor = new THREE.Mesh(floorGeo, musicGridFloorMaterial);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, -3.8, gridD * 0.42);
  floor.renderOrder = -480;
  musicBackdropGroup.add(floor);

  musicGridCeilingMaterial = makeNeonGridShaderMaterial(true);
  const ceil = new THREE.Mesh(floorGeo.clone(), musicGridCeilingMaterial);
  ceil.rotation.x = Math.PI / 2;
  ceil.position.set(0, 38, gridD * 0.38);
  ceil.renderOrder = -480;
  musicBackdropGroup.add(ceil);

  const starN = mobilePerf ? 48 : 110;
  const starPos = new Float32Array(starN * 3);
  for (let i = 0; i < starN; i++) {
    starPos[i * 3] = (Math.random() - 0.5) * 140;
    starPos[i * 3 + 1] = Math.random() * 36 + 4;
    starPos[i * 3 + 2] = 18 + Math.random() * 95;
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  musicStarsMaterial = new THREE.PointsMaterial({
    color: 0xff9ef8,
    size: mobilePerf ? 0.14 : 0.18,
    transparent: true,
    opacity: 0.86,
    sizeAttenuation: true,
    depthWrite: false,
    fog: false,
    blending: THREE.AdditiveBlending,
  });
  const stars = new THREE.Points(starGeo, musicStarsMaterial);
  stars.renderOrder = -450;
  musicBackdropGroup.add(stars);

  scene.add(musicBackdropGroup);
}

function updateMusicReactiveVisuals(dt) {
  if (!graphicsInited || !musicBackdropGroup || !camera) return;
  musicPulseTime += dt;
  const pz = playerGroup ? playerGroup.position.z : 0;
  musicBackdropGroup.position.set(0, 0, pz);
  musicBackdropGroup.updateMatrixWorld(true);

  const raw = sampleBgmBands();
  const bandK = 1 - Math.exp(-dt * 2.6);
  bgmEaseBass = THREE.MathUtils.lerp(bgmEaseBass, raw.bass, bandK);
  bgmEaseMid = THREE.MathUtils.lerp(bgmEaseMid, raw.mid, bandK);
  bgmEaseHigh = THREE.MathUtils.lerp(bgmEaseHigh, raw.high, bandK);
  const bass = bgmEaseBass;
  const mid = bgmEaseMid;
  const high = bgmEaseHigh;
  const aliveBoost = alive ? 1 : 0.4;
  const colorK = 1 - Math.exp(-dt * 2.4);

  if (musicSkyMaterial) {
    const tgtPulse = bass * aliveBoost;
    musicSkyMaterial.uniforms.uPulse.value = THREE.MathUtils.lerp(
      musicSkyMaterial.uniforms.uPulse.value,
      tgtPulse,
      0.07,
    );
    musicSkyMaterial.uniforms.uShimmer.value = musicPulseTime * (1.22 + mid * 2.35 + bass * 0.58);
    musicSkyMaterial.uniforms.uMid.value = mid * aliveBoost;
    musicSkyMaterial.uniforms.uHigh.value = high * aliveBoost;
    musicSkyMaterial.uniforms.uFlow.value = musicPulseTime;

    tmpMusicColor.setHSL(
      (0.91 + bass * 0.018 + mid * 0.012) % 1,
      1,
      0.46 + high * 0.05,
    );
    musicSkyMaterial.uniforms.uMagenta.value.lerp(tmpMusicColor, colorK);
    tmpMusicColor.setHSL((0.5 + mid * 0.04) % 1, 0.95, 0.48 + bass * 0.055);
    musicSkyMaterial.uniforms.uCyan.value.lerp(tmpMusicColor, colorK);
    tmpMusicColor.setRGB(0.02 + bass * 0.012, 0.008 + mid * 0.014, 0.048 + mid * 0.02);
    musicSkyMaterial.uniforms.uVoid.value.lerp(tmpMusicColor, colorK);
  }

  if (runwaySlabMat?.uniforms?.uCyan && musicSkyMaterial) {
    runwaySlabMat.uniforms.uCyan.value.copy(musicSkyMaterial.uniforms.uCyan.value);
    runwaySlabMat.uniforms.uMagenta.value.copy(musicSkyMaterial.uniforms.uMagenta.value);
    runwaySlabMat.uniforms.uVoid.value.copy(musicSkyMaterial.uniforms.uVoid.value);
  }

  if (musicGridFloorMaterial) {
    musicGridFloorMaterial.uniforms.uTime.value = musicPulseTime;
    musicGridFloorMaterial.uniforms.uPulse.value = bass * aliveBoost;
    musicGridFloorMaterial.uniforms.uMid.value = mid;
    musicGridFloorMaterial.uniforms.uHigh.value = high * aliveBoost;
  }
  if (musicGridCeilingMaterial) {
    musicGridCeilingMaterial.uniforms.uTime.value = musicPulseTime;
    musicGridCeilingMaterial.uniforms.uPulse.value = bass * 0.9 * aliveBoost;
    musicGridCeilingMaterial.uniforms.uMid.value = mid;
    musicGridCeilingMaterial.uniforms.uHigh.value = high * aliveBoost;
  }

  if (runwaySlabMat?.uniforms) {
    runwaySlabMat.uniforms.uScroll.value = distance;
    runwaySlabMat.uniforms.uTime.value = musicPulseTime;
    runwaySlabMat.uniforms.uPulse.value = bass * aliveBoost;
    if (camera && runwaySlabMat.uniforms.uCamPos) {
      runwaySlabMat.uniforms.uCamPos.value.copy(camera.position);
    }
    if (scene?.environment && runwaySlabMat.uniforms.uEnvMap && !runwaySlabMat.uniforms.uEnvMap.value) {
      runwaySlabMat.uniforms.uEnvMap.value = scene.environment;
    }
    if (playerGroup) {
      if (runwaySlabMat.uniforms.uPlayerX) runwaySlabMat.uniforms.uPlayerX.value = playerGroup.position.x;
      if (runwaySlabMat.uniforms.uPlayerZ) runwaySlabMat.uniforms.uPlayerZ.value = playerGroup.position.z;
    }
  }

  if (scene.fog && scene.userData.musicFogBase) {
    const f = scene.fog;
    const fogK = 1 - Math.exp(-dt * 2.2);
    tmpMusicColor.setHSL((0.86 + mid * 0.025) % 1, 0.5 + bass * 0.08, 0.14 + high * 0.032);
    const fogMix = THREE.MathUtils.clamp(0.08 + bass * 0.2 + mid * 0.08, 0, 0.34) * aliveBoost;
    tmpMusicFogTarget.copy(scene.userData.musicFogBase).lerp(tmpMusicColor, fogMix);
    f.color.lerp(tmpMusicFogTarget, fogK);
    const nearT = 28 + bass * 6 * aliveBoost;
    const farT = 98 + bass * 11 * aliveBoost + mid * 7;
    f.near = THREE.MathUtils.lerp(f.near, nearT, fogK);
    f.far = THREE.MathUtils.lerp(f.far, farT, fogK);
  }

  if (hemiLightRef) {
    const hemiT = 0.5 + bass * 0.22 * aliveBoost + mid * 0.07;
    hemiLightRef.intensity = THREE.MathUtils.lerp(hemiLightRef.intensity, hemiT, 1 - Math.exp(-dt * 2.8));
  }
  if (dirLightRef) {
    const dirT = 0.62 + bass * 0.22 * aliveBoost;
    dirLightRef.intensity = THREE.MathUtils.lerp(dirLightRef.intensity, dirT, 1 - Math.exp(-dt * 2.8));
  }

  if (musicStarsMaterial) {
    const starT = (mobilePerf ? 0.14 : 0.18) + high * 0.06 * aliveBoost + bass * 0.03;
    musicStarsMaterial.size = THREE.MathUtils.lerp(musicStarsMaterial.size, starT, 1 - Math.exp(-dt * 3.5));
  }

  runwayLanePulse = Math.max(0, runwayLanePulse - dt * 2.75);
  runwayFootFlash *= Math.exp(-dt * 5.4);
  if (runwayFootFlash < 0.003) runwayFootFlash = 0;
  const rp = runwayLanePulse * runwayLanePulse;
  if (runwaySlabMat?.uniforms?.uImpact) {
    runwaySlabMat.uniforms.uImpact.value = rp;
  }
  if (runwaySlabMat?.uniforms?.uFootFlash) {
    runwaySlabMat.uniforms.uFootFlash.value = runwayFootFlash;
  }
}

function init() {
  if (graphicsInited) return;
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0c0822);
  scene.fog = new THREE.Fog(0x281845, 32, 108);
  scene.userData.musicFogBase = new THREE.Color(scene.fog.color.getHex());

  camera = new THREE.PerspectiveCamera(58, 1, 0.1, 200);
  // Player runs toward +Z; camera stays behind (-Z) and looks ahead (+Z).
  camera.position.set(0, CAM_Y_AT_REST, -CAM_GAME_Z_OFFSET);
  camera.lookAt(0, CAM_LOOK_Y_AT_REST * 0.76, 10);

  mobilePerf = preferMobilePerf();

  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    powerPreference: 'high-performance',
    stencil: false,
    depth: true,
  });
  const pixelRatio = mobilePerf
    ? Math.min(window.devicePixelRatio, 1)
    : Math.min(window.devicePixelRatio, 1.5);
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.18;
  renderer.shadowMap.enabled = !mobilePerf;
  renderer.shadowMap.type = THREE.BasicShadowMap;

  setupImageBasedLighting();

  const hemi = new THREE.HemisphereLight(0xfff0ff, 0x2a2248, 1.02);
  hemiLightRef = hemi;
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 1.24);
  sun.position.set(8, 18, 10);
  sun.castShadow = !mobilePerf;
  dirLightRef = sun;
  if (!mobilePerf) {
    sun.shadow.mapSize.setScalar(1024);
    sun.shadow.camera.near = 0.5;
    sun.shadow.camera.far = 80;
    sun.shadow.camera.left = -20;
    sun.shadow.camera.right = 20;
    sun.shadow.camera.top = 25;
    sun.shadow.camera.bottom = -5;
  }
  scene.add(sun);

  createMusicBackdrop();

  worldGroup = new THREE.Group();
  scene.add(worldGroup);

  let zEnd = 0;
  const initialChunks = mobilePerf ? 4 : 6;
  for (let i = 0; i < initialChunks; i++) zEnd = spawnChunk(zEnd);

  playerGroup = makeBlockPlayer();
  playerGroup.position.set(0, 0, 0);
  playerGroup.castShadow = !mobilePerf;
  playerGroup.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = !mobilePerf;
      o.receiveShadow = !mobilePerf;
    }
  });
  scene.add(playerGroup);

  canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', 'Game');

  window.addEventListener('resize', onResize);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('lostpointercapture', () => {
    activePointerId = null;
  });

  overlay?.addEventListener('click', restart);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && gameStarted && alive) syncBgmPlayState();
  });

  graphicsInited = true;
}

function onResize() {
  if (!camera || !renderer) return;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

/** Must match ground contact tolerance in `tick` (~`playerY <= 0.035`); too tight and jump never fires. */
const JUMP_GROUND_Y_MAX = 0.055;

function tryJump() {
  if (!alive) return;
  if (!runGameplayActive) return;
  const onDeck = playerY <= JUMP_GROUND_Y_MAX;
  if (onDeck || canPlayerJumpFromTunnelRoof()) {
    playerVy = JUMP_V;
    pendingLandSfx = true;
    playJumpSfx();
    playPlayerJumpAnimation();
    bumpRunwayLanePulse(0.88);
  }
}

function shiftLane(dir) {
  if (!alive) return;
  if (!runGameplayActive) return;
  playerLane = THREE.MathUtils.clamp(playerLane + dir, -1, 1);
  targetLaneX = laneX(playerLane);
}

function onKeyDown(e) {
  if (!gameStarted) return;
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
    return;
  }
  if (e.code === 'ArrowDown' || e.code === 'KeyS') {
    if (!alive || !runGameplayActive) return;
    e.preventDefault();
    duckHeld = true;
  }
}

function onKeyUp(e) {
  if (!gameStarted) return;
  if (e.code === 'ArrowDown' || e.code === 'KeyS') {
    duckHeld = false;
  }
}

/** Mouse/pen: map pointer X across the canvas to lane (no click, no drag). */
const MOUSE_LANE_LEFT_MAX = 0.34;
const MOUSE_LANE_RIGHT_MIN = 0.66;

function updatePointerLaneFromCanvasX(clientX) {
  if (!alive || !runGameplayActive) return;
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0) return;
  const u = (clientX - rect.left) / rect.width;
  let want;
  if (u < MOUSE_LANE_LEFT_MAX) want = 1;
  else if (u > MOUSE_LANE_RIGHT_MIN) want = -1;
  else want = 0;
  if (want !== playerLane) {
    playerLane = want;
    targetLaneX = laneX(playerLane);
  }
}

function onPointerDown(e) {
  if (!gameStarted) return;
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
  if (!gameStarted || !alive || !runGameplayActive) return;

  const mouseLike = e.pointerType === 'mouse' || e.pointerType === 'pen';
  if (mouseLike) {
    updatePointerLaneFromCanvasX(e.clientX);
    return;
  }

  // Touch: change lane only while finger is down (drag).
  if (!(e.buttons & 1)) return;
  if (activePointerId == null || e.pointerId !== activePointerId) return;
  const TOUCH_DRAG_LANE_PX = 72;
  mouseLaneAccum += e.movementX;
  if (mouseLaneAccum >= TOUCH_DRAG_LANE_PX) {
    shiftLane(-1);
    mouseLaneAccum = 0;
    didDragLaneChange = true;
  } else if (mouseLaneAccum <= -TOUCH_DRAG_LANE_PX) {
    shiftLane(1);
    mouseLaneAccum = 0;
    didDragLaneChange = true;
  }
}

function onPointerUp(e) {
  if (!gameStarted) return;
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
  overlay?.classList.add('hidden');
  alive = true;
  speed = baseSpeed;
  distance = 0;
  coinCount = 0;
  playerLane = 0;
  targetLaneX = 0;
  playerY = 0;
  playerVy = 0;
  cameraSmoothedY = CAM_Y_AT_REST;
  nextSpawnZ = 20;
  lastObstacleCenterZ = -1e9;
  rng = mulberry32(0x9e3779b9 + Date.now() % 1e6);

  for (const o of obstacles) scene.remove(o.mesh);
  obstacles.length = 0;
  for (const c of coins) {
    scene.remove(c.mesh);
    disposeObjectSubtree(c.mesh);
  }
  coins.length = 0;
  for (const p of boostPads) scene.remove(p.mesh);
  boostPads.length = 0;
  for (const p of powerPads) scene.remove(p.mesh);
  powerPads.length = 0;
  speedBoostRemain = 0;
  boostRampRemain = 0;
  powerSpeedRemain = 0;

  while (worldGroup.children.length) worldGroup.remove(worldGroup.children[0]);
  let zEnd = 0;
  const restartChunks = mobilePerf ? 4 : 6;
  for (let i = 0; i < restartChunks; i++) zEnd = spawnChunk(zEnd);

  overlayAnimGeneration += 1;
  if (overlayStatsEl) overlayStatsEl.classList.remove('stats-enter');
  if (overlayTitleEl) overlayTitleEl.classList.remove('overlay-title--run');
  if (hudMetersEl) hudMetersEl.textContent = '0 m';
  if (hudCoinsEl) hudCoinsEl.textContent = '0';
  if (hudScoreEl) hudScoreEl.textContent = '0';
  updateSpeedHud(baseSpeed);
  if (bgmAudio) bgmAudio.playbackRate = BGM_RATE_MIN;
  pendingLandSfx = false;
  difficultyRampT = 0;
  runwayLanePulse = 0;
  runwayFootFlash = 0;
  runFootPhase = 0;
  lastRunFootSin = 1;
  skipNextFootstepDetect = false;
  landShakeMag = 0;
  if (runwaySlabMat?.uniforms?.uImpact) runwaySlabMat.uniforms.uImpact.value = 0;
  if (runwaySlabMat?.uniforms?.uFootFlash) runwaySlabMat.uniforms.uFootFlash.value = 0;
  if (runAudio) runAudio.pause();
  duckHeld = false;
  duckAmount = 0;
  if (playerGroup) {
    playerGroup.userData.duckAmount = 0;
    if (playerGroup.userData.visualRoot) {
      playerGroup.userData.visualRoot.userData.duckBlend = 0;
    }
  }
  runGameplayActive = true;
  introCameraActive = false;
  introCameraElapsed = 0;
  syncPlayCursor();
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

  if (o.kind === 'gap') {
    const hd = GAP_WALL_DEPTH / 2;
    if (rect.maxZ < oz - hd || rect.minZ > oz + hd) return false;
    const foot = playerY;
    const topOff = THREE.MathUtils.lerp(PLAYER_STAND_TOP, PLAYER_DUCK_TOP, duckAmount);
    const top = playerY + topOff;
    const obsBot = GAP_WALL_Y - GAP_WALL_HALF_H;
    const obsTop = GAP_WALL_Y + GAP_WALL_HALF_H;
    if (top < obsBot || foot > obsTop + 0.05) return false;
    const gl = o.gapMin;
    const gr = o.gapMax;
    const tl = o.trackMin;
    const tr = o.trackMax;
    const hitL = gl > tl + 0.02 && rect.maxX > tl && rect.minX < gl;
    const hitR = tr > gr + 0.02 && rect.maxX > gr && rect.minX < tr;
    return hitL || hitR;
  }

  let hw, hd;
  let halfH;
  if (o.kind === 'train') {
    hw = (LANE_WIDTH * 0.85) / 2;
    hd = 3.2 / 2;
    halfH = 0.675;
  } else {
    hw = (LANE_WIDTH * 0.75) / 2;
    hd = 0.55 / 2;
    halfH = 0.225;
  }
  const minX = ox - hw;
  const maxX = ox + hw;
  const minZ = oz - hd;
  const maxZ = oz + hd;
  if (rect.maxX < minX || rect.minX > maxX || rect.maxZ < minZ || rect.minZ > maxZ) return false;

  const foot = playerY;
  const topOff = THREE.MathUtils.lerp(PLAYER_STAND_TOP, PLAYER_DUCK_TOP, duckAmount);
  const top = playerY + topOff;
  const obsBot = m.position.y - halfH;
  const obsTop = m.position.y + halfH;
  return !(top < obsBot || foot > obsTop + 0.05);
}

function tick(dt) {
  if (!gameStarted || !alive) return;
  if (!runGameplayActive) return;

  tickFrame += 1;

  let speedBonus = Math.min(SPEED_MAX_BONUS, distance * SPEED_RAMP_PER_UNIT);
  if (boostRampRemain > 0) {
    boostRampRemain = Math.max(0, boostRampRemain - dt);
    speedBonus = Math.min(SPEED_MAX_BONUS, speedBonus + dt * BOOST_PAD_EXTRA_BONUS_RATE);
  }
  difficultyRampT = SPEED_MAX_BONUS > 0 ? speedBonus / SPEED_MAX_BONUS : 0;
  speed = baseSpeed + speedBonus;
  let travelSpeed = speed;
  if (speedBoostRemain > 0) {
    speedBoostRemain = Math.max(0, speedBoostRemain - dt);
    travelSpeed *= BOOST_SPEED_MULT;
  }
  if (powerSpeedRemain > 0) {
    powerSpeedRemain = Math.max(0, powerSpeedRemain - dt);
    travelSpeed *= POWER_SPEED_MULT;
  }
  distance += travelSpeed * dt;
  updateSpeedHud(travelSpeed);

  playerGroup.position.x = THREE.MathUtils.lerp(
    playerGroup.position.x,
    targetLaneX,
    1 - Math.pow(0.0002, dt),
  );

  const wasAboveGround = playerY > 0.04;
  playerVy += GRAVITY * dt;
  playerY += playerVy * dt;

  const pzTunnel = distance;
  if (getTunnelStripeAtZ(pzTunnel)) {
    const { ceilBottomY, roofTopY } = tunnelGeomConsts();
    const topOff = THREE.MathUtils.lerp(PLAYER_STAND_TOP, PLAYER_DUCK_TOP, duckAmount);
    const bodyTop = playerY + topOff;
    if (playerVy > 0 && bodyTop >= ceilBottomY - 0.05) {
      playerY = roofTopY;
      playerVy = 0;
      playLandSfx();
      bumpRunwayFootImpact(0.42);
      skipNextFootstepDetect = true;
      pendingLandSfx = false;
      if (playerJumpAnimOverride) resumeRunAfterJumpAnim();
    } else if (
      playerVy <= 0.22 &&
      playerY >= roofTopY - 0.42 &&
      playerY <= roofTopY + 0.38
    ) {
      playerY = roofTopY;
      playerVy = 0;
      if (playerJumpAnimOverride) resumeRunAfterJumpAnim();
    }
  }

  if (playerY < 0) {
    playerY = 0;
    playerVy = 0;
    if (wasAboveGround) {
      bumpRunwayFootImpact(0.78);
      skipNextFootstepDetect = true;
      landShakeMag = 1;
      landShakePhase = musicPulseTime * 18;
      if (pendingLandSfx) playLandSfx();
    }
    if (playerJumpAnimOverride) resumeRunAfterJumpAnim();
    pendingLandSfx = false;
  }
  playerGroup.position.y = playerY;

  const onRoofForDuck = isPlayerOnTunnelRoof({ vyMax: 0.06 });
  const grounded = playerY <= 0.035 || onRoofForDuck;
  const duckTarget = duckHeld && grounded ? 1 : 0;
  const duckK = duckTarget > duckAmount + 1e-4 ? DUCK_LERP_IN : DUCK_LERP_OUT;
  duckAmount = THREE.MathUtils.lerp(duckAmount, duckTarget, 1 - Math.exp(-dt * duckK));
  if (playerGroup) {
    playerGroup.userData.duckAmount = duckAmount;
    const vr = playerGroup.userData.visualRoot;
    if (vr) vr.userData.duckBlend = duckAmount;
  }
  const bt = playerGroup?.userData?.blockTorso;
  const bh = playerGroup?.userData?.blockHead;
  if (bt && bh) {
    bt.position.y = 0.85 - duckAmount * 0.4;
    bh.position.y = 1.38 - duckAmount * 0.58;
  }

  if (skipNextFootstepDetect) {
    skipNextFootstepDetect = false;
    lastRunFootSin = Math.sin(runFootPhase);
  } else if (
    (playerY < 0.07 || onRoofForDuck) &&
    playerVy <= 0.02
  ) {
    const cadence =
      (2.55 +
        difficultyRampT * 0.62 +
        (speedBoostRemain > 0 ? 0.42 : 0) +
        (powerSpeedRemain > 0 ? 0.26 : 0)) *
      THREE.MathUtils.clamp(travelSpeed / 12, 0.85, 1.38);
    const prevS = lastRunFootSin;
    runFootPhase += dt * Math.PI * 2 * cadence;
    const s = Math.sin(runFootPhase);
    if (prevS * s < 0) {
      bumpRunwayFootImpact(0.3);
    }
    lastRunFootSin = s;
  } else if (playerY > 0.06) {
    lastRunFootSin = Math.sin(runFootPhase);
  }

  const runPhase = distance * 0.35;
  const legs = playerGroup.userData.legs;
  if (legs) {
    const swing = Math.sin(runPhase) * 0.35 * (1 - duckAmount * 0.65);
    legs[0].rotation.x = swing;
    legs[1].rotation.x = -swing;
  }

  if (playerRunAction && alive && runGameplayActive && !playerJumpAnimOverride) {
    playerRunAction.enabled = true;
    playerRunAction.paused = false;
    if (!playerRunAction.isRunning()) {
      playerRunAction.setEffectiveWeight(1);
      playerRunAction.play();
    }
    /** Match foot cycle to world speed: travel can reach ~4× base while old ramp only ~1.6× anim. */
    const speedMul = travelSpeed / Math.max(baseSpeed, 1e-3);
    const curved = Math.pow(speedMul, 0.9);
    playerRunAction.timeScale = THREE.MathUtils.clamp(curved * 0.98, 0.88, 2.75);
  }

  if (playerJumpAction && playerJumpAnimOverride && playerMixer) {
    if (!playerJumpAction.isRunning()) {
      playerJumpAction.enabled = true;
      playerJumpAction.play();
    }
  }

  const vRoot = playerGroup.userData.visualRoot;
  if (vRoot && alive && !playerMixer && playerGroup.userData.gltfStaticPose) {
    const gy = vRoot.userData.groundAlignY ?? vRoot.position.y;
    if (vRoot.userData.groundAlignY == null) vRoot.userData.groundAlignY = vRoot.position.y;
    const step = distance * 1.22;
    const hop = Math.max(0, Math.sin(step * 2));
    vRoot.rotation.z = Math.sin(step) * 0.12 * (1 - duckAmount * 0.7);
    vRoot.rotation.x = -0.28 - difficultyRampT * 0.16 + duckAmount * 0.55;
    vRoot.position.y = gy + hop * 0.12 * (1 - duckAmount) - duckAmount * 0.38;
  }

  const pz = distance;
  playerGroup.position.z = pz;

  camera.position.z = pz - CAM_GAME_Z_OFFSET;
  camera.position.x = THREE.MathUtils.lerp(camera.position.x, playerGroup.position.x * 0.35, 0.06);
  const targetCamY = CAM_Y_AT_REST + playerY * CAM_Y_LIFT_PER_PLAYER_Y;
  cameraSmoothedY = THREE.MathUtils.lerp(
    cameraSmoothedY,
    targetCamY,
    1 - Math.exp(-dt * CAM_Y_SMOOTH_RATE),
  );
  camera.position.y = cameraSmoothedY;
  landShakePhase += dt * 52;
  landShakeMag *= Math.exp(-dt * 10.5);
  if (landShakeMag > 0.006) {
    const s = landShakeMag;
    camera.position.y += s * 0.09 * Math.sin(landShakePhase);
    camera.position.x += s * 0.042 * Math.sin(landShakePhase * 1.67 + 0.8);
    camera.position.z += s * 0.025 * Math.cos(landShakePhase * 2.05);
  }
  const lookY = CAM_LOOK_Y_AT_REST + playerY * CAM_LOOK_LIFT_PER_PLAYER_Y;
  camera.lookAt(playerGroup.position.x * 0.4, lookY, pz + 10);

  const spawnLookahead = 78;
  while (nextSpawnZ < pz + spawnLookahead) {
    const roll = rng();
    if (roll < 0.38) {
      spawnObstacle(nextSpawnZ + 10 + rng() * 8, travelSpeed);
      nextSpawnZ = Math.max(nextSpawnZ, lastObstacleCenterZ) + 7 + rng() * 9;
    } else if (roll < 0.62) {
      spawnCoinRow(nextSpawnZ + 5);
      nextSpawnZ += 5 + rng() * 7;
    } else if (roll < 0.685) {
      const zTrail = nextSpawnZ + 6 + rng() * 12;
      spawnPurpleTunnelRoofTrail(zTrail, 38 + rng() * 58);
      nextSpawnZ += 9 + rng() * 10;
    } else if (roll < 0.775) {
      spawnPowerPad(nextSpawnZ + 6 + rng() * 5);
      nextSpawnZ += 5 + rng() * 7;
    } else if (roll < 0.865) {
      const wantZ = nextSpawnZ + 6 + rng() * 5;
      const { z: bz, ok } = findBoostZOutsideTunnel(wantZ);
      spawnBoostPad(ok ? bz : wantZ, { decoy: !ok });
      nextSpawnZ += 5 + rng() * 7;
    } else {
      nextSpawnZ += 4 + rng() * 6;
    }
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
  const padHalfD = BOOST_PAD_DEPTH / 2;
  for (const pad of boostPads) {
    if (pad.used || pad.decoy) continue;
    const mx = pad.mesh.position.x;
    const mz = pad.mesh.position.z;
    if (Math.abs(mz - pz) > padHalfD + 0.35) continue;
    if (rect.minX > mx + padHalfW || rect.maxX < mx - padHalfW) continue;
    if (rect.minZ > mz + padHalfD || rect.maxZ < mz - padHalfD) continue;
    if (playerY > 0.42) continue;
    pad.used = true;
    pendingLandSfx = true;
    playBoostSfx();
    bumpRunwayFootImpact(0.72);
    skipNextFootstepDetect = true;
    playerVy = BOOST_PAD_VY;
    playerY = Math.max(playerY, 0.52);
    playerGroup.position.y = playerY;
    speedBoostRemain = BOOST_SPEED_SEC;
    boostRampRemain = Math.max(boostRampRemain, BOOST_PAD_ACCEL_SEC);
    setPadUsedUniform(pad.mesh, 1);
    playPlayerJumpAnimation();
  }

  const powerHalfW = (LANE_WIDTH * 0.86) / 2;
  const powerHalfD = POWER_PAD_DEPTH / 2;
  for (const pad of powerPads) {
    if (pad.used) continue;
    const mx = pad.mesh.position.x;
    const mz = pad.mesh.position.z;
    if (Math.abs(mz - pz) > powerHalfD + 0.35) continue;
    if (rect.minX > mx + powerHalfW || rect.maxX < mx - powerHalfW) continue;
    if (rect.minZ > mz + powerHalfD || rect.maxZ < mz - powerHalfD) continue;
    if (playerY > 0.42) continue;
    pad.used = true;
    playPowerPadSfx();
    bumpRunwayFootImpact(0.48);
    skipNextFootstepDetect = true;
    powerSpeedRemain = Math.max(powerSpeedRemain, POWER_SPEED_SEC);
    setPadUsedUniform(pad.mesh, 1);
  }

  for (const o of obstacles) {
    if (o.mesh.position.z < pz - 3) continue;
    if (overlapsObstacle(rect, o)) {
      alive = false;
      playGameOverSfx();
      overlay?.classList.remove('hidden');
      syncPlayCursor();
      const metersInt = Math.floor(distance);
      showGameOverRollup(metersInt, coinCount, calcRunScore(metersInt, coinCount));
      break;
    }
  }

  for (const c of coins) {
    if (c.collected) continue;
    if (Math.abs(c.mesh.position.z - pz) > 0.55) continue;
    if (Math.abs(c.mesh.position.x - playerGroup.position.x) > 0.65) continue;
    if (c.mega) {
      const { roofTopY } = tunnelGeomConsts();
      if (playerY < roofTopY - 0.2) continue;
    }
    c.collected = true;
    c.collecting = true;
    c.collectTime = 0;
    c.baseScale = c.mesh.scale.x;
    const add = c.coinValue ?? 1;
    coinCount += add;
    if (hudCoinsEl) hudCoinsEl.textContent = String(coinCount);
    if (hudCoinsWrap) {
      hudCoinsWrap.classList.remove('hud-pop');
      void hudCoinsWrap.offsetWidth;
      hudCoinsWrap.classList.add('hud-pop');
      window.clearTimeout(hudCoinsWrap._coinPopT);
      hudCoinsWrap._coinPopT = window.setTimeout(() => hudCoinsWrap.classList.remove('hud-pop'), 420);
    }
    playCoinSfx(coinCount);
  }

  const metersInt = Math.floor(distance);
  if (hudMetersEl) hudMetersEl.textContent = `${metersInt} m`;
  if (hudScoreEl) hudScoreEl.textContent = String(calcRunScore(metersInt, coinCount));

  for (let i = obstacles.length - 1; i >= 0; i--) {
    if (obstacles[i].mesh.position.z < pz - 25) {
      scene.remove(obstacles[i].mesh);
      obstacles.splice(i, 1);
    }
  }
  for (let i = coins.length - 1; i >= 0; i--) {
    const c = coins[i];
    if (c.pendingDispose) {
      scene.remove(c.mesh);
      disposeObjectSubtree(c.mesh);
      coins.splice(i, 1);
      continue;
    }
    if (!c.collected && c.mesh.position.z < pz - 25) {
      scene.remove(c.mesh);
      disposeObjectSubtree(c.mesh);
      coins.splice(i, 1);
    } else if (c.collected && c.mesh.position.z < pz - 48) {
      scene.remove(c.mesh);
      disposeObjectSubtree(c.mesh);
      coins.splice(i, 1);
    }
  }

  for (let i = boostPads.length - 1; i >= 0; i--) {
    if (boostPads[i].mesh.position.z < pz - 22) {
      scene.remove(boostPads[i].mesh);
      boostPads.splice(i, 1);
    }
  }
  for (let i = powerPads.length - 1; i >= 0; i--) {
    if (powerPads[i].mesh.position.z < pz - 22) {
      scene.remove(powerPads[i].mesh);
      powerPads.splice(i, 1);
    }
  }

  for (const c of coins) {
    if (c.collecting) {
      c.collectTime += dt;
      c.mesh.rotation.y += dt * (26 + c.collectTime * 48);
      c.mesh.rotation.x += dt * 16;
      c.mesh.rotation.z += dt * 9;
      const u = Math.min(1, c.collectTime / 0.38);
      c.mesh.scale.setScalar(c.baseScale * (1 + u * u * 2.4));
      if (c.collectTime >= 0.48) c.pendingDispose = true;
    } else if (!c.collected) {
      c.mesh.rotation.y += dt * 4.8;
      if (c.mesh.userData?.isCoinGltf) {
        c.mesh.rotation.x += dt * 0.85 * Math.sin(distance * 0.08 + c.z * 0.2);
        c.mesh.rotation.z += dt * 0.45 * Math.cos(distance * 0.06 + c.z * 0.15);
      }
    }
  }
}

let last = performance.now();
function loop(now) {
  if (!graphicsInited || !renderer) return;
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  holoTime += dt;
  tick(dt);
  if (gameStarted && alive && !runGameplayActive && introCameraActive) {
    introCameraElapsed += dt;
    updateIntroCamera();
  }
  if (playerRunAction && gameStarted && !alive) playerRunAction.timeScale = 0;
  if (playerMixer) playerMixer.update(dt);
  updateBgmPlayback(dt);
  updateRunSfx();
  updateMusicReactiveVisuals(dt);
  syncHologramTimeUniforms(holoTime);
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}

/** Fetch + decode BGM and SFX (blob URLs, run loop clip). Does not start gameplay. */
async function preloadAudioPipeline() {
  const bgmBlob = await fetchFirstWorkingBgmBlob();
  revokeAllSfxObjectUrls();
  sfxObjectUrls = await fetchAllSfxObjectUrls();
  revokeBgmBlobUrl();
  bgmAudio = null;
  if (bgmBlob) {
    bgmObjectUrl = URL.createObjectURL(bgmBlob);
    const a = new Audio(bgmObjectUrl);
    a.preload = 'auto';
    a.loop = true;
    a.volume = BGM_VOLUME;
    await waitAudioElementReady(a);
    if (a.error) {
      revokeBgmBlobUrl();
    } else {
      bgmAudio = a;
      tryAttachBgmAnalyser();
    }
  }
  runAudio = null;
  const runUrl = sfxObjectUrls.run;
  if (runUrl) {
    const r = new Audio(runUrl);
    r.loop = true;
    r.preload = 'auto';
    r.volume = 0.32;
    await waitAudioElementReady(r);
    if (!r.error) runAudio = r;
  }
}

/**
 * Create WebGL context, scene, and meshes only after user gesture; warm up shaders so the first
 * playable frame does not freeze mobile Safari/Chrome.
 */
async function preloadGraphicsPipeline() {
  await new Promise((r) => requestAnimationFrame(r));
  init();
  onResize();
  await Promise.all([loadAndApplyPlayerCharacter(), loadCoinPrefab()]);
  if (typeof renderer.compile === 'function') {
    renderer.compile(scene, camera);
  }
  for (let i = 0; i < 3; i += 1) {
    renderer.render(scene, camera);
    await new Promise((r) => requestAnimationFrame(r));
  }
}

function wireStartScreen() {
  if (!startBtnEl || !startScreenEl) return;
  startBtnEl.addEventListener('click', async () => {
    if (gameStarted) return;
    primeBgmAudioContext();
    startBtnEl.disabled = true;
    if (startStatusEl) startStatusEl.textContent = 'Loading 3D engine and audio…';
    try {
      await Promise.all([preloadAudioPipeline(), preloadGraphicsPipeline()]);
      initCoinAudioPool();
      gameStarted = true;
      unlockBgm();
      startScreenEl.classList.add('hidden');
      if (startStatusEl) startStatusEl.textContent = '';
      syncPlayCursor();
      last = performance.now();
      requestAnimationFrame(loop);
    } catch (err) {
      console.error('Game failed to start', err);
      if (startStatusEl) {
        startStatusEl.textContent =
          'Could not finish loading. Check your connection and tap Play again.';
      }
      startBtnEl.disabled = false;
      syncPlayCursor();
    }
  });
}

wireStartScreen();
syncPlayCursor();

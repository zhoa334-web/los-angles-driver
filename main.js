/* =====================================================================
   SUNSET BOULEVARD  |  2023 Toyota Camry TRD  |  Three.js r128
   Plain <script> build: no bundler, no ES modules, runs from any static server.

   Sections
     0  Config + helpers            7  Road segments (palms, lights, signs)
     1  Renderer / scene / camera   8  Traffic
     2  Sky + environment map       9  Skid marks + tire smoke
     3  Lighting + shadow setup    10  Audio
     4  Procedural textures        11  Physics (engine, gearbox, tires)
     5  Car model (Camry TRD)      12  Camera rig
     6  Backdrop (hills, skyline)  13  HUD, minimap, input, main loop

   World: the car drives toward +Z (west, into the sunset). Facing +Z,
   "left" is +X, so the car's own lanes are x < 0 and oncoming lanes x > 0.
   ===================================================================== */
(function () {
'use strict';

/* ===================================================================
   0. CONFIG + HELPERS
   =================================================================== */
// Phone / tablet browsers get touch buttons and a portrait-friendly layout.
// Browsers in "Desktop site" mode report a desktop user agent, so they keep the desktop layout.
// Test overrides: ?mobile=1 forces mobile, ?mobile=0 forces desktop.
const _qs = new URLSearchParams(window.location.search);
const IS_MOBILE = _qs.has('mobile')
  ? _qs.get('mobile') !== '0'
  : /Android|iPhone|iPad|iPod|Mobile|Silk/i.test(navigator.userAgent);
document.body.classList.toggle('is-mobile', IS_MOBILE);

const CONFIG = {
  modelUrl: null,          // e.g. 'assets/camry_trd.glb'  -> see tryLoadGLB()
  modelYawDeg: 0,          // rotate the GLB so its nose points to +Z
  shadowMapSize: IS_MOBILE ? 2048 : 4096,
  shadowExtent: 60,        // half-size (m) of the shadow frustum around the car
  segLen: 120,
  segCount: 7,
  trafficCount: 10,
  paints: [
    { name: 'Supersonic Red',   color: 0xc3101a },
    { name: 'Wind Chill Pearl', color: 0xeceff2 },
    { name: 'Reservoir Blue',   color: 0x1d3f8f },
    { name: 'Celestial Silver', color: 0x9aa1a8 }
  ]
};

const SEG = CONFIG.segLen;
const ROAD_HALF = 12;
const WALL_X = 17.3;

const clamp = THREE.MathUtils.clamp;
const lerp = THREE.MathUtils.lerp;
const rad = THREE.MathUtils.degToRad;
const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));
const wrapPI = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const mod = (n, m) => ((n % m) + m) % m;
const approachZero = (v, d) => (Math.abs(v) <= d ? 0 : v - Math.sign(v) * d);
const $ = (id) => document.getElementById(id);

// r128 treats hex colours as linear. Convert sRGB hex so colours look as written.
const col = (hex) => new THREE.Color(hex).convertSRGBToLinear();

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')];
}

function addNoise(ctx, w, h, amp) {
  const img = ctx.getImageData(0, 0, w, h), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * amp;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
}

/* ===================================================================
   0b. SAVE DATA, GARAGE, ROUTES, CAREER LEVELS  (plain data, no THREE objects)
   =================================================================== */
const SAVE_KEY = 'sunset-blvd-career-v1';
const Save = {
  data: null,
  dirty: false,
  defaults() {
    return {
      coins: 0, xp: 0, owned: ['camry'], car: 'camry', paint: {}, route: 'sunset', quests: null,
      stats: { distance: 0, topSpeed: 0, bestDrift: 0, coins: 0, nearMiss: 0, quests: 0, crashes: 0 }
    };
  },
  load() {
    const d = this.defaults();
    try {
      const raw = JSON.parse(window.localStorage.getItem(SAVE_KEY) || 'null');
      if (raw && typeof raw === 'object') {
        Object.assign(d, raw);
        d.stats = Object.assign(this.defaults().stats, raw.stats || {});
        if (!Array.isArray(d.owned) || !d.owned.length) d.owned = ['camry'];
      }
    } catch (e) { /* private mode or blocked storage: play without saving */ }
    this.data = d;
  },
  save() { try { window.localStorage.setItem(SAVE_KEY, JSON.stringify(this.data)); } catch (e) { /* ignore */ } },
  reset() { this.data = this.defaults(); this.save(); }
};
Save.load();

// Cars share the Camry's body shell, reshaped (x/y/z scale) and tuned (engine, weight, grip).
const GARAGE = [
  { id: 'camry', name: 'Camry TRD', tag: 'Your daily. TRD-tuned V6.', price: 0, level: 1, paint: 0, blackRoof: true,
    shape: { xs: 1.0, ys: 1.0, zs: 1.0 }, stats: { torque: 1.0, mass: 1620, vmax: 64, grip: 1.0, traction: 7.4 } },
  { id: 'hatch', name: 'Venice Hatch', tag: 'Light, tidy, loves tight lanes.', price: 1500, level: 1, paint: 1, blackRoof: false,
    shape: { xs: 0.95, ys: 1.04, zs: 0.84 }, stats: { torque: 0.62, mass: 1180, vmax: 55, grip: 1.06, traction: 7.6 } },
  { id: 'coupe', name: 'Silver Lake Coupe', tag: 'Low, quick and balanced.', price: 4500, level: 2, paint: 2, blackRoof: true,
    shape: { xs: 1.02, ys: 0.93, zs: 0.96 }, stats: { torque: 1.05, mass: 1400, vmax: 72, grip: 1.12, traction: 8.2 } },
  { id: 'gt', name: 'Mulholland GT', tag: 'Grand tourer with serious power.', price: 11000, level: 4, paint: 3, blackRoof: false,
    shape: { xs: 1.05, ys: 0.90, zs: 1.02 }, stats: { torque: 1.45, mass: 1500, vmax: 84, grip: 1.22, traction: 9.2 } },
  { id: 'hyper', name: 'Hills Hyper', tag: 'Pure speed. Hold on tight.', price: 28000, level: 6, paint: 0, blackRoof: false,
    shape: { xs: 1.08, ys: 0.87, zs: 1.0 }, stats: { torque: 2.1, mass: 1450, vmax: 96, grip: 1.35, traction: 10.5 } }
];
const carById = (id) => GARAGE.find((c) => c.id === id) || GARAGE[0];

// Routes: each one is a full look (sky, light, fog) plus a set of roadside rules.
const ROUTES = [
  { id: 'sunset', name: 'Sunset Boulevard', icon: 'fa-sun', level: 1, mood: 'Golden hour',
    desc: 'Palm-lined lanes, freeway signs and a sky on fire.',
    districts: ['Sunset Strip', 'Beverly Hills', 'Holmby Hills', 'Brentwood', 'Pacific Palisades'],
    sky: { zenith: [0.02, 0.055, 0.2], violet: [0.18, 0.11, 0.26], pink: [0.8, 0.25, 0.2], horizon: [0.95, 0.4, 0.14] },
    sunDir: [-0.30, 0.24, 0.92], sunColor: 0xffa86a, sunInt: 2.6, sunTint: [1, 1, 1], sunGain: 1, stars: 0, cloud: 1,
    amb: [0x6a5a7a, 0.45], hemi: [0xffb07a, 0x3a2a30, 0.55], fog: [0.80, 0.36, 0.14], fogD: 0.0027, exposure: 0.9,
    hills: ['#6c3d52', '#e98a58', '#3d2a44', '#c8714f'],
    palms: true, gantry: true, night: false, ocean: false, bld: 'city', bldEmissive: 0.7, lamp: 1.6 },
  { id: 'pch', name: 'Pacific Coast Highway', icon: 'fa-water', level: 3, mood: 'Bright afternoon',
    desc: 'Ocean on one side, cliffs on the other, wide open road.',
    districts: ['Malibu', 'Topanga', 'Pacific Palisades', 'Santa Monica'],
    sky: { zenith: [0.03, 0.14, 0.50], violet: [0.10, 0.30, 0.62], pink: [0.50, 0.52, 0.64], horizon: [0.85, 0.72, 0.58] },
    sunDir: [-0.35, 0.50, 0.80], sunColor: 0xffe6c0, sunInt: 3.0, sunTint: [1, 0.9, 0.7], sunGain: 0.7, stars: 0, cloud: 0.55,
    amb: [0x8aa0c8, 0.55], hemi: [0xbfd8ff, 0x8a7a60, 0.75], fog: [0.62, 0.56, 0.50], fogD: 0.0021, exposure: 0.95,
    hills: ['#7d6a52', '#b9a67e', '#5b6450', '#9a9066'],
    palms: true, gantry: false, night: false, ocean: true, bld: 'coast', bldEmissive: 0.05, lamp: 0.3 },
  { id: 'downtown', name: 'Wilshire Night', icon: 'fa-city', level: 5, mood: 'City lights',
    desc: 'Towers, glowing windows and pools of lamplight after dark.',
    districts: ['Wilshire', 'Koreatown', 'Financial District', 'Little Tokyo'],
    sky: { zenith: [0.003, 0.006, 0.03], violet: [0.02, 0.015, 0.07], pink: [0.12, 0.05, 0.14], horizon: [0.20, 0.08, 0.12] },
    sunDir: [0.30, 0.38, 0.87], sunColor: 0x8fa8ff, sunInt: 0.55, sunTint: [0.55, 0.7, 1.0], sunGain: 0.55, stars: 1, cloud: 0.12,
    amb: [0x3a3a78, 0.55], hemi: [0x5a5aa0, 0x1a1224, 0.45], fog: [0.05, 0.03, 0.09], fogD: 0.0030, exposure: 1.15,
    hills: ['#150f2a', '#34203f', '#0c0a1c', '#241638'],
    palms: false, gantry: true, night: true, ocean: false, bld: 'tall', bldEmissive: 1.7, lamp: 3.2 }
];
const routeById = (id) => ROUTES.find((r) => r.id === id) || ROUTES[0];
let currentRoute = ROUTES[0];

// Career levels: XP needed grows with each level. Rank title changes every two levels.
const RANKS = ['Rookie', 'Street Cruiser', 'Boulevard Regular', 'Canyon Racer', 'Drift Specialist', 'Hollywood Legend'];
const xpNeed = (lvl) => 100 + 70 * (lvl - 1);
function levelInfo(xp) {
  let lvl = 1, rem = xp;
  while (rem >= xpNeed(lvl)) { rem -= xpNeed(lvl); lvl++; }
  return { lvl, rem, need: xpNeed(lvl) };
}
const rankOf = (lvl) => RANKS[Math.min(Math.floor((lvl - 1) / 2), RANKS.length - 1)];

/* ===================================================================
   1. RENDERER / SCENE / CAMERA
   =================================================================== */
const canvas = $('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, IS_MOBILE ? 1.5 : 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.9;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const MAX_ANISO = renderer.capabilities.getMaxAnisotropy();

const scene = new THREE.Scene();
const FOG_COLOR = new THREE.Color(0.80, 0.36, 0.14);     // linear, matches sky horizon
scene.fog = new THREE.FogExp2(FOG_COLOR, 0.0027);

const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 2500);
camera.position.set(-6, 3, -8);

const controls = new THREE.OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.495;
controls.minDistance = 4;
controls.maxDistance = 40;
controls.enabled = false;

function canvasTex(c, opts) {
  opts = opts || {};
  const t = new THREE.CanvasTexture(c);
  t.encoding = opts.linear ? THREE.LinearEncoding : THREE.sRGBEncoding;
  t.anisotropy = MAX_ANISO;
  if (opts.repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(opts.repeat[0], opts.repeat[1]);
  }
  return t;
}

/* ===================================================================
   2. SKY + ENVIRONMENT MAP
   =================================================================== */
const SUN_DIR = new THREE.Vector3(-0.30, 0.24, 0.92).normalize();

const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  depthWrite: false,
  fog: false,
  uniforms: {
    sunDir: { value: SUN_DIR.clone() },
    zenith: { value: new THREE.Vector3(0.02, 0.055, 0.2) },
    violet: { value: new THREE.Vector3(0.18, 0.11, 0.26) },
    pink: { value: new THREE.Vector3(0.8, 0.25, 0.2) },
    horizon: { value: new THREE.Vector3(0.95, 0.4, 0.14) },
    sunTint: { value: new THREE.Vector3(1, 1, 1) },
    sunGain: { value: 1 },
    stars: { value: 0 },
    cloudAmt: { value: 1 }
  },
  vertexShader: `
    varying vec3 vDir;
    void main() {
      vDir = normalize(position);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: `
    uniform vec3 sunDir;
    uniform vec3 zenith; uniform vec3 violet; uniform vec3 pink; uniform vec3 horizon;
    uniform vec3 sunTint; uniform float sunGain; uniform float stars; uniform float cloudAmt;
    varying vec3 vDir;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p){
      vec2 i = floor(p), f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
                 mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
    }
    float fbm(vec2 p){
      float a = 0.5, s = 0.0;
      for (int i = 0; i < 5; i++) { s += a * noise(p); p *= 2.03; a *= 0.5; }
      return s;
    }
    void main() {
      vec3 d = normalize(vDir);
      float h = d.y;
      vec3 col = mix(horizon, pink, smoothstep(0.0, 0.10, h));
      col = mix(col, violet, smoothstep(0.08, 0.35, h));
      col = mix(col, zenith, smoothstep(0.30, 0.90, h));
      col = mix(col, vec3(0.05, 0.035, 0.03), 1.0 - smoothstep(-0.06, 0.0, h));

      float sd = max(dot(d, normalize(sunDir)), 0.0);

      // wispy clouds lit from below by the sun
      if (h > 0.0) {
        vec2 cp = d.xz / (h + 0.12) * vec2(1.3, 2.4);
        float c = fbm(cp * 0.9 + vec2(3.0, 1.0));
        c = smoothstep(0.48, 0.80, c) * smoothstep(0.02, 0.18, h);
        vec3 cloud = mix(vec3(0.95, 0.32, 0.12), vec3(0.75, 0.38, 0.50), smoothstep(0.0, 0.4, h));
        cloud += vec3(1.0, 0.5, 0.2) * pow(sd, 4.0) * 1.2;
        col = mix(col, cloud, c * 0.65 * cloudAmt);
      }

      col += vec3(1.0, 0.55, 0.20) * sunTint * sunGain * pow(sd, 6.0) * 0.55;
      col += vec3(1.0, 0.70, 0.35) * sunTint * sunGain * pow(sd, 64.0) * 1.6;
      col += vec3(1.0, 0.90, 0.70) * sunTint * sunGain * smoothstep(0.9994, 0.9997, sd) * 18.0;

      if (stars > 0.0 && h > 0.02) {
        vec2 sp = d.xz / (h + 0.4) * 140.0;
        float st = step(0.9965, hash(floor(sp))) * (0.5 + 0.5 * hash(floor(sp) + 7.0));
        col += vec3(0.9, 0.95, 1.0) * st * stars * smoothstep(0.02, 0.2, h);
      }

      gl_FragColor = vec4(col, 1.0);
      #include <tonemapping_fragment>
      #include <encodings_fragment>
    }`
});

const skyMesh = new THREE.Mesh(new THREE.SphereGeometry(1000, 48, 24), skyMat);
skyMesh.frustumCulled = false;
skyMesh.renderOrder = -10;
scene.add(skyMesh);

// Image based lighting: render the same sky into a PMREM cube for car reflections.
function buildEnvironment() {
  if (scene.environment) scene.environment.dispose();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), skyMat));
  scene.environment = pmrem.fromScene(envScene, 0.02).texture;
  pmrem.dispose();
}
buildEnvironment();

/* ===================================================================
   3. LIGHTING + SHADOWS
   =================================================================== */
const ambient = new THREE.AmbientLight(col(0x6a5a7a), 0.45);
const hemi = new THREE.HemisphereLight(col(0xffb07a), col(0x3a2a30), 0.55);
scene.add(ambient, hemi);

const sun = new THREE.DirectionalLight(col(0xffa86a), 2.6);
sun.castShadow = true;
sun.shadow.mapSize.set(CONFIG.shadowMapSize, CONFIG.shadowMapSize);
{
  const e = CONFIG.shadowExtent, c = sun.shadow.camera;
  c.left = -e; c.right = e; c.top = e; c.bottom = -e; c.near = 1; c.far = 520;
}
sun.shadow.bias = -0.0003;
sun.shadow.normalBias = 0.04;
scene.add(sun, sun.target);

const _sr = new THREE.Vector3(), _su = new THREE.Vector3(), _sp = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _sd = SUN_DIR.clone().negate();
// Keep the shadow frustum glued to the car, snapped to shadow-map texels (no shimmer).
function updateSun(cx, cz) {
  const texel = (2 * CONFIG.shadowExtent) / CONFIG.shadowMapSize;
  _sr.crossVectors(_sd, _up).normalize();
  _su.crossVectors(_sr, _sd).normalize();
  _sp.set(cx, 0, cz);
  const px = Math.floor(_sp.dot(_sr) / texel) * texel;
  const py = Math.floor(_sp.dot(_su) / texel) * texel;
  const pd = _sp.dot(_sd);
  _sp.set(0, 0, 0).addScaledVector(_sr, px).addScaledVector(_su, py).addScaledVector(_sd, pd);
  sun.target.position.copy(_sp);
  sun.position.copy(_sp).addScaledVector(SUN_DIR, 260);
  sun.target.updateMatrixWorld();
}

/* ===================================================================
   4. PROCEDURAL TEXTURES
   =================================================================== */
// ---- Asphalt: 24 m wide x 120 m long tile with lane paint, cracks, wear ----
function makeRoadTextures(withCrosswalk) {
  const W = 512, H = 2048, mx = W / 24, mz = H / SEG;
  const [c, g] = makeCanvas(W, H);
  const [b, bg] = makeCanvas(W, H);
  const px = (x) => (x + 12) * mx;

  g.fillStyle = '#2d2d32'; g.fillRect(0, 0, W, H);
  bg.fillStyle = '#808080'; bg.fillRect(0, 0, W, H);

  // tire wear in each lane
  for (const lx of [-10, -6, -2, 2, 6, 10]) {
    for (const off of [-0.85, 0.85]) {
      g.fillStyle = 'rgba(8,8,10,0.16)'; g.fillRect(px(lx + off) - 0.5 * mx, 0, 1.0 * mx, H);
      g.fillStyle = 'rgba(8,8,10,0.14)'; g.fillRect(px(lx + off) - 0.2 * mx, 0, 0.4 * mx, H);
    }
  }
  // repair patches
  for (let i = 0; i < 70; i++) {
    const w = rand(10, 90), h = rand(10, 140);
    const dark = Math.random() < 0.55;
    g.fillStyle = dark ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.035)';
    g.fillRect(rand(0, W), rand(0, H), w, h);
  }
  // cracks (colour + bump)
  for (let i = 0; i < 30; i++) {
    let x = rand(0, W), y = rand(0, H);
    g.strokeStyle = 'rgba(5,5,6,0.7)'; g.lineWidth = rand(0.8, 1.8);
    bg.strokeStyle = '#303030'; bg.lineWidth = g.lineWidth;
    g.beginPath(); bg.beginPath(); g.moveTo(x, y); bg.moveTo(x, y);
    for (let k = 0; k < 8; k++) {
      x += rand(-18, 18); y += rand(8, 40);
      g.lineTo(x, y); bg.lineTo(x, y);
    }
    g.stroke(); bg.stroke();
  }

  // paint: draws to colour + bump together
  const paint = (style, x, y, w, h) => {
    g.fillStyle = style; g.fillRect(x, y, w, h);
    bg.fillStyle = '#9c9c9c'; bg.fillRect(x, y, w, h);
  };
  // double yellow centre line
  paint('#d6a21a', px(-0.30), 0, 0.11 * mx, H);
  paint('#d6a21a', px(0.19), 0, 0.11 * mx, H);
  // solid white edge lines
  paint('#dcdcd6', px(-11.65), 0, 0.15 * mx, H);
  paint('#dcdcd6', px(11.50), 0, 0.15 * mx, H);
  // dashed white lane lines: 3 m dash, 9 m gap
  for (const lx of [-8, -4, 4, 8]) {
    for (let i = 0; i < 10; i++) {
      paint('#dcdcd6', px(lx) - 0.075 * mx, i * 12 * mz + 20, 0.15 * mx, 3 * mz);
    }
  }
  // zebra crossing and stop bars
  if (withCrosswalk) {
    const yC = H * 0.30;
    g.fillStyle = '#2d2d32'; g.fillRect(0, yC - 3 * mz, W, 6 * mz);
    bg.fillStyle = '#808080'; bg.fillRect(0, yC - 3 * mz, W, 6 * mz);
    for (let x = -11; x <= 10.6; x += 1.0) paint('#e4e4de', px(x), yC - 1.5 * mz, 0.5 * mx, 3 * mz);
    paint('#e4e4de', px(-11.65), yC - 4.4 * mz, 11.3 * mx, 0.5 * mz);
    paint('#e4e4de', px(0.35), yC + 3.9 * mz, 11.2 * mx, 0.5 * mz);
  }
  addNoise(g, W, H, 24);
  addNoise(bg, W, H, 70);

  return { map: canvasTex(c), bump: canvasTex(b, { linear: true }) };
}

// ---- Sidewalk and ground ----
function makeSidewalkTexture() {
  const [c, g] = makeCanvas(256, 256);
  g.fillStyle = '#b8b2a7'; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 40; i++) {
    g.fillStyle = `rgba(${Math.random() < 0.5 ? '0,0,0' : '255,255,255'},0.05)`;
    g.fillRect(rand(0, 256), rand(0, 256), rand(10, 60), rand(10, 60));
  }
  g.strokeStyle = 'rgba(70,64,56,0.8)'; g.lineWidth = 4; g.strokeRect(0, 0, 256, 256);
  addNoise(g, 256, 256, 22);
  return canvasTex(c, { repeat: [2, SEG / 2.5] });
}
function makeGroundTexture() {
  const [c, g] = makeCanvas(256, 256);
  g.fillStyle = '#403c38'; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 60; i++) {
    g.fillStyle = `rgba(${Math.random() < 0.5 ? '0,0,0' : '255,240,220'},0.06)`;
    g.fillRect(rand(0, 256), rand(0, 256), rand(8, 70), rand(8, 70));
  }
  addNoise(g, 256, 256, 26);
  return canvasTex(c, { repeat: [25, 6] });
}

// ---- Palm trunk + frond ----
function makeTrunkTexture() {
  const [c, g] = makeCanvas(64, 256);
  g.fillStyle = '#85705a'; g.fillRect(0, 0, 64, 256);
  for (let y = 0; y < 256; y += 14) {
    g.fillStyle = 'rgba(40,28,20,0.55)'; g.fillRect(0, y, 64, 3);
    g.fillStyle = 'rgba(255,230,200,0.12)'; g.fillRect(0, y + 3, 64, 2);
  }
  addNoise(g, 64, 256, 30);
  return canvasTex(c, { repeat: [1, 18] });
}
function makeFrondTexture() {
  const [c, g] = makeCanvas(128, 512);
  g.clearRect(0, 0, 128, 512);
  g.strokeStyle = '#4a5a1c'; g.lineWidth = 3;
  g.beginPath(); g.moveTo(64, 512); g.lineTo(64, 0); g.stroke();
  for (let y = 500; y > 8; y -= 7) {
    const t = y / 512;
    const len = 56 * (0.35 + 0.65 * Math.sin(Math.PI * Math.pow(1 - t, 0.6) * 0.98 + 0.12));
    const shade = Math.floor(rand(70, 120));
    g.strokeStyle = `rgb(${shade * 0.55},${shade + 40},${shade * 0.3})`;
    g.lineWidth = 2.2;
    for (const s of [-1, 1]) {
      g.beginPath(); g.moveTo(64, y);
      g.lineTo(64 + s * len, y - len * 0.55);
      g.stroke();
    }
  }
  return canvasTex(c);
}

// ---- Buildings: stucco wall + sunset-reflecting windows + lit-window emissive ----
function makeBuildingTexture(wall) {
  const S = 256, cell = 64;
  const [c, g] = makeCanvas(S, S);
  const [e, eg] = makeCanvas(S, S);
  g.fillStyle = wall; g.fillRect(0, 0, S, S);
  eg.fillStyle = '#000'; eg.fillRect(0, 0, S, S);
  for (let cy = 0; cy < 4; cy++) {
    for (let cx = 0; cx < 4; cx++) {
      const x = cx * cell + 10, y = cy * cell + 12, w = cell - 20, h = cell - 24;
      const grd = g.createLinearGradient(0, y, 0, y + h);
      grd.addColorStop(0, '#f0a060'); grd.addColorStop(0.45, '#5a5f78'); grd.addColorStop(1, '#1d2233');
      g.fillStyle = grd; g.fillRect(x, y, w, h);
      g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(x - 2, y + h, w + 4, 3);
      g.fillStyle = 'rgba(255,255,255,0.16)'; g.fillRect(x + w / 2 - 1, y, 2, h);
      if (Math.random() < 0.28) {
        eg.fillStyle = Math.random() < 0.75 ? '#ffc46b' : '#9fd0ff';
        eg.fillRect(x, y, w, h);
      }
    }
  }
  addNoise(g, S, S, 14);
  return { map: canvasTex(c), emissive: canvasTex(e) };
}

// ---- Freeway signs ----
function makeSignTexture(variant) {
  const [c, g] = makeCanvas(512, 216);
  g.fillStyle = '#0a6b3f'; g.fillRect(0, 0, 512, 216);
  g.strokeStyle = '#f2f2ec'; g.lineWidth = 8;
  g.strokeRect(10, 10, 492, 196);
  g.fillStyle = '#f7f7f1';
  g.textBaseline = 'middle';
  const T = (txt, x, y, size, align) => {
    g.font = `bold ${size}px "Arial Narrow", Arial, sans-serif`;
    g.textAlign = align || 'left';
    g.fillText(txt, x, y);
  };
  const shield = (label, x, y) => {
    g.fillStyle = '#f7f7f1';
    g.beginPath(); g.moveTo(x, y - 52); g.lineTo(x + 46, y - 40); g.lineTo(x + 40, y + 30);
    g.lineTo(x, y + 52); g.lineTo(x - 40, y + 30); g.lineTo(x - 46, y - 40); g.closePath(); g.fill();
    g.fillStyle = '#111'; g.font = 'bold 44px Arial'; g.textAlign = 'center'; g.fillText(label, x, y);
    g.fillStyle = '#f7f7f1';
  };
  if (variant === 0) {
    shield('101', 80, 100);
    T('SOUTH', 150, 62, 56); T('Hollywood Fwy', 150, 116, 44); T('Downtown L.A.  6 mi', 150, 168, 38);
  } else if (variant === 1) {
    T('SUNSET BLVD', 256, 56, 62, 'center'); T('WEST', 256, 108, 46, 'center');
    T('Beverly Hills  4', 40, 160, 36); T('Pacific Palisades  14', 40, 192, 30);
  } else if (variant === 2) {
    T('EXIT  1/2 MILE', 256, 54, 54, 'center');
    T('Vine St', 40, 114, 48); T('Highland Ave', 40, 164, 44);
    T('\u25B6', 450, 130, 70, 'center');
  } else {
    shield('405', 80, 100);
    T('SOUTH', 150, 62, 56); T('LAX Airport  17 mi', 150, 118, 38); T('Santa Monica  11 mi', 150, 164, 38);
  }
  return canvasTex(c);
}

/* ===================================================================
   5. CAR MODEL  (2023 Toyota Camry TRD)
   =================================================================== */
const CAR = { L: 4.88, wheelbase: 2.82, zF: 1.43, zR: -1.39, track: 0.80, wheelR: 0.335 };

// Cardinal (Catmull-Rom style) Hermite spline through [z, value] knots.
function spline(k) {
  const n = k.length, m = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = k[Math.max(i - 1, 0)], b = k[Math.min(i + 1, n - 1)];
    m[i] = (b[1] - a[1]) / ((b[0] - a[0]) || 1);
  }
  return (z) => {
    if (z <= k[0][0]) return k[0][1];
    if (z >= k[n - 1][0]) return k[n - 1][1];
    let i = 0; while (z > k[i + 1][0]) i++;
    const h = k[i + 1][0] - k[i][0], t = (z - k[i][0]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * k[i][1] + (t3 - 2 * t2 + t) * h * m[i] +
           (-2 * t3 + 3 * t2) * k[i + 1][1] + (t3 - t2) * h * m[i + 1];
  };
}

// Loft a closed super-ellipse cross-section along Z. Stations: {z, hw, yb, yt}.
function loft(stations, o) {
  const N = o.ring || 40, ex = 2 / (o.n || 4), taper = o.taper || 0;
  const sp = (v) => Math.sign(v) * Math.pow(Math.abs(v), ex);
  const pos = [], idx = [];
  for (const s of stations) {
    const yc = (s.yb + s.yt) / 2, hh = (s.yt - s.yb) / 2;
    for (let k = 0; k < N; k++) {
      const a = (k / N) * Math.PI * 2;
      const cx = sp(Math.cos(a)), sn = sp(Math.sin(a));
      pos.push(s.hw * cx * (1 - taper * (sn * 0.5 + 0.5)), yc + hh * sn, s.z);
    }
  }
  const S = stations.length;
  for (let i = 0; i < S - 1; i++) {
    for (let k = 0; k < N; k++) {
      const A = i * N + k, B = i * N + (k + 1) % N, C = (i + 1) * N + (k + 1) % N, D = (i + 1) * N + k;
      idx.push(A, B, D, B, C, D);
    }
  }
  // end caps
  const capF = pos.length / 3; // front (+z) centre
  const f = stations[S - 1];
  pos.push(0, (f.yb + f.yt) / 2, f.z);
  const capR = pos.length / 3;
  const r = stations[0];
  pos.push(0, (r.yb + r.yt) / 2, r.z);
  for (let k = 0; k < N; k++) {
    const k1 = (k + 1) % N;
    idx.push(capF, (S - 1) * N + k, (S - 1) * N + k1);
    idx.push(capR, k1, k);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

let _carGeo = null;
function getCarGeo() {
  if (_carGeo) return _carGeo;
  const wc = CAR.wheelR, R = 0.43;
  const hwK = spline([[-2.45, .66], [-2.36, .79], [-2.15, .875], [-1.8, .918], [-1.2, .935], [0, .94], [1.0, .935], [1.7, .918], [2.15, .88], [2.38, .80], [2.45, .68]]);
  const ytK = spline([[-2.45, .80], [-2.38, .90], [-2.15, .975], [-1.7, 1.0], [-1.2, 1.01], [-0.5, 1.0], [0.3, .99], [0.95, .965], [1.5, .88], [2.0, .80], [2.35, .74], [2.45, .67]]);
  const ybK = spline([[-2.45, .43], [-2.3, .34], [-2.0, .30], [0, .27], [2.0, .30], [2.3, .34], [2.45, .41]]);

  const lower = [];
  for (let i = 0; i <= 70; i++) {
    const z = -2.45 + i * 0.07;
    let yb = ybK(z);
    for (const zc of [CAR.zF, CAR.zR]) {          // carve the wheel arches
      const dz = z - zc;
      if (Math.abs(dz) < R) yb = Math.max(yb, wc + Math.sqrt(R * R - dz * dz));
    }
    lower.push({ z, hw: hwK(z), yb, yt: ytK(z) });
  }

  const roofK = spline([[-1.5, 1.03], [-1.3, 1.12], [-1.0, 1.30], [-0.6, 1.415], [-0.1, 1.445], [0.3, 1.43], [0.6, 1.36], [0.9, 1.15], [1.1, 1.0]]);
  const cabHw = spline([[-1.5, .70], [-1.1, .77], [-0.5, .80], [0.3, .80], [0.8, .78], [1.1, .74]]);
  const cabin = [];
  for (let i = 0; i <= 26; i++) {
    const z = -1.5 + i * 0.1;
    cabin.push({ z, hw: cabHw(z), yb: 0.90, yt: roofK(z) });
  }
  const roof = [];
  for (let i = 0; i <= 16; i++) {
    const z = -1.12 + i * 0.1;
    const yt = roofK(z) + 0.012;
    const e = clamp(Math.min(z + 1.12, 0.48 - z) / 0.12, 0, 1);
    roof.push({ z, hw: (cabHw(z) * 0.80 + 0.01) * (0.9 + 0.1 * e), yb: yt - 0.075, yt });
  }
  _carGeo = {
    body: loft(lower, { ring: 48, n: 4.2, taper: 0.04 }),
    cabin: loft(cabin, { ring: 36, n: 3, taper: 0.22 }),
    roof: loft(roof, { ring: 28, n: 3.2, taper: 0 })
  };
  return _carGeo;
}

let _carMats = null;
function getCarMats() {
  if (_carMats) return _carMats;
  const grilleCanvas = (() => {
    const [c, g] = makeCanvas(512, 128);
    g.fillStyle = '#060607'; g.fillRect(0, 0, 512, 128);
    g.strokeStyle = '#34363c'; g.lineWidth = 2;
    for (let i = -128; i < 640; i += 14) {
      g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 128, 128); g.stroke();
      g.beginPath(); g.moveTo(i + 128, 0); g.lineTo(i, 128); g.stroke();
    }
    g.fillStyle = '#d3141c'; g.fillRect(222, 8, 68, 26);
    g.fillStyle = '#fff'; g.font = 'bold 20px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('TRD', 256, 21);
    return c;
  })();
  _carMats = {
    roof:   new THREE.MeshPhysicalMaterial({ color: col(0x050507), metalness: 0.2, roughness: 0.14, clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 1.7 }),
    glass:  new THREE.MeshPhysicalMaterial({ color: col(0x0a1018), metalness: 0.1, roughness: 0.05, clearcoat: 1, envMapIntensity: 2.2 }),
    black:  new THREE.MeshStandardMaterial({ color: col(0x0a0a0b), roughness: 0.65 }),
    gloss:  new THREE.MeshPhysicalMaterial({ color: col(0x050506), roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 1.4 }),
    chrome: new THREE.MeshStandardMaterial({ color: col(0xdadde2), metalness: 1, roughness: 0.08, envMapIntensity: 1.6 }),
    tire:   new THREE.MeshStandardMaterial({ color: col(0x101011), roughness: 0.92, envMapIntensity: 0.2 }),
    rim:    new THREE.MeshStandardMaterial({ color: col(0x2c3037), metalness: 0.9, roughness: 0.26, envMapIntensity: 1.3 }),
    lip:    new THREE.MeshStandardMaterial({ color: col(0xc6cad0), metalness: 1, roughness: 0.18, envMapIntensity: 1.4 }),
    disc:   new THREE.MeshStandardMaterial({ color: col(0x8d9096), metalness: 0.9, roughness: 0.4 }),
    caliper:new THREE.MeshPhysicalMaterial({ color: col(0xe0141a), metalness: 0.3, roughness: 0.32, clearcoat: 1 }),
    red:    new THREE.MeshStandardMaterial({ color: col(0xd3141c), roughness: 0.4 }),
    grille: new THREE.MeshStandardMaterial({ map: canvasTex(grilleCanvas), roughness: 0.55, metalness: 0.3 }),
    plate:  new THREE.MeshStandardMaterial({ color: col(0xe8e8e2), roughness: 0.6 })
  };
  return _carMats;
}

function buildWheel(M, detail) {
  const steer = new THREE.Group();
  const spin = new THREE.Group();
  steer.add(spin);
  const add = (geo, mat, parent, x, y, z) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x || 0, y || 0, z || 0);
    m.castShadow = true;
    (parent || spin).add(m);
    return m;
  };
  if (!detail) {
    add(new THREE.CylinderGeometry(0.335, 0.335, 0.235, 16).rotateZ(Math.PI / 2), M.tire);
    add(new THREE.CylinderGeometry(0.2, 0.2, 0.24, 12).rotateZ(Math.PI / 2), M.rim);
    return { steer, spin };
  }
  // tire (lathe profile, rolled onto the X axis)
  const prof = [[.225, -.110], [.262, -.118], [.30, -.118], [.33, -.105], [.340, -.07], [.342, 0], [.340, .07], [.33, .105], [.30, .118], [.262, .118], [.225, .110]]
    .map((p) => new THREE.Vector2(p[0], p[1]));
  add(new THREE.LatheGeometry(prof, 36).rotateZ(Math.PI / 2), M.tire);
  // rim barrel + machined lip
  add(new THREE.CylinderGeometry(0.226, 0.226, 0.20, 28, 1, true).rotateZ(Math.PI / 2), M.black);
  add(new THREE.TorusGeometry(0.232, 0.013, 8, 40).rotateY(Math.PI / 2), M.lip, spin, 0.084, 0, 0);
  // brake disc rotates with the wheel
  add(new THREE.CylinderGeometry(0.175, 0.175, 0.026, 32).rotateZ(Math.PI / 2), M.disc, spin, 0.02, 0, 0);
  // five double-spoke design
  const spokeGeo = new THREE.BoxGeometry(0.022, 0.17, 0.034).translate(0, 0.125, 0);
  for (let i = 0; i < 5; i++) {
    for (const off of [-0.11, 0.11]) {
      const s = add(spokeGeo, M.rim, spin, 0.076, 0, 0);
      s.rotation.x = i * (Math.PI * 2 / 5) + off;
    }
  }
  add(new THREE.CylinderGeometry(0.052, 0.052, 0.022, 20).rotateZ(Math.PI / 2), M.gloss, spin, 0.088, 0, 0);
  add(new THREE.TorusGeometry(0.048, 0.006, 6, 20).rotateY(Math.PI / 2), M.red, spin, 0.1, 0, 0);
  // red caliper stays with the hub (does not spin)
  add(new THREE.BoxGeometry(0.07, 0.15, 0.17), M.caliper, steer, 0.04, 0.10, -0.14);
  return { steer, spin };
}

// Builds a whole car. detail=false makes a cheaper version for traffic.
function buildCar(opts) {
  const detail = opts.detail !== false;
  const geo = getCarGeo(), M = getCarMats();
  const sh = opts.shape || { xs: 1, ys: 1, zs: 1 };
  const root = new THREE.Group();
  const body = new THREE.Group();          // pitch / roll applied here
  root.add(body);
  const shell = new THREE.Group();         // hidden if a GLB replaces the procedural car
  body.add(shell);
  shell.scale.set(sh.xs, sh.ys, sh.zs);

  const paintMat = new THREE.MeshPhysicalMaterial({
    color: col(opts.paint), metalness: 0.55, roughness: 0.32,
    clearcoat: 1, clearcoatRoughness: 0.04, envMapIntensity: 1.4
  });
  const tailMat = new THREE.MeshStandardMaterial({ color: col(0x7a0a10), emissive: col(0xff1010), emissiveIntensity: 0.5, roughness: 0.3 });
  const headMat = new THREE.MeshStandardMaterial({ color: col(0xe8edf5), emissive: col(0xfff2dc), emissiveIntensity: 1.2, roughness: 0.2 });

  const mesh = (g, m, x, y, z, parent) => {
    const o = new THREE.Mesh(g, m);
    o.position.set(x || 0, y || 0, z || 0);
    o.castShadow = true; o.receiveShadow = true;
    (parent || shell).add(o);
    return o;
  };
  const box = (w, h, d, m, x, y, z, parent) => mesh(new THREE.BoxGeometry(w, h, d), m, x, y, z, parent);

  mesh(geo.body, paintMat);
  mesh(geo.cabin, M.glass);
  mesh(geo.roof, opts.blackRoof === false ? paintMat : M.roof);
  box(1.2, 0.26, 4.4, M.black, 0, 0.30, 0);              // underbody, visible through the arches

  // lights (all cars)
  box(1.0, 0.035, 0.05, tailMat, 0, 0.865, -2.43);                    // LED light bar
  for (const s of [-1, 1]) {
    const tl = box(0.52, 0.11, 0.07, tailMat, s * 0.62, 0.86, -2.39);
    tl.rotation.y = -s * 0.28;
    const hl = box(0.44, 0.10, 0.10, M.black, s * 0.62, 0.66, 2.36);
    hl.rotation.y = s * 0.30;
    const drl = box(0.40, 0.03, 0.02, headMat, s * 0.62, 0.66, 2.41);
    drl.rotation.y = s * 0.30;
  }

  if (detail) {
    // aggressive TRD front end: mesh grille, lower splitter, red accent
    const grille = new THREE.Mesh(new THREE.PlaneGeometry(1.14, 0.27), M.grille);
    grille.position.set(0, 0.54, 2.452);
    shell.add(grille);
    box(1.22, 0.33, 0.01, M.black, 0, 0.54, 2.447);
    box(1.58, 0.04, 0.34, M.gloss, 0, 0.30, 2.30);
    box(1.52, 0.014, 0.012, M.red, 0, 0.325, 2.475);
    // rear diffuser, red fins, dual exhaust
    box(1.32, 0.13, 0.30, M.gloss, 0, 0.40, -2.33);
    for (const s of [-1, 1]) {
      box(0.03, 0.10, 0.28, M.red, s * 0.46, 0.40, -2.33);
      const tip = mesh(new THREE.CylinderGeometry(0.058, 0.052, 0.22, 20).rotateX(Math.PI / 2), M.chrome, s * 0.60, 0.33, -2.40);
      tip.castShadow = true;
      mesh(new THREE.CircleGeometry(0.044, 16), M.black, s * 0.60, 0.33, -2.512).rotation.y = Math.PI;
    }
    // rear wing spoiler on two uprights
    for (const s of [-1, 1]) box(0.04, 0.10, 0.07, M.gloss, s * 0.45, 1.02, -2.13);
    const wing = box(1.34, 0.035, 0.22, M.gloss, 0, 1.085, -2.17);
    wing.rotation.x = 0.10;
    for (const s of [-1, 1]) box(0.02, 0.075, 0.22, M.gloss, s * 0.67, 1.095, -2.17);
    box(0.50, 0.12, 0.012, M.plate, 0, 0.68, -2.46);
    // door seams, handles, mirrors
    for (const s of [-1, 1]) {
      for (const z of [0.98, -0.06, -1.06]) box(0.012, 0.50, 0.008, M.black, s * 0.925, 0.74, z);
      for (const z of [0.55, -0.52]) box(0.02, 0.024, 0.17, M.chrome, s * 0.93, 0.90, z);
      const mir = box(0.20, 0.12, 0.14, paintMat, s * 0.98, 1.04, 0.80);
      mir.rotation.y = s * 0.2;
    }
  }

  // wheels
  const wheels = [];
  const wheelDefs = [[1, CAR.zF, true], [-1, CAR.zF, true], [1, CAR.zR, false], [-1, CAR.zR, false]];
  for (const w of wheelDefs) {
    const wh = buildWheel(M, detail);
    wh.steer.position.set(w[0] * CAR.track * sh.xs, CAR.wheelR, w[1] * sh.zs);
    if (w[0] < 0) wh.steer.scale.x = -1;     // mirror so the nicer face points outward
    wh.front = w[2];
    body.add(wh.steer);
    wheels.push(wh);
  }

  let spots = null;
  if (opts.player) {
    spots = [];
    for (const s of [-1, 1]) {
      const sp = new THREE.SpotLight(col(0xfff0d6), 1.6, 70, 0.5, 0.6, 1.4);
      sp.position.set(s * 0.62, 0.7, 2.3);
      sp.target.position.set(s * 0.62, 0.2, 30);
      body.add(sp, sp.target);
      spots.push(sp);
    }
  }
  return { root, body, shell, wheels, paintMat, tailMat, headMat, spots };
}

// Optional: swap the procedural car for a glTF model (nose toward +Z, ~4.9 m long).
function tryLoadGLB(url, car) {
  if (!url) return;
  new THREE.GLTFLoader().load(url, (gltf) => {
    const m = gltf.scene;
    m.rotation.y = rad(CONFIG.modelYawDeg);
    m.updateMatrixWorld(true);
    let box = new THREE.Box3().setFromObject(m);
    const size = box.getSize(new THREE.Vector3());
    m.scale.setScalar(CAR.L / Math.max(size.x, size.z));
    m.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(m);
    const c = box.getCenter(new THREE.Vector3());
    m.position.set(-c.x, -box.min.y, -c.z);
    m.traverse((o) => {
      if (o.isMesh) { o.castShadow = o.receiveShadow = true; if (o.material) o.material.envMapIntensity = 1.3; }
    });
    car.shell.visible = false;
    car.wheels.forEach((w) => { w.steer.visible = false; });
    car.body.add(m);
  }, undefined, (err) => console.warn('GLB not loaded, keeping procedural Camry:', err));
}

/* ===================================================================
   6. BACKDROP: hills + Hollywood sign (follow the camera)
   =================================================================== */
const backdrop = new THREE.Group();
scene.add(backdrop);
const ridgeH = (a) => 70 + 25 * Math.sin(3 * a + 1) + 18 * Math.sin(7 * a + 2) + 10 * Math.sin(13 * a);

const hillMeshes = [];
(function buildHills() {
  const mk = (radius, scale, top, bottom) => {
    const [c, g] = makeCanvas(4, 128);
    const grd = g.createLinearGradient(0, 0, 0, 128);
    grd.addColorStop(0, top); grd.addColorStop(1, bottom);
    g.fillStyle = grd; g.fillRect(0, 0, 4, 128);
    const geo = new THREE.CylinderGeometry(radius, radius, 1, 192, 1, true);
    const p = geo.attributes.position, n = 193;
    for (let i = 0; i < p.count; i++) {
      const a = Math.atan2(p.getX(i), p.getZ(i));
      p.setY(i, i < n ? ridgeH(a) * scale : -20);
    }
    geo.computeBoundingSphere();
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: canvasTex(c), side: THREE.BackSide, fog: false }));
    m.frustumCulled = false;
    return m;
  };
  hillMeshes.push(mk(900, 1.0, '#6c3d52', '#e98a58'), mk(650, 0.55, '#3d2a44', '#c8714f'));
  hillMeshes.forEach((m) => backdrop.add(m));

  const [c, g] = makeCanvas(1024, 128);
  g.fillStyle = '#fff4ea'; g.font = 'bold 118px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('HOLLYWOOD', 512, 66);
  const a = 0.45;
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(130, 16),
    new THREE.MeshBasicMaterial({ map: canvasTex(c), transparent: true, fog: false, color: new THREE.Color(1, 0.8, 0.7) }));
  sign.position.set(Math.sin(a) * 880, ridgeH(a) * 0.85, Math.cos(a) * 880);
  sign.lookAt(0, sign.position.y, 0);
  backdrop.add(sign);
  backdrop.userData.sign = sign;
})();

/* ===================================================================
   7. ROAD SEGMENTS: asphalt, sidewalks, palms, street lights, signs, buildings
   =================================================================== */
const roadTex = [makeRoadTextures(false), makeRoadTextures(true)];
const roadMats = roadTex.map((t) => new THREE.MeshStandardMaterial({
  map: t.map, bumpMap: t.bump, bumpScale: 1.6, roughness: 0.82, metalness: 0, envMapIntensity: 0.4
}));
const walkMat = new THREE.MeshStandardMaterial({ map: makeSidewalkTexture(), roughness: 0.9, envMapIntensity: 0.25 });
const groundMat = new THREE.MeshStandardMaterial({ map: makeGroundTexture(), roughness: 0.95, envMapIntensity: 0.15 });

const roadGeo = new THREE.PlaneGeometry(24, SEG).rotateX(-Math.PI / 2);
const groundGeo = new THREE.PlaneGeometry(500, SEG).rotateX(-Math.PI / 2);
const walkGeo = new THREE.BoxGeometry(5, 0.16, SEG).translate(0, 0.08, 0);

// palms (instanced trunk + instanced frond crowns)
const trunkGeo = new THREE.CylinderGeometry(0.15, 0.30, 1, 10, 1, true).translate(0, 0.5, 0);
const trunkMat = new THREE.MeshStandardMaterial({ map: makeTrunkTexture(), roughness: 0.95, envMapIntensity: 0.2 });
const frondTex = makeFrondTexture();
const frondMat = new THREE.MeshStandardMaterial({ map: frondTex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.75, envMapIntensity: 0.4 });
const frondDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: frondTex, alphaTest: 0.5, side: THREE.DoubleSide });
const frondGeo = (function () {
  const pos = [], uv = [], idx = [];
  const FR = 15, SEGS = 7;
  for (let f = 0; f < FR; f++) {
    const yaw = (f / FR) * Math.PI * 2 + rand(-0.15, 0.15);
    const e0 = rad(lerp(75, 15, (f % 5) / 4) + rand(-8, 8));   // initial elevation
    const bend = rad(rand(70, 105));
    const L = rand(3.8, 4.8);
    const dir = [Math.sin(yaw), Math.cos(yaw)], side = [Math.cos(yaw), -Math.sin(yaw)];
    let r = 0, y = 0;
    const base = pos.length / 3;
    for (let s = 0; s <= SEGS; s++) {
      const t = s / SEGS;
      const w = 0.12 + 0.95 * Math.sin(Math.PI * Math.pow(t, 0.7));
      for (const sd of [-1, 1]) {
        pos.push(dir[0] * r + side[0] * sd * w * 0.5, y, dir[1] * r + side[1] * sd * w * 0.5);
        uv.push(sd < 0 ? 0 : 1, t);
      }
      const e = e0 - bend * t;
      r += Math.cos(e) * L / SEGS; y += Math.sin(e) * L / SEGS;
    }
    for (let s = 0; s < SEGS; s++) {
      const a = base + s * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
})();

// street lights (instanced)
const poleMat = new THREE.MeshStandardMaterial({ color: col(0x3c3f45), metalness: 0.7, roughness: 0.5 });
const lampMat = new THREE.MeshStandardMaterial({ color: col(0xffe2b0), emissive: col(0xffb866), emissiveIntensity: 1.6 });
const poleGeo = new THREE.CylinderGeometry(0.07, 0.11, 9, 8).translate(0, 4.5, 0);
const armGeo = new THREE.BoxGeometry(2.2, 0.08, 0.08).translate(1.1, 8.85, 0);
const headGeo = new THREE.BoxGeometry(0.9, 0.12, 0.34).translate(2.0, 8.74, 0);

// freeway gantry
const gantryMat = new THREE.MeshStandardMaterial({ color: col(0x7b7f86), metalness: 0.6, roughness: 0.5 });
const signTex = [0, 1, 2, 3].map(makeSignTexture);
const signGeo = new THREE.PlaneGeometry(7.6, 3.2);
const signBodyGeo = new THREE.BoxGeometry(7.7, 3.3, 0.12);

// buildings
const wallColors = ['#d9c7a7', '#e9e3d6', '#c98c70', '#8f9aa6', '#e2b7a0', '#b5a58c'];
const buildingMats = wallColors.map((w) => {
  const t = makeBuildingTexture(w);
  return new THREE.MeshStandardMaterial({
    map: t.map, emissiveMap: t.emissive, emissive: new THREE.Color(1, 1, 1), emissiveIntensity: 0.7,
    roughness: 0.85, envMapIntensity: 0.3
  });
});
function buildingGeo(w, h, d) {
  const g = new THREE.BoxGeometry(w, h, d).translate(0, h / 2, 0);
  const uv = g.attributes.uv, T = 16;
  for (let i = 0; i < uv.count; i++) {
    const face = Math.floor(i / 4);
    let su, sv;
    if (face < 2) { su = d / T; sv = h / T; } else if (face < 4) { su = w / T; sv = d / T; } else { su = w / T; sv = h / T; }
    uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  }
  return g;
}
const nearVariants = [], farVariants = [];
for (const w of [18, 22, 26]) for (const h of [9, 13, 17, 22]) nearVariants.push({ w, h, d: 16, geo: buildingGeo(w, h, 16) });
for (const w of [26, 32, 36]) for (const h of [35, 60, 90, 130]) farVariants.push({ w, h, d: 30, geo: buildingGeo(w, h, 30) });
const nearTall = nearVariants.filter((v) => v.h >= 17);
const nearLow = nearVariants.filter((v) => v.h <= 13);
const farTall = farVariants.filter((v) => v.h >= 60);
const farRock = farVariants.filter((v) => v.h >= 35 && v.h <= 60);

// route extras: cliffs, beach + ocean, night lamp pools
const rockMat = (function () {
  const [c, g] = makeCanvas(256, 256);
  g.fillStyle = '#8a7358'; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 90; i++) {
    g.fillStyle = `rgba(${Math.random() < 0.5 ? '40,25,10' : '255,225,180'},0.10)`;
    g.fillRect(rand(0, 256), rand(0, 256), rand(8, 90), rand(4, 30));
  }
  addNoise(g, 256, 256, 30);
  return new THREE.MeshStandardMaterial({ map: canvasTex(c), roughness: 1, envMapIntensity: 0.15 });
})();
const sandGeo = new THREE.PlaneGeometry(20, SEG).rotateX(-Math.PI / 2);
const sandMat = new THREE.MeshStandardMaterial({ color: col(0xd8c08e), roughness: 1, envMapIntensity: 0.2 });
const waterGeo = new THREE.PlaneGeometry(320, SEG).rotateX(-Math.PI / 2);
const waterMat = new THREE.MeshStandardMaterial({ color: col(0x1d5f86), metalness: 0.55, roughness: 0.12, envMapIntensity: 1.6 });
const poolGeo = new THREE.PlaneGeometry(15, 15).rotateX(-Math.PI / 2);
const poolMat = (function () {
  const [c, g] = makeCanvas(128, 128);
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.4, 'rgba(255,255,255,0.35)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  return new THREE.MeshBasicMaterial({ map: t, color: col(0xffc477), transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending });
})();

const segments = [];
const _dummy = new THREE.Object3D();

function createSegment(index) {
  const group = new THREE.Group();
  const seg = { index, group, obstacles: [], gantryObs: [], near: [], far: [] };

  seg.road = new THREE.Mesh(roadGeo, roadMats[0]);
  seg.road.receiveShadow = true;
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.position.y = -0.03; ground.receiveShadow = true;
  group.add(seg.road, ground);
  seg.sand = new THREE.Mesh(sandGeo, sandMat); seg.sand.position.set(-27, -0.02, 0); seg.sand.receiveShadow = true;
  seg.water = new THREE.Mesh(waterGeo, waterMat); seg.water.position.set(-197, -0.01, 0);
  seg.sand.visible = seg.water.visible = false;
  group.add(seg.sand, seg.water);
  for (const s of [-1, 1]) {
    const w = new THREE.Mesh(walkGeo, walkMat);
    w.position.x = s * 14.5; w.receiveShadow = true;
    group.add(w);
  }

  // palms: 6 per side
  const palmCount = 12;
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, palmCount);
  const crowns = new THREE.InstancedMesh(frondGeo, frondMat, palmCount);
  trunks.castShadow = crowns.castShadow = true;
  trunks.receiveShadow = true;
  crowns.customDepthMaterial = frondDepth;
  trunks.frustumCulled = crowns.frustumCulled = false;
  let n = 0;
  for (const side of [-1, 1]) {
    for (let i = 0; i < 6; i++) {
      const x = side * (14.6 + rand(-0.4, 0.4)), z = -50 + i * 20 + rand(-2, 2);
      const h = rand(10, 15), s = rand(0.9, 1.2);
      _dummy.position.set(x, 0.16, z);
      _dummy.rotation.set(rand(-0.05, 0.05), rand(0, 6.28), rand(-0.07, 0.07), 'YXZ');
      _dummy.scale.set(s, h, s);
      _dummy.updateMatrix();
      trunks.setMatrixAt(n, _dummy.matrix);
      const top = new THREE.Vector3(0, h, 0).applyQuaternion(_dummy.quaternion).add(_dummy.position);
      const cs = rand(0.95, 1.3);
      _dummy.position.copy(top);
      _dummy.scale.set(cs, cs, cs);
      _dummy.updateMatrix();
      crowns.setMatrixAt(n, _dummy.matrix);
      seg.obstacles.push({ x, z, r: 0.32, palm: true });
      n++;
    }
  }
  group.add(trunks, crowns);
  seg.trunks = trunks; seg.crowns = crowns;

  // street lights: 4 per side
  const polesI = new THREE.InstancedMesh(poleGeo, poleMat, 8);
  const armsI = new THREE.InstancedMesh(armGeo, poleMat, 8);
  const headsI = new THREE.InstancedMesh(headGeo, lampMat, 8);
  const pools = new THREE.InstancedMesh(poolGeo, poolMat, 8);
  pools.frustumCulled = false; pools.visible = false; seg.pools = pools;
  polesI.castShadow = armsI.castShadow = true;
  polesI.frustumCulled = armsI.frustumCulled = headsI.frustumCulled = false;
  n = 0;
  for (const side of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const x = side * 13.2, z = -45 + i * 30;
      _dummy.position.set(x, 0.16, z);
      _dummy.rotation.set(0, side > 0 ? Math.PI : 0, 0);
      _dummy.scale.set(1, 1, 1);
      _dummy.updateMatrix();
      polesI.setMatrixAt(n, _dummy.matrix); armsI.setMatrixAt(n, _dummy.matrix); headsI.setMatrixAt(n, _dummy.matrix);
      _dummy.position.set(side * 10.4, 0.05, z); _dummy.rotation.set(0, 0, 0); _dummy.scale.set(1, 1, 1); _dummy.updateMatrix();
      pools.setMatrixAt(n, _dummy.matrix);
      seg.obstacles.push({ x, z, r: 0.16 });
      n++;
    }
  }
  group.add(polesI, armsI, headsI, pools);

  // overhead freeway-style sign gantry
  const gantry = new THREE.Group();
  gantry.position.z = 40;
  for (const s of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.5, 8.2, 0.5), gantryMat);
    post.position.set(s * 13.6, 4.1, 0); post.castShadow = true; gantry.add(post);
    seg.gantryObs.push({ x: s * 13.6, z: 40, r: 0.4 });
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(27.6, 0.6, 0.7), gantryMat);
  beam.position.y = 8.1; beam.castShadow = true; gantry.add(beam);
  seg.signs = [];
  for (const sx of [-6.5, 6.5]) {
    const body = new THREE.Mesh(signBodyGeo, gantryMat);
    body.position.set(sx, 6.15, 0); body.castShadow = true; gantry.add(body);
    for (const face of [-1, 1]) {
      const m = new THREE.Mesh(signGeo, new THREE.MeshStandardMaterial({ map: signTex[0], emissiveMap: signTex[0], emissive: new THREE.Color(0.35, 0.35, 0.35), roughness: 0.5 }));
      m.position.set(sx, 6.15, face * 0.07);
      m.rotation.y = face < 0 ? Math.PI : 0;
      gantry.add(m);
      seg.signs.push(m);
    }
  }
  group.add(gantry);
  seg.gantry = gantry;

  // building slots
  for (let i = 0; i < 8; i++) {
    const m = new THREE.Mesh(nearVariants[0].geo, buildingMats[0]);
    m.castShadow = true; m.receiveShadow = true;
    group.add(m); seg.near.push(m);
  }
  for (let i = 0; i < 6; i++) {
    const m = new THREE.Mesh(farVariants[0].geo, buildingMats[0]);
    group.add(m); seg.far.push(m);
  }
  scene.add(group);
  segments.push(seg);
  placeSegment(seg, index);
  return seg;
}

// (Re)assign what lives in a segment slot when it moves to a new index.
function placeSegment(seg, index) {
  const R = currentRoute;
  seg.index = index;
  seg.group.position.z = index * SEG;
  seg.road.material = roadMats[mod(index, 2) === 1 ? 1 : 0];
  seg.trunks.visible = seg.crowns.visible = R.palms;
  seg.palmsOn = R.palms;
  seg.sand.visible = seg.water.visible = R.ocean;
  seg.pools.visible = R.night;

  const hasGantry = R.gantry && mod(index, 3) === 0;
  seg.gantry.visible = hasGantry;
  if (hasGantry) {
    seg.signs.forEach((m, i) => {
      const t = signTex[mod(index + i, signTex.length)];
      m.material.map = t; m.material.emissiveMap = t;
    });
  }
  const coast = R.bld === 'coast';
  const nearPool = R.bld === 'tall' ? nearTall : coast ? nearLow : nearVariants;
  const farPool = R.bld === 'tall' ? farTall : coast ? farRock : farVariants;
  let k = 0;
  for (const side of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const m = seg.near[k++], v = pick(nearPool);
      m.visible = !(coast && side < 0);
      m.geometry = v.geo; m.material = pick(buildingMats);
      m.userData.w = v.w; m.userData.d = v.d;
      m.position.set(side * (18.8 + v.d / 2), 0, -45 + i * 30 + rand(-1.5, 1.5));
    }
  }
  k = 0;
  for (const side of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const m = seg.far[k++], v = pick(farPool);
      m.visible = !(coast && side < 0);
      m.geometry = v.geo; m.material = coast ? rockMat : pick(buildingMats);
      m.position.set(side * (coast ? rand(36, 52) : rand(70, 105)), 0, -40 + i * 40 + rand(-4, 4));
    }
  }
}

function initSegments() {
  const half = Math.floor(CONFIG.segCount / 2);
  for (let i = -half; i <= half; i++) createSegment(i);
}
function updateSegments(z) {
  const center = Math.round(z / SEG), half = Math.floor(CONFIG.segCount / 2), N = CONFIG.segCount;
  for (const seg of segments) {
    let idx = seg.index;
    if (idx < center - half) idx += N; else if (idx > center + half) idx -= N;
    if (idx !== seg.index) placeSegment(seg, idx);
  }
}

/* ===================================================================
   8. TRAFFIC
   =================================================================== */
const traffic = [];
const TRAFFIC_COLORS = [0x2a2d33, 0xd8d8d4, 0x6b1f1f, 0x20324f, 0x8a8f96, 0x1d4d3a, 0xc9a227];
const OFFS = [-1.35, 0, 1.35];

function respawnNPC(n, ahead) {
  const oncoming = Math.random() < 0.45;
  const lane = pick([2, 6, 10]) * (oncoming ? 1 : -1);
  for (let tries = 0; tries < 8; tries++) {
    n.z = car.z + (ahead ? rand(260, 520) : -rand(120, 200));
    if (!traffic.some((o) => o !== n && Math.abs(o.x - lane) < 3 && Math.abs(o.z - n.z) < 25)) break;
  }
  n.x = lane + rand(-0.4, 0.4);
  n.dir = oncoming ? -1 : 1;
  n.speed = oncoming ? rand(14, 24) : rand(9, 22);
  n.cruise = n.speed;
  n.car.root.rotation.y = oncoming ? Math.PI : 0;
}
function initTraffic() {
  for (let i = 0; i < CONFIG.trafficCount; i++) {
    const c = buildCar({ paint: pick(TRAFFIC_COLORS), detail: false });
    c.root.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    scene.add(c.root);
    const n = { car: c, x: 0, z: 0, dir: 1, speed: 10, cruise: 10 };
    traffic.push(n);
    respawnNPC(n, true);
    n.z = car.z + 40 + i * 45;
  }
}
function updateTraffic(dt) {
  for (const n of traffic) {
    // follow-the-leader: slow down behind slower cars in the same lane
    let limit = n.cruise;
    if (n.dir > 0) {
      for (const o of traffic) {
        if (o !== n && o.dir > 0 && Math.abs(o.x - n.x) < 2 && o.z > n.z && o.z - n.z < 16) limit = Math.min(limit, o.speed);
      }
      if (Math.abs(car.x - n.x) < 2 && car.z > n.z && car.z - n.z < 16) limit = Math.min(limit, Math.max(0, carSpeedF()));
    }
    n.speed = damp(n.speed, limit, 2.5, dt);
    n.z += n.dir * n.speed * dt;
    if (n.z < car.z - 220 || n.z > car.z + 600) respawnNPC(n, n.z < car.z);
    n.car.root.position.set(n.x, 0, n.z);
  }
}
function carSpeedF() { return car.vx * Math.sin(car.yaw) + car.vz * Math.cos(car.yaw); }

/* ===================================================================
   9. SKID MARKS + TIRE SMOKE
   =================================================================== */
const Skids = (function () {
  const MAX = 1000;
  const geo = new THREE.PlaneGeometry(0.24, 0.6).rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({ color: 0x070707, transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const mesh = new THREE.InstancedMesh(geo, mat, MAX);
  mesh.frustumCulled = false;
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < MAX; i++) mesh.setMatrixAt(i, zero);
  scene.add(mesh);
  let cursor = 0;
  const last = [null, null];
  const d = new THREE.Object3D();
  return {
    mesh,
    add(i, x, z, heading) {
      const p = last[i];
      if (p && (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z) < 0.16) return;
      d.position.set(x, 0.02, z);
      d.rotation.set(0, heading, 0);
      d.scale.set(1, 1, 1.5);
      d.updateMatrix();
      mesh.setMatrixAt(cursor, d.matrix);
      cursor = (cursor + 1) % MAX;
      mesh.instanceMatrix.needsUpdate = true;
      last[i] = { x, z };
    },
    lift(i) { last[i] = null; }
  };
})();

const Smoke = (function () {
  const N = 160;
  const pos = new Float32Array(N * 3), alpha = new Float32Array(N), size = new Float32Array(N);
  const vel = new Float32Array(N * 3), life = new Float32Array(N), max = new Float32Array(N);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { scale: { value: window.innerHeight / 2 } },
    vertexShader: `
      attribute float aAlpha; attribute float aSize; uniform float scale; varying float vA;
      void main(){
        vA = aAlpha;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * scale / max(-mv.z, 0.5);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying float vA;
      void main(){
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float a = smoothstep(1.0, 0.0, d) * vA;
        if (a < 0.01) discard;
        gl_FragColor = vec4(vec3(0.88, 0.80, 0.74), a);
      }`
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  scene.add(pts);
  let cur = 0;
  return {
    mat,
    emit(x, y, z, vx, vz) {
      const i = cur; cur = (cur + 1) % N;
      pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
      vel[i * 3] = vx * 0.3 + rand(-0.6, 0.6); vel[i * 3 + 1] = rand(0.4, 1.2); vel[i * 3 + 2] = vz * 0.3 + rand(-0.6, 0.6);
      life[i] = max[i] = rand(0.9, 1.6); size[i] = rand(0.5, 0.8);
    },
    update(dt) {
      for (let i = 0; i < N; i++) {
        if (life[i] <= 0) { alpha[i] = 0; continue; }
        life[i] -= dt;
        pos[i * 3] += vel[i * 3] * dt; pos[i * 3 + 1] += vel[i * 3 + 1] * dt; pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
        vel[i * 3 + 1] *= 0.98;
        const t = life[i] / max[i];
        alpha[i] = Math.max(0, t) * 0.42;
        size[i] += dt * 1.1;
      }
      geo.attributes.position.needsUpdate = true;
      geo.attributes.aAlpha.needsUpdate = true;
      geo.attributes.aSize.needsUpdate = true;
    }
  };
})();

/* ===================================================================
   9b. CAREER SYSTEMS: toasts, coins, quests, beacon runs, route looks
   =================================================================== */
function toast(title, sub, kind) {
  const box = $('toasts');
  if (!box) return;
  const el = document.createElement('div');
  el.className = 'toast ' + (kind || '');
  el.innerHTML = '<b>' + title + '</b>' + (sub ? '<span>' + sub + '</span>' : '');
  box.appendChild(el);
  while (box.children.length > 3) box.removeChild(box.firstChild);
  setTimeout(() => el.classList.add('out'), 2600);
  setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 3100);
}

const Career = {
  addCoins(n) { Save.data.coins += n; Save.dirty = true; },
  addXp(n) {
    const before = levelInfo(Save.data.xp).lvl;
    Save.data.xp += n; Save.dirty = true;
    const after = levelInfo(Save.data.xp).lvl;
    for (let l = before + 1; l <= after; l++) {
      this.addCoins(l * 100);
      toast('Level ' + l + ': ' + rankOf(l), '+' + (l * 100) + ' coins', 'gold');
      ROUTES.filter((r) => r.level === l).forEach((r) => toast('Route unlocked', r.name, 'gold'));
      GARAGE.filter((g) => g.level === l).forEach((g) => toast('Now in the shop', g.name, 'gold'));
      AudioFX.chime();
    }
  }
};

// ---- Coins: one instanced mesh, patterns spawned ahead of the car ----
let coinPulse = false;
const Coins = (function () {
  const MAX = 160, LANES = [-2, -6, -10];
  const geo = new THREE.CylinderGeometry(0.55, 0.55, 0.13, 24).rotateX(Math.PI / 2);
  const mat = new THREE.MeshStandardMaterial({ color: col(0xffc933), emissive: col(0xff9a1a), emissiveIntensity: 0.55, metalness: 0.9, roughness: 0.25, envMapIntensity: 1.4 });
  const mesh = new THREE.InstancedMesh(geo, mat, MAX);
  mesh.frustumCulled = false;
  scene.add(mesh);
  const items = [];
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < MAX; i++) { items.push({ on: false, x: 0, z: 0, ph: 0, v: 5 }); mesh.setMatrixAt(i, zero); }
  const d = new THREE.Object3D();
  let spawnZ = 60, t = 0;

  function put(x, z, v) {
    const it = items.find((c) => !c.on);
    if (!it) return;
    it.on = true; it.x = x; it.z = z; it.ph = Math.random() * 6; it.v = v;
  }
  function pattern() {
    const r = Math.random(), lane = pick(LANES), z = spawnZ;
    if (r < 0.45) {                                  // straight line
      for (let i = 0; i < 6; i++) put(lane, z + i * 5, 5);
    } else if (r < 0.75) {                           // lane change
      const l2 = pick(LANES.filter((l) => l !== lane));
      for (let i = 0; i < 7; i++) { const f = i / 6; put(lerp(lane, l2, f * f * (3 - 2 * f)), z + i * 5, 5); }
    } else if (r < 0.9) {                            // weave
      for (let i = 0; i < 9; i++) put(lerp(-2, -10, 0.5 + 0.5 * Math.sin(i * 0.9)), z + i * 4.5, 5);
    } else {                                         // risky: double value in an oncoming lane
      const ol = pick([2, 6, 10]);
      for (let i = 0; i < 8; i++) put(ol, z + i * 5, 10);
    }
    spawnZ += rand(55, 110);
  }
  return {
    mesh,
    reset() {
      items.forEach((c, i) => { c.on = false; mesh.setMatrixAt(i, zero); });
      mesh.instanceMatrix.needsUpdate = true;
      spawnZ = car.z + 70;
    },
    update(dt, play) {
      t += dt;
      if (play) {
        if (spawnZ < car.z - 50) spawnZ = car.z + 60;
        while (spawnZ < car.z + 460) pattern();
      }
      let dirty = false;
      for (let i = 0; i < MAX; i++) {
        const it = items[i];
        if (!it.on) continue;
        if (it.z < car.z - 140 || it.z > car.z + 720) { it.on = false; mesh.setMatrixAt(i, zero); dirty = true; continue; }
        if (play && Math.abs(it.z - car.z) < 2.6 && Math.abs(it.x - car.x) < 2.3) {
          it.on = false; mesh.setMatrixAt(i, zero); dirty = true;
          onCoin(it.v);
          continue;
        }
        d.position.set(it.x, 1.15 + Math.sin(t * 3 + it.ph) * 0.12, it.z);
        d.rotation.set(0, t * 3 + it.ph, 0);
        d.updateMatrix();
        mesh.setMatrixAt(i, d.matrix);
        dirty = true;
      }
      if (dirty) mesh.instanceMatrix.needsUpdate = true;
    }
  };
})();
function onCoin(v) {
  Career.addCoins(v);
  Career.addXp(Math.ceil(v / 5));
  Save.data.stats.coins += v;
  Quests.event('coin', 1);
  AudioFX.coin();
  coinPulse = true;
}

// ---- Quests ----
const QUEST_DEFS = [
  { type: 'coin',     mode: 'sum', text: (n) => 'Collect ' + n + ' coins',                    t: [15, 30, 50, 80],           r: [90, 160, 280, 450],  x: [25, 45, 70, 110] },
  { type: 'distance', mode: 'sum', text: (n) => 'Drive ' + (n / 1000).toFixed(1) + ' km',      t: [1500, 3000, 6000, 10000],  r: [80, 150, 300, 500],  x: [25, 50, 90, 140] },
  { type: 'nearmiss', mode: 'sum', text: (n) => 'Pull off ' + n + ' near misses',            t: [3, 6, 10, 16],             r: [100, 190, 320, 520], x: [30, 55, 90, 140] },
  { type: 'oncoming', mode: 'sum', text: (n) => 'Drive ' + n + ' s in oncoming lanes',        t: [6, 10, 16, 25],            r: [110, 200, 340, 540], x: [30, 55, 90, 140] },
  { type: 'clean',    mode: 'sum', text: (n) => 'Drive ' + n + ' s without a crash',          t: [40, 70, 110, 160],         r: [90, 170, 300, 480],  x: [25, 50, 80, 125] },
  { type: 'speed',    mode: 'max', text: (n) => 'Reach ' + n + ' mph',                        t: [80, 100, 125, 150],        r: [100, 180, 320, 520], x: [30, 55, 90, 140] },
  { type: 'drift',    mode: 'max', text: (n) => 'Score ' + n + ' in a single drift',          t: [300, 800, 1600, 3000],     r: [120, 220, 380, 600], x: [35, 60, 100, 150] },
  { type: 'run',      mode: 'run', text: (n) => 'Reach the beacon ' + n + ' m ahead in time', t: [700, 1000, 1400, 1800],    r: [200, 340, 560, 900], x: [60, 100, 160, 240] }
];
const defOf = (type) => QUEST_DEFS.find((d) => d.type === type) || QUEST_DEFS[0];

const Quests = {
  list() { return Save.data.quests; },
  init() {
    const q = Save.data.quests;
    const valid = Array.isArray(q) && q.length === 3 && q.every((x) => x && QUEST_DEFS.some((d) => d.type === x.type));
    if (!valid) {
      Save.data.quests = [];
      while (Save.data.quests.length < 3) Save.data.quests.push(this.make());
      Save.save();
    }
  },
  make() {
    const used = Save.data.quests.map((q) => q.type);
    const def = pick(QUEST_DEFS.filter((d) => !used.includes(d.type)));
    const tier = clamp(Math.floor(Save.data.stats.quests / 3) + (Math.random() < 0.3 ? 1 : 0), 0, 3);
    let target = def.t[tier];
    if (def.type === 'speed') {          // keep speed goals reachable with the fastest car you own
      const best = Math.max(...Save.data.owned.map((id) => carById(id).stats.vmax));
      target = Math.min(target, Math.max(60, Math.floor(best * 2.237 * 0.88 / 5) * 5));
    }
    return { type: def.type, target, progress: 0, reward: def.r[tier], xp: def.x[tier] };
  },
  text(q) { return defOf(q.type).text(q.target); },
  progressText(q) {
    if (q.type === 'distance') return (q.progress / 1000).toFixed(1) + ' / ' + (q.target / 1000).toFixed(1) + ' km';
    if (q.type === 'run') return Run.active ? Math.max(0, Math.round(Run.z - car.z)) + ' m left' : 'ready';
    return Math.floor(q.progress) + ' / ' + q.target;
  },
  event(type, amt) {
    if (state !== 'play' || !Save.data.quests) return;
    if (type === 'crash') {
      for (const q of this.list()) if (q.type === 'clean' && q.progress < q.target) q.progress = 0;
      return;
    }
    let done = null;
    for (const q of this.list()) {
      if (q.type !== type || q.progress >= q.target) continue;
      const def = defOf(q.type);
      q.progress = def.mode === 'max' ? Math.max(q.progress, amt) : Math.min(q.target, q.progress + amt);
      if (def.mode === 'run') q.progress = q.target;
      if (q.progress >= q.target && !done) done = q;
    }
    if (done) this.complete(done);
  },
  complete(q) {
    const list = this.list();
    list.splice(list.indexOf(q), 1);
    Career.addCoins(q.reward);
    Career.addXp(q.xp);
    Save.data.stats.quests++;
    list.push(this.make());
    toast('Quest complete', this.text(q) + ' &middot; +' + q.reward + ' coins', 'gold');
    AudioFX.chime();
    if (q.type === 'run') Run.cancel();
    Save.save();
  }
};

// ---- Beacon run: a timed trip to a glowing marker further down the road ----
const Run = {
  active: false, x: -6, z: 0, time: 0, group: null, ring: null,
  build() {
    const mat = new THREE.MeshBasicMaterial({ color: 0xffd25e, transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide });
    this.group = new THREE.Group();
    this.group.add(new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 160, 20, 1, true).translate(0, 80, 0), mat));
    this.ring = new THREE.Mesh(new THREE.TorusGeometry(7, 0.3, 8, 48).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffd25e, fog: false }));
    this.ring.position.y = 0.4;
    this.group.add(this.ring);
    this.group.visible = false;
    scene.add(this.group);
  },
  begin(q) {
    this.active = true;
    this.x = -6;
    this.z = car.z + q.target;
    this.time = q.target / 21 + 12;
    this.group.position.set(this.x, 0, this.z);
    this.group.visible = state === 'play';
  },
  cancel() { this.active = false; if (this.group) this.group.visible = false; },
  update(dt) {
    const q = Quests.list().find((x) => x.type === 'run');
    if (!q) { this.cancel(); return; }
    if (!this.active) this.begin(q);
    this.time -= dt;
    this.ring.scale.setScalar(1 + 0.08 * Math.sin(performance.now() * 0.006));
    if (Math.abs(this.z - car.z) < 10 && Math.abs(this.x - car.x) < 11) { Quests.event('run', 1); return; }
    if (this.time <= 0) { toast('Out of time', 'The beacon moved. Try again.', 'warn'); this.begin(q); }
  }
};

// ---- Per-frame career tracking ----
let distAcc = 0, nearMissCooldown = 0;
function trackDriving(dt) {
  const spd = Math.hypot(car.vx, car.vz), mph = spd * 2.23694, S = Save.data.stats;
  S.distance += spd * dt;
  if (mph > S.topSpeed) S.topSpeed = mph;
  distAcc += spd * dt;
  if (distAcc >= 100) { distAcc -= 100; Career.addXp(1); }
  Quests.event('distance', spd * dt);
  Quests.event('speed', mph);
  if (spd > 3) Quests.event('clean', dt);
  if (car.x > 1.2 && spd > 9) Quests.event('oncoming', dt);
  nearMissCooldown -= dt;
  for (const n of traffic) {
    const dz = n.z - car.z, dx = Math.abs(n.x - car.x);
    if (Math.abs(dz) < 3.5 && dx > 1.9 && dx < 3.8 && !n.nm) {
      if (Math.hypot(car.vx, car.vz - n.dir * n.speed) > 12) {
        n.nm = true; S.nearMiss++;
        Career.addXp(5); Career.addCoins(8);
        Quests.event('nearmiss', 1);
        if (nearMissCooldown <= 0) { toast('Near miss', '+8 coins', ''); nearMissCooldown = 1.2; }
      }
    } else if (Math.abs(dz) > 14) n.nm = false;
  }
  Save.dirty = true;
}
function bankDrift(score) {
  const sc = Math.floor(score), S = Save.data.stats;
  if (sc > S.bestDrift) S.bestDrift = sc;
  const coins = Math.floor(sc / 100);
  if (coins > 0) Career.addCoins(coins);
  Career.addXp(Math.floor(sc / 60));
  Quests.event('drift', sc);
  if (sc >= 200) toast('Drift banked', sc.toLocaleString() + ' pts &middot; +' + coins + ' coins', '');
  Save.dirty = true;
}

// ---- Route looks ----
function tintHills(c) {
  const mk = (top, bottom) => {
    const [cv, g] = makeCanvas(4, 128);
    const grd = g.createLinearGradient(0, 0, 0, 128);
    grd.addColorStop(0, top); grd.addColorStop(1, bottom);
    g.fillStyle = grd; g.fillRect(0, 0, 4, 128);
    return canvasTex(cv);
  };
  hillMeshes.forEach((m, i) => {
    if (m.material.map) m.material.map.dispose();
    m.material.map = mk(c[i * 2], c[i * 2 + 1]);
    m.material.needsUpdate = true;
  });
}
function applyLights() {
  if (!player || !player.spots) return;
  player.spots.forEach((s) => { s.visible = car.lights; s.intensity = currentRoute.night ? 3.4 : 1.6; });
  player.headMat.emissiveIntensity = car.lights ? (currentRoute.night ? 2.2 : 1.2) : 0.15;
}
function applyRoute(r) {
  const u = skyMat.uniforms;
  u.zenith.value.set(...r.sky.zenith); u.violet.value.set(...r.sky.violet);
  u.pink.value.set(...r.sky.pink); u.horizon.value.set(...r.sky.horizon);
  u.sunTint.value.set(...r.sunTint); u.sunGain.value = r.sunGain;
  u.stars.value = r.stars; u.cloudAmt.value = r.cloud;
  SUN_DIR.set(...r.sunDir).normalize();
  u.sunDir.value.copy(SUN_DIR);
  _sd.copy(SUN_DIR).negate();
  FOG_COLOR.set(r.fog[0], r.fog[1], r.fog[2]);
  scene.fog.density = r.fogD;
  sun.color.copy(col(r.sunColor)); sun.intensity = r.sunInt;
  ambient.color.copy(col(r.amb[0])); ambient.intensity = r.amb[1];
  hemi.color.copy(col(r.hemi[0])); hemi.groundColor.copy(col(r.hemi[1])); hemi.intensity = r.hemi[2];
  renderer.toneMappingExposure = r.exposure;
  buildEnvironment();
  tintHills(r.hills);
  if (backdrop.userData.sign) backdrop.userData.sign.visible = r.id === 'sunset';
  buildingMats.forEach((m) => { m.emissiveIntensity = r.bldEmissive; });
  lampMat.emissiveIntensity = r.lamp;
  currentRoute = r;
  for (const seg of segments) placeSegment(seg, seg.index);
  applyLights();
  hud.lastDistrict = '';
}
function resetTraffic() {
  traffic.forEach((n, i) => { respawnNPC(n, true); n.z = car.z + 60 + i * 45; n.nm = false; });
}

/* ===================================================================
   10. AUDIO (synthesised V6 + tire squeal + wind; no asset files)
   =================================================================== */
const AudioFX = (function () {
  let ctx = null, master = null, muted = false;
  const eng = {}, noise = {};
  function init() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain(); master.gain.value = muted ? 0 : 0.5; master.connect(ctx.destination);
    eng.lp = ctx.createBiquadFilter(); eng.lp.type = 'lowpass'; eng.lp.frequency.value = 600; eng.lp.Q.value = 2;
    eng.gain = ctx.createGain(); eng.gain.gain.value = 0;
    eng.o = [ctx.createOscillator(), ctx.createOscillator(), ctx.createOscillator()];
    ['sawtooth', 'square', 'triangle'].forEach((t, i) => {
      eng.o[i].type = t;
      const g = ctx.createGain(); g.gain.value = [0.5, 0.22, 0.45][i];
      eng.o[i].connect(g); g.connect(eng.lp); eng.o[i].start();
    });
    eng.lp.connect(eng.gain); eng.gain.connect(master);
    const len = ctx.sampleRate * 2, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const mk = (type, freq, q) => {
      const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true;
      const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain(); g.gain.value = 0;
      s.connect(f); f.connect(g); g.connect(master); s.start();
      return g;
    };
    noise.tire = mk('bandpass', 1400, 1.2);
    noise.wind = mk('lowpass', 500, 0.7);
  }
  return {
    init,
    update(rpm, thr, slip, speed) {
      if (!ctx) return;
      const t = ctx.currentTime, f = rpm / 60 * 3;
      eng.o[0].frequency.setTargetAtTime(f, t, 0.03);
      eng.o[1].frequency.setTargetAtTime(f * 0.5, t, 0.03);
      eng.o[2].frequency.setTargetAtTime(f * 2, t, 0.03);
      eng.lp.frequency.setTargetAtTime(350 + rpm * 0.55 + thr * 900, t, 0.05);
      eng.gain.gain.setTargetAtTime(0.05 + thr * 0.09 + (rpm / 7000) * 0.05, t, 0.05);
      noise.tire.gain.setTargetAtTime(speed > 3 ? clamp((slip - 0.12) * 1.6, 0, 0.35) : 0, t, 0.05);
      noise.wind.gain.setTargetAtTime(clamp(speed / 70, 0, 1) * 0.22, t, 0.1);
    },
    thud(v) {
      if (!ctx) return;
      const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.setValueAtTime(130, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.25);
      g.gain.setValueAtTime(clamp(v / 15, 0.1, 0.8), t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
      o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.32);
    },
    toggleMute() {
      muted = !muted;
      if (ctx) master.gain.setTargetAtTime(muted ? 0 : 0.5, ctx.currentTime, 0.02);
      return muted;
    },
    coin() {
      if (!ctx) return;
      const t = ctx.currentTime;
      [988, 1319].forEach((f, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain(), t0 = t + i * 0.06;
        o.type = 'square'; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.10, t0 + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16);
        o.connect(g); g.connect(master); o.start(t0); o.stop(t0 + 0.18);
      });
    },
    chime() {
      if (!ctx) return;
      const t = ctx.currentTime;
      [523, 659, 784, 1046].forEach((f, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain(), t0 = t + i * 0.09;
        o.type = 'triangle'; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.16, t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.45);
        o.connect(g); g.connect(master); o.start(t0); o.stop(t0 + 0.5);
      });
    },
    silence() {
      if (!ctx) return;
      const t = ctx.currentTime;
      eng.gain.gain.setTargetAtTime(0, t, 0.05);
      noise.tire.gain.setTargetAtTime(0, t, 0.05);
      noise.wind.gain.setTargetAtTime(0, t, 0.05);
    }
  };
})();

/* ===================================================================
   11. PHYSICS: engine curve, 8-speed auto, tire grip, handbrake drift
   =================================================================== */
const MASS = 1620, FINAL = 3.5, IDLE = 850, REDLINE = 6700;
const GEARS = [5.25, 3.03, 1.95, 1.46, 1.22, 1.0, 0.81, 0.67];
const REVERSE_RATIO = 3.7;
const TORQUE = [[800, 200], [1000, 230], [2000, 290], [3000, 340], [4000, 360], [4700, 362], [5500, 345], [6200, 310], [6700, 270], [7000, 200]];
function torqueAt(rpm) {
  if (rpm <= TORQUE[0][0]) return TORQUE[0][1];
  for (let i = 1; i < TORQUE.length; i++) {
    if (rpm <= TORQUE[i][0]) {
      const a = TORQUE[i - 1], b = TORQUE[i], t = (rpm - a[0]) / (b[0] - a[0]);
      return lerp(a[1], b[1], t);
    }
  }
  return 0;
}

const START = { x: -6, z: 0 };
const car = {
  x: START.x, z: START.z, y: 0, yaw: 0, vx: 0, vz: 0, yawRate: 0,
  steer: 0, throttle: 0, brake: 0, gear: 1, shiftTimer: 0, rpm: IDLE,
  mode: 'P', idleT: 0, pitch: 0, roll: 0, aF: 0, aLat: 0, slip: 0,
  spin: 0, steerVis: 0, odo: 0, hb: false, braking: false, lights: true,
  drift: 0, driftShow: 0, hit: 0
};
const input = { up: false, down: false, left: false, right: false, brake: false };

let player = null;      // the procedural car currently on the road
let stats = { torque: 1, mass: 1620, vmax: 64, grip: 1, traction: 7.4 };   // set from GARAGE
const FIXED_DT = 1 / 90;

function stepCar(dt) {
  const sy = Math.sin(car.yaw), cy = Math.cos(car.yaw);
  const fx = sy, fz = cy, lx = cy, lz = -sy;
  const vF = car.vx * fx + car.vz * fz;
  const vL = car.vx * lx + car.vz * lz;
  const sp = Math.abs(vF);

  // ---- pedals / gear selector ----
  let thr = 0, brk = 0, reverse = false;
  if (input.up && !input.down) {
    if (vF < -0.8) brk = 1; else { thr = 1; car.mode = 'D'; }
  } else if (input.down && !input.up) {
    if (vF > 0.8) brk = 1; else { thr = 1; reverse = true; car.mode = 'R'; }
  }
  car.throttle = damp(car.throttle, thr, thr > car.throttle ? 7 : 12, dt);
  car.brake = damp(car.brake, brk, 14, dt);
  car.hb = input.brake;
  car.braking = brk > 0 || car.hb;
  if (vF > 1) car.mode = 'D'; else if (vF < -1) car.mode = 'R';
  if (sp < 0.2 && !thr && !brk && !car.hb) { car.idleT += dt; if (car.idleT > 1) car.mode = 'P'; } else car.idleT = 0;
  const inReverse = reverse || car.mode === 'R';

  // ---- automatic gearbox ----
  const wheelRpm = sp / CAR.wheelR * 60 / (Math.PI * 2);
  if (inReverse) car.gear = 1;
  else {
    car.shiftTimer = Math.max(0, car.shiftTimer - dt);
    if (sp < 1.5) car.gear = 1;
    else if (car.shiftTimer === 0) {
      const rUp = wheelRpm * GEARS[car.gear - 1] * FINAL;
      if (rUp > 6200 && car.gear < 8 && car.throttle > 0.3) { car.gear++; car.shiftTimer = 0.2; }
      else if (car.gear > 1) {
        const rDown = wheelRpm * GEARS[car.gear - 2] * FINAL;
        if ((rUp < 2300 || (car.throttle > 0.85 && rUp < 3000)) && rDown < 5800) { car.gear--; car.shiftTimer = 0.14; }
      }
    }
  }
  const ratio = (inReverse ? REVERSE_RATIO : GEARS[car.gear - 1]) * FINAL;
  const engRpm = Math.max(wheelRpm * ratio, thr ? 1500 + 1500 * car.throttle : IDLE);

  // ---- longitudinal ----
  let aDrive = 0;
  if (thr > 0) {
    let torque = torqueAt(engRpm) * stats.torque * car.throttle;
    if (car.shiftTimer > 0) torque *= 0.1;
    if (engRpm > REDLINE) torque = 0;
    const vmax = inReverse ? 9 : stats.vmax;
    torque *= clamp(1 - Math.pow(sp / vmax, 6), 0, 1);
    let a = torque * ratio * 0.88 / CAR.wheelR / stats.mass;
    a = Math.min(a, inReverse ? 4.2 : stats.traction);               // FWD traction limit
    aDrive = (inReverse ? -1 : 1) * a;
  }
  let vF1 = vF + aDrive * dt;
  const coast = (!thr && !brk) ? 0.8 : 0;
  const parked = (car.mode === 'P' && !thr) ? 20 : 0;
  const brakeDec = car.brake * 10.5 + (car.hb ? 5 : 0) + parked;
  const resist = 0.14 + 0.00023 * vF * vF + coast;
  vF1 = approachZero(vF1, (brakeDec + resist) * dt);

  // ---- lateral grip (saturating) ----
  const aMax = (car.hb ? 3.6 : 9.3) * stats.grip;
  const kGrip = car.hb ? 2.6 : 9.0;
  const aL = clamp(-kGrip * vL, -aMax, aMax);
  let vL1 = vL + aL * dt;
  if (vL !== 0 && Math.sign(vL1) !== Math.sign(vL)) vL1 = 0;
  vF1 = approachZero(vF1, Math.abs(aL) * 0.10 * dt);       // tire work scrubs speed

  // ---- steering and yaw ----
  const target = (input.left ? 1 : 0) - (input.right ? 1 : 0);
  car.steer = damp(car.steer, target, target === 0 ? 7 : 4.5, dt);
  const maxSteer = rad(34 / (1 + Math.pow(sp / 9, 1.6)));
  let wT = vF * Math.tan(car.steer * maxSteer) / CAR.wheelbase;
  if (car.hb && sp > 5) wT *= 1.9;
  const wMax = (car.hb ? 11 : aMax) / Math.max(sp, 5);
  wT = clamp(wT, -wMax, wMax);
  car.yawRate = damp(car.yawRate, wT, car.hb ? 5 : 10, dt);

  // ---- integrate ----
  const dF = vF1 - vF, dL = vL1 - vL;
  car.vx += fx * dF + lx * dL;
  car.vz += fz * dF + lz * dL;
  car.yaw += car.yawRate * dt;
  car.x += car.vx * dt;
  car.z += car.vz * dt;
  car.odo += Math.hypot(car.vx, car.vz) * dt;

  car.aF = damp(car.aF, dF / dt, 8, dt);
  car.aLat = damp(car.aLat, car.yawRate * vF, 8, dt);
  car.slip = Math.atan2(Math.abs(vL1), Math.max(Math.abs(vF1), 2));
  car.spin += (vF1 / CAR.wheelR) * dt;
  car.rpm = damp(car.rpm, car.shiftTimer > 0 ? engRpm * 0.82 : engRpm, 14, dt);
  car.steerVis = car.steer * rad(lerp(28, 10, clamp(sp / 40, 0, 1)));

  collideStatic();
  collideTraffic();
}

// ---- collisions: circles for the car, palms, poles, walls and traffic ----
const CAR_R = 0.95;
function hitFx(impact) {
  if (impact < 1.5) return;
  if (impact > 3) { Quests.event('crash'); Save.data.stats.crashes++; Save.dirty = true; }
  Cam.shake = Math.max(Cam.shake, clamp(impact * 0.04, 0.05, 0.6));
  car.hit = impact;
  AudioFX.thud(impact);
}
function collideStatic() {
  const sy = Math.sin(car.yaw), cy = Math.cos(car.yaw);
  for (const seg of segments) {
    const base = seg.index * SEG;
    if (Math.abs(base - car.z) > SEG) continue;
    const list = seg.gantry.visible ? seg.obstacles.concat(seg.gantryObs) : seg.obstacles;
    for (const o of list) {
      if (o.palm && !seg.palmsOn) continue;
      const ox = o.x, oz = base + o.z;
      for (const off of OFFS) {
        const cx = car.x + sy * off, cz = car.z + cy * off;
        const dx = cx - ox, dz = cz - oz, rr = o.r + CAR_R, d2 = dx * dx + dz * dz;
        if (d2 < rr * rr && d2 > 1e-6) {
          const d = Math.sqrt(d2), nx = dx / d, nz = dz / d, pen = rr - d;
          car.x += nx * pen; car.z += nz * pen;
          const vn = car.vx * nx + car.vz * nz;
          if (vn < 0) {
            car.vx -= 1.25 * vn * nx; car.vz -= 1.25 * vn * nz;
            car.vx *= 0.97; car.vz *= 0.97;
            car.yawRate += clamp((sy * off * nz - cy * off * nx) * -vn * 0.08, -1.5, 1.5);
            hitFx(-vn);
          }
        }
      }
    }
  }
  if (Math.abs(car.x) > WALL_X) {
    const s = Math.sign(car.x);
    car.x = s * WALL_X;
    if (car.vx * s > 0) { hitFx(Math.abs(car.vx)); car.vx *= -0.2; car.vz *= 0.92; }
  }
}
function collideTraffic() {
  const sy = Math.sin(car.yaw), cy = Math.cos(car.yaw);
  for (const n of traffic) {
    if (Math.abs(n.z - car.z) > 8 || Math.abs(n.x - car.x) > 4) continue;
    for (const off of OFFS) {
      const cx = car.x + sy * off, cz = car.z + cy * off;
      for (const no of OFFS) {
        const dx = cx - n.x, dz = cz - (n.z + no), rr = CAR_R * 2, d2 = dx * dx + dz * dz;
        if (d2 < rr * rr && d2 > 1e-6) {
          const d = Math.sqrt(d2), nx = dx / d, nz = dz / d, pen = rr - d;
          car.x += nx * pen * 0.55; car.z += nz * pen * 0.55;
          const rvx = car.vx, rvz = car.vz - n.dir * n.speed;
          const vn = rvx * nx + rvz * nz;
          if (vn < 0) {
            const j = -(1 + 0.2) * vn / (1 / stats.mass + 1 / 1500);
            car.vx += (j / stats.mass) * nx; car.vz += (j / stats.mass) * nz;
            n.speed = clamp(n.speed - n.dir * (j / 1500) * nz, 0, 30);
            hitFx(-vn);
          }
        }
      }
    }
  }
}

function resetCar() {
  Object.assign(car, { x: START.x, z: car.z, y: 0, yaw: 0, vx: 0, vz: 0, yawRate: 0, steer: 0, throttle: 0, brake: 0, gear: 1, mode: 'P', pitch: 0, roll: 0, drift: 0 });
  Cam.snap = true;
}

/* ===================================================================
   12. CAMERA RIG  (0 chase, 1 hood, 2 free orbit)
   =================================================================== */
// Keep the horizontal field of view usable when the screen is portrait (phones).
function fovFor(v) {
  const a = camera.aspect;
  if (a >= 1.3) return v;
  return clamp(THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(rad(v) / 2) * 1.3 / a)), v, 92);
}

const Cam = {
  mode: 0, yaw: 0, shake: 0, snap: true,
  off: new THREE.Vector3(), lookOff: new THREE.Vector3(),
  _d: new THREE.Vector3(), _l: new THREE.Vector3(), _p: new THREE.Vector3(),
  cycle() {
    this.mode = (this.mode + 1) % 3;
    controls.enabled = this.mode === 2;
    if (this.mode === 2) {
      controls.target.set(car.x, 1, car.z);
      camera.position.set(car.x - 6, 3.2, car.z - 8);
    }
    this.snap = true;
  },
  menuT: 0,
  // Showroom orbit used behind the main menu. The view offset slides the car out from under the panel.
  menuOrbit(dt) {
    this.menuT += dt * 0.28;
    const portrait = camera.aspect < 1;
    const r = portrait ? 9.8 : 7.8;
    camera.position.set(car.x + Math.sin(this.menuT) * r, car.y + 1.9, car.z + Math.cos(this.menuT) * r);
    camera.lookAt(car.x, car.y + 0.8, car.z);
    camera.fov = damp(camera.fov, fovFor(46), 4, dt);
    const w = window.innerWidth, h = window.innerHeight;
    if (portrait) camera.setViewOffset(w, h, 0, h * 0.20, w, h);
    else camera.setViewOffset(w, h, -w * 0.17, 0, w, h);
    camera.updateProjectionMatrix();
  },
  update(dt) {
    const spd = Math.hypot(car.vx, car.vz), sf = clamp(spd / 60, 0, 1);
    const targetFov = fovFor(this.mode === 1 ? 72 : 60 + 22 * sf);
    camera.fov = damp(camera.fov, targetFov, 4, dt);
    camera.updateProjectionMatrix();

    if (this.mode === 2) {
      const dx = car.x - controls.target.x, dz = car.z - controls.target.z;
      camera.position.x += dx; camera.position.z += dz;
      controls.target.set(car.x, 1, car.z);
      controls.update();
      return;
    }
    if (this.mode === 1) {
      player.root.updateMatrixWorld(true);
      player.body.localToWorld(this._p.set(0, 1.22, 0.25));
      player.body.localToWorld(this._l.set(0, 1.1, 10));
      camera.position.copy(this._p);
      camera.lookAt(this._l);
      return;
    }
    // chase: yaw is smoothed, offset is smoothed relative to the car (no speed lag)
    const vF = carSpeedF();
    let tgt = car.yaw;
    if (spd > 5 && vF > 0) tgt += wrapPI(Math.atan2(car.vx, car.vz) - car.yaw) * 0.4;
    if (this.snap) this.yaw = car.yaw; else this.yaw += wrapPI(tgt - this.yaw) * (1 - Math.exp(-3.2 * dt));
    const portrait = camera.aspect < 1;
    const dist = (7.4 + sf * 1.8) * (portrait ? 1.12 : 1), h = 2.6 + sf * 0.6 + (portrait ? 0.5 : 0);
    this._d.set(-Math.sin(this.yaw) * dist, h, -Math.cos(this.yaw) * dist);
    this._l.set(Math.sin(this.yaw) * 5, 1.2, Math.cos(this.yaw) * 5);
    if (this.snap) { this.off.copy(this._d); this.lookOff.copy(this._l); this.snap = false; }
    else {
      this.off.lerp(this._d, 1 - Math.exp(-8 * dt));
      this.lookOff.lerp(this._l, 1 - Math.exp(-10 * dt));
    }
    const sh = this.shake + sf * sf * 0.02;
    camera.position.set(car.x + this.off.x + rand(-sh, sh), car.y + this.off.y + rand(-sh, sh), car.z + this.off.z + rand(-sh, sh));
    camera.lookAt(car.x + this.lookOff.x, car.y + this.lookOff.y, car.z + this.lookOff.z);
    this.shake = Math.max(0, this.shake - dt * 1.5);
  }
};

/* ===================================================================
   13. HUD, MINIMAP, INPUT, MAIN LOOP
   =================================================================== */
const hud = {
  speed: $('speed'), arc: $('rpmArc'), gears: Array.from($('gears').children), gearNum: $('gearNum'),
  thr: $('barThrottle'), brk: $('barBrake'), district: $('district'),
  drift: $('drift'), driftScore: $('driftScore'), help: $('help'),
  paintName: $('paintName'), paintSwatch: $('paintSwatch'), mini: $('minimap'), root: $('hud'),
  lastSpeed: -1, lastMode: '', lastGear: -1, lastDistrict: '', lastScore: -1
};
const DISTRICTS = ['Sunset Strip', 'Beverly Hills', 'Holmby Hills', 'Brentwood', 'Pacific Palisades'];
const miniCtx = hud.mini.getContext('2d');
let paintIndex = 0;

function setPaint(i) {
  paintIndex = i;
  player.paintIdx = i;
  if (Save.data.owned.includes(player.id)) Save.data.paint[player.id] = i;
  const p = CONFIG.paints[i];
  player.paintMat.color.copy(col(p.color));
  hud.paintName.textContent = p.name;
  hud.paintSwatch.style.background = '#' + p.color.toString(16).padStart(6, '0');
}

function updateHUD(dt) {
  const mph = Math.round(Math.hypot(car.vx, car.vz) * 2.23694);
  if (mph !== hud.lastSpeed) { hud.speed.textContent = mph; hud.lastSpeed = mph; }
  const mode = Math.abs(carSpeedF()) < 0.3 && !input.up && !input.down && car.mode !== 'P' ? 'N' : car.mode;
  if (mode !== hud.lastMode) {
    hud.gears.forEach((el) => el.classList.toggle('on', el.dataset.g === mode));
    hud.lastMode = mode;
  }
  const gl = mode === 'D' ? car.gear : mode === 'R' ? 'R' : '-';
  if (gl !== hud.lastGear) { hud.gearNum.textContent = typeof gl === 'number' ? 'gear ' + gl : (gl === 'R' ? 'reverse' : 'idle'); hud.lastGear = gl; }
  const frac = clamp((car.rpm - 800) / (7000 - 800), 0, 1);
  hud.arc.style.strokeDasharray = (556 * frac).toFixed(1) + ' 742';
  hud.arc.classList.toggle('redline', car.rpm > 6200);
  hud.thr.style.height = (car.throttle * 100).toFixed(0) + '%';
  hud.brk.style.height = (Math.max(car.brake, car.hb ? 1 : 0) * 100).toFixed(0) + '%';
  const dl = currentRoute.districts;
  const d = dl[Math.floor(Math.max(car.z, 0) / 1800) % dl.length] + ', ' + currentRoute.mood.toLowerCase();
  if (d !== hud.lastDistrict) { hud.district.textContent = d; hud.lastDistrict = d; }

  // drift scoring
  const spd = Math.hypot(car.vx, car.vz);
  if (car.slip > 0.17 && spd > 8) {
    car.drift += car.slip * spd * dt * 12;
    car.driftShow = 1.4;
  } else {
    car.driftShow -= dt;
    if (car.driftShow <= 0) { if (car.drift > 50) bankDrift(car.drift); car.drift = 0; }
  }
  hud.drift.classList.toggle('active', car.driftShow > 0 && car.drift > 5);
  const score = Math.floor(car.drift);
  if (score !== hud.lastScore) { hud.driftScore.textContent = score.toLocaleString(); hud.lastScore = score; }
}

function drawMinimap() {
  const S = 240, cx = S / 2, cy = S / 2 + 20, scale = 0.9;
  const ctx = miniCtx, th = car.yaw, st = Math.sin(th), ct = Math.cos(th);
  const P = (x, z) => {
    const dx = x - car.x, dz = z - car.z;
    return [cx - (dx * ct - dz * st) * scale, cy - (dx * st + dz * ct) * scale];
  };
  const poly = (pts, fill) => {
    ctx.beginPath();
    pts.forEach((p, i) => { const q = P(p[0], p[1]); i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); });
    ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
  };
  ctx.save();
  ctx.clearRect(0, 0, S, S);
  ctx.beginPath(); ctx.arc(S / 2, S / 2, S / 2 - 2, 0, Math.PI * 2); ctx.clip();
  ctx.fillStyle = '#2a2230'; ctx.fillRect(0, 0, S, S);
  const z0 = car.z - 260, z1 = car.z + 260;
  // buildings
  ctx.globalAlpha = 0.9;
  for (const seg of segments) {
    for (const m of seg.near) {
      const bx = m.position.x, bz = seg.index * SEG + m.position.z;
      if (!m.visible || Math.abs(bz - car.z) > 170) continue;
      const w = m.userData.w / 2, d = m.userData.d / 2;
      poly([[bx - d, bz - w], [bx + d, bz - w], [bx + d, bz + w], [bx - d, bz + w]].map((p) => [p[0], p[1]]), '#5a4a58');
    }
  }
  ctx.globalAlpha = 1;
  poly([[-17, z0], [17, z0], [17, z1], [-17, z1]], '#6b6168');          // sidewalks
  poly([[-12, z0], [12, z0], [12, z1], [-12, z1]], '#37353d');          // asphalt
  poly([[-0.3, z0], [0.3, z0], [0.3, z1], [-0.3, z1]], '#d6a21a');      // double yellow
  // traffic
  for (const n of traffic) {
    const q = P(n.x, n.z);
    ctx.fillStyle = n.dir < 0 ? '#ff6a5e' : '#9fd0ff';
    ctx.fillRect(q[0] - 2.5, q[1] - 4, 5, 8);
  }
  // player arrow
  ctx.fillStyle = '#ffd25e';
  ctx.beginPath(); ctx.moveTo(cx, cy - 10); ctx.lineTo(cx + 6, cy + 7); ctx.lineTo(cx, cy + 3); ctx.lineTo(cx - 6, cy + 7); ctx.closePath(); ctx.fill();
  ctx.restore();
}

/* ---------- Input ---------- */
function doAction(name) {
  switch (name) {
    case 'camera': Cam.cycle(); break;
    case 'lights':
      car.lights = !car.lights;
      applyLights();
      break;
    case 'menu': openMenu(); break;
    case 'mute': {
      const m = AudioFX.toggleMute();
      const b = document.querySelector('[data-act="mute"] i');
      if (b) b.className = m ? 'fa-solid fa-volume-xmark' : 'fa-solid fa-volume-high';
      break;
    }
    case 'reset': resetCar(); break;
    case 'help': hud.help.classList.toggle('off'); break;
    case 'paint': setPaint((paintIndex + 1) % CONFIG.paints.length); break;
    default: break;
  }
}

// On-screen controls (phones/tablets): multi-touch, so you can steer and press the gas together.
function setupTouch() {
  const root = $('touch');
  root.querySelectorAll('[data-key]').forEach((btn) => {
    const k = btn.dataset.key;
    const press = (e) => {
      e.preventDefault();
      input[k] = true; btn.classList.add('pressed');
      try { btn.setPointerCapture(e.pointerId); } catch (_) { /* older browsers */ }
    };
    const release = (e) => { e.preventDefault(); input[k] = false; btn.classList.remove('pressed'); };
    btn.addEventListener('pointerdown', press);
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((ev) => btn.addEventListener(ev, release));
  });
  root.querySelectorAll('[data-act]').forEach((btn) => {
    btn.addEventListener('pointerdown', (e) => { e.preventDefault(); doAction(btn.dataset.act); });
  });
  root.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
}
const keyMap = { KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down', KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right', Space: 'brake' };
let started = false;
let state = 'menu';      // 'menu' (showroom behind the main menu) or 'play'
let ready = false;

window.addEventListener('keydown', (e) => {
  if (keyMap[e.code]) { if (state === 'play') input[keyMap[e.code]] = true; e.preventDefault(); }
  if (!e.repeat) {
    switch (e.code) {
      case 'KeyV': doAction('camera'); break;
      case 'KeyL': doAction('lights'); break;
      case 'KeyM': doAction('mute'); break;
      case 'KeyR': doAction('reset'); break;
      case 'KeyH': doAction('help'); break;
      case 'Digit1': case 'Digit2': case 'Digit3': case 'Digit4': setPaint(+e.code.slice(5) - 1); break;
      default: break;
    }
  }
  if (e.code === 'Escape' && !e.repeat) { if (state === 'play') openMenu(); else if (started) startPlay(); }
  else if (e.code === 'Enter' && state === 'menu') startPlay();
});
window.addEventListener('keyup', (e) => { if (keyMap[e.code]) { input[keyMap[e.code]] = false; e.preventDefault(); } });
window.addEventListener('blur', () => {
  for (const k in input) input[k] = false;
  document.querySelectorAll('.pressed').forEach((b) => b.classList.remove('pressed'));
});
$('startBtn').addEventListener('click', () => { if (state === 'menu') startPlay(); });
$('menuBtn').addEventListener('click', () => openMenu());

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  Smoke.mat.uniforms.scale.value = window.innerHeight / 2;
});

/* ---------- Visual update from physics state ---------- */
const _wp = new THREE.Vector3();
function updateCarVisual(dt) {
  const onCurb = Math.abs(car.x) > 12.1 && Math.abs(car.x) < 17.6;
  car.y = damp(car.y, onCurb ? 0.15 : 0, 14, dt);
  player.root.position.set(car.x, car.y, car.z);
  player.root.rotation.y = car.yaw;
  car.pitch = damp(car.pitch, clamp(-car.aF * 0.0045, -0.06, 0.06), 6, dt);
  car.roll = damp(car.roll, clamp(car.aLat * 0.006, -0.08, 0.08), 6, dt);
  player.body.rotation.set(car.pitch, 0, car.roll);
  for (const w of player.wheels) {
    w.spin.rotation.x = car.spin;
    if (w.front) w.steer.rotation.y = car.steerVis;
  }
  const braking = car.brake > 0.1 || car.hb;
  player.tailMat.emissiveIntensity = damp(player.tailMat.emissiveIntensity, braking ? 3.2 : (car.lights ? 0.9 : 0.35), 20, dt);
  player.root.updateMatrixWorld(true);

  // skid marks + smoke from rear wheels
  const slideSkid = car.slip > 0.2 && Math.hypot(car.vx, car.vz) > 5;
  const lockSkid = car.hb && Math.hypot(car.vx, car.vz) > 4;
  const hardBrake = car.brake > 0.9 && Math.hypot(car.vx, car.vz) > 22;
  const heading = Math.atan2(car.vx, car.vz);
  for (let i = 0; i < 2; i++) {
    const w = player.wheels[2 + i];
    if (state === 'play' && (slideSkid || lockSkid || hardBrake)) {
      w.steer.getWorldPosition(_wp);
      Skids.add(i, _wp.x, _wp.z, heading);
      if (Math.random() < 0.55) Smoke.emit(_wp.x, 0.15, _wp.z, car.vx, car.vz);
    } else Skids.lift(i);
  }
}

/* ---------- HUD: coins, level, quest tracker, run banner ---------- */
hud.coinEl = $('hudCoins'); hud.lvlEl = $('hudLevel'); hud.xpEl = $('hudXp');
hud.tracker = $('tracker'); hud.runBanner = $('runBanner'); hud.runText = $('runText'); hud.routeName = $('routeName');
const fmt = (n) => Math.floor(n).toLocaleString();
let hudAcc = 1, lastTracker = '', lastCoins = -1;
function updateHudExtra(dt) {
  hudAcc += dt;
  if (coinPulse) {
    coinPulse = false;
    const el = hud.coinEl.parentNode;
    el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
  }
  if (hudAcc < 0.15) return;
  hudAcc = 0;
  if (Save.data.coins !== lastCoins) { hud.coinEl.textContent = fmt(Save.data.coins); lastCoins = Save.data.coins; }
  const li = levelInfo(Save.data.xp);
  hud.lvlEl.textContent = 'Lv ' + li.lvl;
  hud.xpEl.style.width = (li.rem / li.need * 100).toFixed(0) + '%';
  let html = '';
  for (const q of Quests.list()) {
    html += '<div class="q"><div class="q-t">' + Quests.text(q) + '</div><div class="q-bar"><i style="width:' +
      (clamp(q.progress / q.target, 0, 1) * 100).toFixed(0) + '%"></i></div><small>' + Quests.progressText(q) + '</small></div>';
  }
  if (html !== lastTracker) { hud.tracker.innerHTML = html; lastTracker = html; }
  hud.runBanner.classList.toggle('on', Run.active);
  if (Run.active) hud.runText.textContent = Math.max(0, Math.round(Run.z - car.z)) + ' m to beacon  |  ' + Math.max(0, Math.ceil(Run.time)) + ' s';
}

/* ---------- Car swapping (garage preview + play) ---------- */
function disposeCar(c) { c.paintMat.dispose(); c.tailMat.dispose(); c.headMat.dispose(); }
function setPlayerCar(id) {
  const spec = carById(id);
  if (player) { scene.remove(player.root); disposeCar(player); }
  player = buildCar({ paint: CONFIG.paints[0].color, detail: true, player: true, shape: spec.shape, blackRoof: spec.blackRoof });
  player.id = id;
  player.root.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  scene.add(player.root);
  stats = Object.assign({}, spec.stats);
  if (id === 'camry') tryLoadGLB(CONFIG.modelUrl, player);
  const saved = Save.data.paint[id];
  setPaint(saved != null ? saved : spec.paint);
  applyLights();
}
function setWorldVisible(v) {
  traffic.forEach((n) => { n.car.root.visible = v; });
  Coins.mesh.visible = v;
  if (Run.group) Run.group.visible = v && Run.active;
}

/* ---------- Main menu ---------- */
const menuUI = { root: $('menu'), body: $('tabBody'), tabs: $('tabs'), coins: $('menuCoins'), label: $('startLabel'), btn: $('startBtn'), hint: $('loadingText'), tab: 'drive', preview: null };
const meter = (label, v) => '<div class="stat"><span>' + label + '</span><div class="meter"><i style="width:' + clamp(v, 6, 100).toFixed(0) + '%"></i></div></div>';
const hexStr = (c) => '#' + c.toString(16).padStart(6, '0');

function summaryHTML() {
  const li = levelInfo(Save.data.xp);
  return '<div class="summary"><div class="sum-top"><span class="lvl">Level ' + li.lvl + '</span><span class="rank">' + rankOf(li.lvl) + '</span></div>' +
    '<div class="xpbar"><i style="width:' + (li.rem / li.need * 100).toFixed(0) + '%"></i></div>' +
    '<small>' + fmt(li.rem) + ' / ' + fmt(li.need) + ' xp to level ' + (li.lvl + 1) + '</small></div>';
}
function questListHTML() {
  return '<div class="quests">' + Quests.list().map((q) =>
    '<div class="quest"><div class="q-row"><b>' + Quests.text(q) + '</b><span class="reward"><i class="fa-solid fa-coins"></i> ' + q.reward + '</span></div>' +
    '<div class="meter"><i style="width:' + (clamp(q.progress / q.target, 0, 1) * 100).toFixed(0) + '%"></i></div>' +
    '<small>' + Quests.progressText(q) + ' &middot; +' + q.xp + ' xp</small></div>').join('') + '</div>';
}
function renderDrive() {
  const lvl = levelInfo(Save.data.xp).lvl;
  let h = summaryHTML() + '<h4>Choose a route</h4><div class="routes">';
  for (const r of ROUTES) {
    const locked = lvl < r.level, sel = Save.data.route === r.id;
    h += '<button type="button" class="route' + (sel ? ' sel' : '') + (locked ? ' locked' : '') + '" data-route="' + r.id + '">' +
      '<span class="route-ic"><i class="fa-solid ' + r.icon + '"></i></span>' +
      '<span class="route-tx"><b>' + r.name + '</b><em>' + r.mood + '</em><small>' + r.desc + '</small></span>' +
      '<span class="route-tag">' + (locked ? '<i class="fa-solid fa-lock"></i> Lv ' + r.level : (sel ? 'Selected' : '')) + '</span></button>';
  }
  return h + '</div><h4>Active quests</h4>' + questListHTML();
}
function carRatings(spec) {
  const acc = (g) => g.stats.torque * g.stats.traction / (g.stats.mass / 1000);
  const maxA = Math.max(...GARAGE.map(acc));
  return { speed: (spec.stats.vmax - 40) / 60 * 100, accel: acc(spec) / maxA * 100, grip: (spec.stats.grip - 0.9) / 0.5 * 100 };
}
function renderGarage() {
  const lvl = levelInfo(Save.data.xp).lvl, sel = menuUI.preview || Save.data.car;
  let h = '<div class="garage">';
  for (const g of GARAGE) {
    const owned = Save.data.owned.includes(g.id), active = Save.data.car === g.id, locked = !owned && lvl < g.level, r = carRatings(g);
    let action;
    if (owned) action = active ? '<span class="pill ok"><i class="fa-solid fa-check"></i> Driving</span>' : '<button type="button" class="btn small" data-act="use:' + g.id + '">Drive this</button>';
    else if (locked) action = '<span class="pill lock"><i class="fa-solid fa-lock"></i> Level ' + g.level + '</span>';
    else action = '<button type="button" class="btn small gold" data-act="buy:' + g.id + '"' + (Save.data.coins < g.price ? ' disabled' : '') + '><i class="fa-solid fa-coins"></i> ' + fmt(g.price) + '</button>';
    h += '<div class="car-card' + (sel === g.id ? ' sel' : '') + '" data-car="' + g.id + '"><div class="car-top"><div><h3>' + g.name + '</h3><p>' + g.tag + '</p></div>' + action + '</div>' +
      meter('Speed', r.speed) + meter('Accel', r.accel) + meter('Grip', r.grip) + '</div>';
  }
  h += '</div><h4>Paint</h4><div class="paints">' + CONFIG.paints.map((p, i) =>
    '<button type="button" class="swatch-btn' + (player.paintIdx === i ? ' sel' : '') + '" data-act="paint:' + i + '" title="' + p.name + '" aria-label="' + p.name + '" style="--c:' + hexStr(p.color) + '"></button>').join('') + '</div>';
  return h;
}
function renderCareer() {
  const li = levelInfo(Save.data.xp), S = Save.data.stats;
  const cell = (label, val) => '<div class="cell"><b>' + val + '</b><span>' + label + '</span></div>';
  let h = summaryHTML() + '<div class="cells">' +
    cell('Distance', (S.distance / 1609.34).toFixed(1) + ' mi') + cell('Top speed', Math.round(S.topSpeed) + ' mph') +
    cell('Best drift', fmt(S.bestDrift)) + cell('Coins earned', fmt(S.coins)) +
    cell('Near misses', fmt(S.nearMiss)) + cell('Quests done', fmt(S.quests)) +
    cell('Crashes', fmt(S.crashes)) + cell('Cars owned', Save.data.owned.length + '/' + GARAGE.length) + '</div>';
  h += '<h4>Career ladder</h4><ol class="ladder">';
  RANKS.forEach((r, i) => { const need = i * 2 + 1; h += '<li class="' + (li.lvl >= need ? 'done' : '') + '"><span>' + r + '</span><em>Level ' + need + '</em></li>'; });
  return h + '</ol><button type="button" class="btn ghost small" data-act="reset-save">Reset progress</button>';
}
function renderQuests() {
  return '<p class="lead">Three quests are always active. Finish one and a new one takes its place. Goals grow as you complete more.</p>' + questListHTML() +
    '<p class="lead small">Quests done: ' + fmt(Save.data.stats.quests) + '. Coins and near misses count while you drive.</p>';
}
function renderMenu() {
  menuUI.coins.textContent = fmt(Save.data.coins);
  menuUI.tabs.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === menuUI.tab));
  const view = { drive: renderDrive, garage: renderGarage, career: renderCareer, quests: renderQuests }[menuUI.tab];
  const top = menuUI.body.scrollTop;
  menuUI.body.innerHTML = view();
  menuUI.body.scrollTop = top;
  menuUI.label.textContent = started ? 'Resume driving' : 'Start driving';
  menuUI.btn.classList.toggle('ready', ready);
}
function handleMenuAct(a) {
  const [kind, arg] = a.split(':');
  if (kind === 'buy') {
    const g = carById(arg);
    if (Save.data.owned.includes(g.id) || Save.data.coins < g.price || levelInfo(Save.data.xp).lvl < g.level) return;
    Save.data.coins -= g.price; Save.data.owned.push(g.id); Save.data.car = g.id;
    menuUI.preview = g.id;
    if (player.id !== g.id) setPlayerCar(g.id); else setPaint(player.paintIdx);
    AudioFX.chime();
  } else if (kind === 'use') {
    Save.data.car = arg; menuUI.preview = arg;
    if (player.id !== arg) setPlayerCar(arg);
  } else if (kind === 'paint') {
    setPaint(+arg);
  } else if (kind === 'reset-save') {
    if (!window.confirm('Reset all coins, cars, XP and quests?')) return;
    Save.reset(); Quests.init(); menuUI.preview = null; Run.cancel();
    setPlayerCar('camry'); applyRoute(ROUTES[0]); Coins.reset(); resetTraffic();
  }
  Save.save();
  renderMenu();
}
menuUI.tabs.addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (b) { menuUI.tab = b.dataset.tab; renderMenu(); }
});
menuUI.body.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]');
  if (act) { handleMenuAct(act.dataset.act); return; }
  const rt = e.target.closest('[data-route]');
  if (rt) {
    const r = routeById(rt.dataset.route);
    if (levelInfo(Save.data.xp).lvl < r.level) return;
    Save.data.route = r.id; Save.save();
    if (currentRoute.id !== r.id) applyRoute(r);
    renderMenu();
    return;
  }
  const cc = e.target.closest('[data-car]');
  if (cc && cc.dataset.car !== player.id) { menuUI.preview = cc.dataset.car; setPlayerCar(cc.dataset.car); renderMenu(); }
});

/* ---------- State changes ---------- */
let playedRoute = null;
function openMenu(tab) {
  if (state === 'menu') return;
  state = 'menu';
  for (const k in input) input[k] = false;
  document.querySelectorAll('.pressed').forEach((b) => b.classList.remove('pressed'));
  menuUI.root.classList.remove('gone');
  hud.root.classList.add('hidden');
  if (IS_MOBILE) $('touch').classList.add('hidden');
  setWorldVisible(false);
  AudioFX.silence();
  Save.save();
  Cam.menuT = car.yaw + Math.PI + 0.6;
  menuUI.preview = null;
  if (tab) menuUI.tab = tab;
  renderMenu();
}
function startPlay() {
  if (!ready || state === 'play') return;
  const first = !started;
  started = true;
  AudioFX.init();
  const lvl = levelInfo(Save.data.xp).lvl;
  let route = routeById(Save.data.route);
  if (route.level > lvl) { route = ROUTES[0]; Save.data.route = route.id; }
  if (currentRoute.id !== route.id) applyRoute(route);
  if (playedRoute !== route.id) { resetTraffic(); Coins.reset(); Run.cancel(); playedRoute = route.id; }
  if (!Save.data.owned.includes(Save.data.car)) Save.data.car = 'camry';
  if (player.id !== Save.data.car) setPlayerCar(Save.data.car);
  Quests.init();
  state = 'play';
  menuUI.root.classList.add('gone');
  hud.root.classList.remove('hidden');
  hud.routeName.textContent = route.name + ', Los Angeles';
  camera.clearViewOffset();
  Cam.snap = true;
  setWorldVisible(true);
  if (route.night && !car.lights) car.lights = true;
  applyLights();
  lastTracker = '';
  if (IS_MOBILE) {
    $('touch').classList.remove('hidden');
    const el = document.documentElement;
    if (first && !document.fullscreenElement && el.requestFullscreen) el.requestFullscreen().catch(() => {});
  }
  if (first) setTimeout(() => hud.help.classList.add('off'), 15000);
}

/* ---------- Boot + loop ---------- */
const clock = new THREE.Clock();
let acc = 0, saveAcc = 0;

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);
  const play = state === 'play';

  if (play) {
    acc += dt;
    while (acc >= FIXED_DT) { stepCar(FIXED_DT); acc -= FIXED_DT; }
    updateTraffic(dt);
    trackDriving(dt);
    Run.update(dt);
  } else acc = 0;

  Coins.update(dt, play);
  updateSegments(car.z);
  updateCarVisual(dt);
  Smoke.update(dt);
  if (play) Cam.update(dt); else Cam.menuOrbit(dt);
  updateSun(car.x, car.z);

  skyMesh.position.copy(camera.position);
  backdrop.position.set(car.x, 0, car.z);
  if (play) {
    AudioFX.update(car.rpm, car.throttle, car.slip, Math.hypot(car.vx, car.vz));
    updateHUD(dt);
    drawMinimap();
    updateHudExtra(dt);
  }
  saveAcc += dt;
  if (saveAcc > 3) { saveAcc = 0; if (Save.dirty) { Save.save(); Save.dirty = false; } }
  renderer.render(scene, camera);
}

function boot() {
  initSegments();
  const owned = Save.data.owned.includes(Save.data.car) ? Save.data.car : 'camry';
  Save.data.car = owned;
  setPlayerCar(owned);
  Run.build();
  initTraffic();
  car.x = START.x; car.z = START.z;
  for (const n of traffic) if (Math.abs(n.z - car.z) < 60 && Math.abs(n.x - car.x) < 3) n.z += 120;
  Quests.init();
  const r = routeById(Save.data.route);
  applyRoute(levelInfo(Save.data.xp).lvl >= r.level ? r : ROUTES[0]);
  setWorldVisible(false);

  if (IS_MOBILE) setupTouch();   // wire the on-screen gas/brake/steer buttons
  ready = true;
  menuUI.hint.textContent = IS_MOBILE ? 'Tap Start. Drive with the on-screen buttons.' : 'Press Enter to start. Esc opens this menu any time.';
  renderMenu();
  frame();
}
window.addEventListener('pagehide', () => Save.save());
document.addEventListener('visibilitychange', () => { if (document.hidden) Save.save(); });

// Let the loading text paint before the (synchronous) texture generation kicks in.
setTimeout(boot, 60);

})();

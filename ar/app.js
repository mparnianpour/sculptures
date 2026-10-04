import * as THREE from 'three';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import { DRACOLoader } from './vendor/DRACOLoader.js';
import { MeshoptDecoder } from './vendor/meshopt_decoder.module.js';
import { RoomEnvironment } from './vendor/RoomEnvironment.js';

// 8th Wall's three.js module looks for a global THREE.
window.THREE = THREE;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
// The sculpture list comes from your model library (config.json → catalogUrl).
// If that's empty or unreachable, this built-in list is used instead.
const BUILT_IN_CATALOG = {
  models: [{ id: 'sc3', title: 'sc3', file: '../models/sc3.glb', thumbnail: '../thumbs/sc3-6f377de18f.png', size: 1 }],
};
const MAX_PIXEL_RATIO = 2;
const PLACE_SAMPLES = 6;          // image poses averaged before the sculpture is placed
const FOLLOW_ALPHA = 0.04;        // slowest sideways/turn correction from later sightings of the image
const DEADBAND_DIST = 0.01;       // ignore corrections smaller than 1% of the image width…
const DEADBAND_ANGLE = 0.02;      // …or ~1°
const DESKTOP_ALPHA = 0.3;        // smoothing when there is no world tracking (desktop webcams)
const DEBUG = new URLSearchParams(location.search).has('debug');

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const ui = {
  setup: $('setup'), ar: $('ar'), arUi: $('ar-ui'), xrCanvas: $('xr-canvas'), preview: $('preview'), status: $('status'),
  file: $('file'), chooseText: $('choose-text'), start: $('start'), back: $('back'), replace: $('replace'),
  size: $('size'), sizeAr: $('size-ar'), sizeOut: $('size-out'), hint: $('hint'), error: $('error'),
  frameNote: $('frame-note'), picker: $('picker'), pickerRow: $('picker-row'),
  pickerAr: $('picker-ar'),
};

const state = {
  mode: 'table',
  size: 1,
  aspect: 0.75,         // tracked region: height / width
  target: null,         // 8th Wall image target data
  targetUrl: null,
  rig: null,
  models: [],           // catalog entries
  modelId: null,        // selected entry id
  rigs: new Map(),      // id → loaded rig (cached)
  loadToken: 0,
  xrReady: false,
  running: false,
  worldTracking: true,
};

const inFrame = (() => { try { return window.self !== window.top; } catch { return true; } })();
const openInTabLink = `<a href="${location.href}" target="_blank" rel="noopener">Open this page in its own tab</a>`;
if (inFrame) {
  ui.frameNote.innerHTML = `For the steadiest view, ${openInTabLink.replace('Open', 'open')}.`;
  ui.frameNote.hidden = false;
}

// ---------------------------------------------------------------------------
// The rig: sculpture + light + shadow catcher, in "image space".
// Image space: the tracked image is 1 unit wide, centred at the origin, in the
// XY plane (+Y = top of the image) with +Z pointing out of the image.
// ---------------------------------------------------------------------------
function createRig(gltf) {
  const model = gltf.scene;
  model.updateMatrixWorld(true);

  // Animated pieces keep their own pivot (it's the spin axis). Still pieces are
  // centred on their footprint, so they land on the image even if the Blender
  // origin is somewhere else.
  const animated = gltf.animations.length > 0;
  const v = new THREE.Vector3();
  const meshes = [];
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  model.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = false;
    o.frustumCulled = false;
    meshes.push(o);
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x;
      if (v.y < minY) minY = v.y; if (v.y > maxY) maxY = v.y;
      if (v.z < minZ) minZ = v.z; if (v.z > maxZ) maxZ = v.z;
    }
  });
  const cx = animated ? 0 : (minX + maxX) / 2;
  const cz = animated ? 0 : (minZ + maxZ) / 2;
  let maxR = 0;
  for (const o of meshes) {
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      const r = Math.hypot(v.x - cx, v.z - cz);
      if (r > maxR) maxR = r;
    }
  }
  const height = maxY - minY;
  const diameter = 2 * maxR;

  const mixer = new THREE.AnimationMixer(model);
  for (const clip of gltf.animations) {
    mixer.clipAction(clip).setLoop(THREE.LoopRepeat, Infinity).play();
  }

  const root = new THREE.Group();
  const placement = new THREE.Group();
  const scaler = new THREE.Group();
  root.add(placement);
  placement.add(scaler);
  model.position.set(-cx, -minY, -cz);
  scaler.add(model);

  const sun = new THREE.DirectionalLight(0xffffff, 2.0);
  const L = (height + diameter) * 1.4;
  sun.position.set(L * 0.35, L, L * 0.45);
  sun.target.position.set(0, height * 0.35, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.bias = -0.0008;
  scaler.add(sun, sun.target);
  const shadowExtent = Math.max(maxR, height) * 1.7;
  const shadowFar = L * 2.2 + shadowExtent;

  const catcher = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.ShadowMaterial({ opacity: 0.22, depthWrite: false })
  );
  catcher.receiveShadow = true;
  catcher.renderOrder = -1;
  root.add(catcher);

  const tmpScale = new THREE.Vector3();

  function layout() {
    const s = state.size / diameter;
    scaler.scale.setScalar(s);
    if (state.mode === 'table') {
      placement.rotation.set(Math.PI / 2, 0, 0);
      placement.position.set(0, 0, 0);
      catcher.scale.setScalar(Math.max(2, state.size * 2.6));
    } else {
      placement.rotation.set(0, 0, 0);
      placement.position.set(0, -height * s * 0.5, maxR * s + 0.01);
      catcher.scale.set(1, state.aspect, 1);
    }
  }

  function update(dt) {
    mixer.update(dt);
    scaler.updateWorldMatrix(true, false);
    const ws = scaler.getWorldScale(tmpScale).x;
    const cam = sun.shadow.camera;
    const e = shadowExtent * ws;
    if (Math.abs(cam.right - e) > e * 1e-4) {
      cam.left = -e; cam.right = e; cam.top = e; cam.bottom = -e;
      cam.near = 0.01 * L * ws;
      cam.far = shadowFar * ws;
      cam.updateProjectionMatrix();
    }
  }

  layout();
  return { root, layout, update, height, diameter };
}

// ---------------------------------------------------------------------------
// Preview stage (setup screen)
// ---------------------------------------------------------------------------
const preview = (() => {
  const renderer = new THREE.WebGLRenderer({ canvas: ui.preview, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;

  const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 100);
  const anchor = new THREE.Group();
  scene.add(anchor);

  const cardMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, toneMapped: false });
  const card = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), cardMat);
  card.position.z = -0.002;
  anchor.add(card);
  const outline = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1)),
    new THREE.LineBasicMaterial({ color: 0x8b949b, toneMapped: false })
  );
  outline.position.z = -0.001;
  outline.scale.set(1, state.aspect, 1);
  anchor.add(outline);

  const clock = new THREE.Clock();
  const target = new THREE.Vector3();
  let running = false;

  function resize() {
    const w = ui.preview.clientWidth, h = ui.preview.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function frame() {
    // Fit the image, the sculpture's footprint and its height (tall models need more room).
    const hgt = state.rig ? state.size * state.rig.height / state.rig.diameter : 0.3;
    const k = Math.max(1, state.aspect, state.size * 1.05, hgt * 1.15);
    if (state.mode === 'table') {
      anchor.rotation.set(-Math.PI / 2, 0, 0);
      target.set(0, hgt * 0.5, 0.05 * k);
      camera.position.set(0, 1.05 * k + hgt * 0.5, 1.75 * k);
    } else {
      anchor.rotation.set(0, 0, 0);
      target.set(0, 0, state.size * 0.25);
      camera.position.set(0, 0.35 * k, 2.6 * k);
    }
    camera.lookAt(target);
  }

  function setImage(canvas) {
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    if (cardMat.map) cardMat.map.dispose();
    cardMat.map = tex;
    cardMat.opacity = 1;
    cardMat.transparent = false;
    cardMat.needsUpdate = true;
    card.scale.set(1, state.aspect, 1);
    outline.visible = false;
    frame();
  }

  function attach(object) { anchor.add(object); }

  function loop() {
    if (!running) return;
    const dt = Math.min(clock.getDelta(), 0.1);
    if (state.rig) state.rig.update(dt);
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  }

  function start() {
    if (running) return;
    running = true;
    clock.getDelta();
    resize();
    frame();
    requestAnimationFrame(loop);
  }

  function stop() { running = false; }

  new ResizeObserver(resize).observe(ui.preview);
  return { setImage, attach, start, stop, frame };
})();

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------
function setStatus(text, tone = '') {
  ui.status.textContent = text;
  ui.status.className = 'stage-status' + (tone ? ' ' + tone : '');
}

function showError(html) {
  ui.error.hidden = !html;
  ui.error.innerHTML = html || '';
}

function setHint(text) {
  if (text) { ui.hint.textContent = text; ui.hint.classList.remove('found'); }
  else ui.hint.classList.add('found');
}

function refreshStart() {
  ui.start.disabled = !(state.target && state.rig && state.xrReady);
}

// ---------------------------------------------------------------------------
// Image → 8th Wall image target, built in the browser.
// Same output as 8th Wall's image-target-cli: the centre 3:4 region (4:3 for
// landscape images, stored rotated) as a 480×640 greyscale "luminance" image.
// ---------------------------------------------------------------------------
async function decodeImage(file) {
  if ('createImageBitmap' in window) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* fall through */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function centreCrop(w, h, aspectWH) {
  if (w / h > aspectWH) {
    const cw = Math.round(h * aspectWH);
    return { x: Math.round((w - cw) / 2), y: 0, w: cw, h };
  }
  const ch = Math.round(w / aspectWH);
  return { x: 0, y: Math.round((h - ch) / 2), w, h: ch };
}

// How much usable detail the image has (share of pixels with strong edges).
function detailScore(source) {
  const W = 200;
  const k = W / Math.max(source.width, source.height);
  const c = document.createElement('canvas');
  c.width = Math.max(8, Math.round(source.width * k));
  c.height = Math.max(8, Math.round(source.height * k));
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(source, 0, 0, c.width, c.height);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  const lum = new Float32Array(c.width * c.height);
  for (let i = 0; i < lum.length; i++) lum[i] = (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3;
  let strong = 0, n = 0;
  for (let y = 0; y < c.height - 1; y++) {
    for (let x = 0; x < c.width - 1; x++) {
      const i = y * c.width + x;
      const gsum = Math.abs(lum[i + 1] - lum[i]) + Math.abs(lum[i + c.width] - lum[i]);
      if (gsum > 40) strong++;
      n++;
    }
  }
  return (strong / n) * 100;
}

async function buildTarget(img) {
  const landscape = img.width >= img.height;

  // What the visitor sees: the region that will actually be tracked.
  const vis = centreCrop(img.width, img.height, landscape ? 4 / 3 : 3 / 4);
  const display = document.createElement('canvas');
  const dk = Math.min(1, 1200 / Math.max(vis.w, vis.h));
  display.width = Math.round(vis.w * dk);
  display.height = Math.round(vis.h * dk);
  display.getContext('2d').drawImage(img, vis.x, vis.y, vis.w, vis.h, 0, 0, display.width, display.height);

  // 8th Wall format: landscape images are rotated 90° clockwise to portrait.
  const rw = landscape ? img.height : img.width;
  const rh = landscape ? img.width : img.height;
  const up = Math.max(1, 480 / rw, 640 / rh);       // engine needs at least 480×640
  const W = Math.round(rw * up), H = Math.round(rh * up);
  const crop = centreCrop(W, H, 3 / 4);
  const rotated = document.createElement('canvas');
  rotated.width = W; rotated.height = H;
  const rg = rotated.getContext('2d');
  if (landscape) { rg.translate(W, 0); rg.rotate(Math.PI / 2); rg.drawImage(img, 0, 0, H, W); }
  else rg.drawImage(img, 0, 0, W, H);

  const lum = document.createElement('canvas');
  lum.width = Math.round(crop.w * 640 / crop.h);
  lum.height = 640;
  const lg = lum.getContext('2d', { willReadFrequently: true });
  lg.drawImage(rotated, crop.x, crop.y, crop.w, crop.h, 0, 0, lum.width, lum.height);
  const px = lg.getImageData(0, 0, lum.width, lum.height);
  for (let i = 0; i < px.data.length; i += 4) {
    const y = 0.299 * px.data[i] + 0.587 * px.data[i + 1] + 0.114 * px.data[i + 2];
    px.data[i] = px.data[i + 1] = px.data[i + 2] = y;
  }
  lg.putImageData(px, 0, 0);
  const blob = await new Promise((r) => lum.toBlob(r, 'image/jpeg', 0.92));
  if (state.targetUrl) URL.revokeObjectURL(state.targetUrl);
  state.targetUrl = URL.createObjectURL(blob);

  const now = Date.now();
  const target = {
    imagePath: state.targetUrl,
    metadata: null,
    name: 'visitor-image',
    type: 'PLANAR',
    properties: {
      top: crop.y, left: crop.x, width: crop.w, height: crop.h,
      isRotated: landscape, originalWidth: W, originalHeight: H,
    },
    resources: {},
    created: now,
    updated: now,
  };
  const cropped = landscape ? (img.width / img.height) / (4 / 3) : (img.height / img.width) / (4 / 3);
  return { target, display, aspect: display.height / display.width, croppedAway: Math.abs(1 - cropped) };
}

async function prepareTarget(file) {
  showError('');
  state.target = null;
  refreshStart();
  setStatus('Opening your image…');
  let img;
  try {
    img = await decodeImage(file);
  } catch {
    setStatus('Choose an image to begin');
    showError('That file could not be opened as an image. Choose a JPG or PNG.');
    return;
  }
  if (Math.min(img.width, img.height) < 200) {
    setStatus('Choose an image to begin');
    showError('That image is too small. Choose one at least 480 pixels on its short side.');
    return;
  }

  const built = await buildTarget(img);
  state.aspect = built.aspect;
  if (state.rig) state.rig.layout();
  preview.setImage(built.display);
  ui.chooseText.textContent = 'Choose another image';

  const score = detailScore(built.display);
  window.__detail = score;
  if (score < 1) {
    setStatus('This image is too plain to track.', 'warn');
    showError('Choose an image with more detail: edges, texture, text or shapes. Plain colours and gradients can\'t be tracked.');
    return;
  }
  state.target = built.target;
  let msg = score < 4
    ? 'Ready, but this image has little detail, so it may take longer to find. A busier image works better.'
    : 'Ready. Start the camera and point it at this image.';
  if (built.croppedAway > 0.15) msg += ' Only the part shown here is used for tracking.';
  setStatus(msg, score < 4 ? 'warn' : 'good');
  refreshStart();
}

// ---------------------------------------------------------------------------
// Placement
//   1. Find the floor (8th Wall absolute scale: metres, floor at y = 0).
//   2. The image places the sculpture once, upright, and its height above the
//      floor is locked for the whole session.
//   3. Later sightings of the image may only slide it sideways and turn it,
//      smoothly — never move it up or down, never tilt it.
// ---------------------------------------------------------------------------
const UP = new THREE.Vector3(0, 1, 0);
const anchor = {
  group: new THREE.Group(),
  placed: false,
  samples: [],
  pos: new THREE.Vector3(),
  quat: new THREE.Quaternion(),
  scale: 1,
};
anchor.group.visible = false;

const floor = {
  ready: false,
  normalSince: 0,       // when tracking first reported NORMAL (ms)
  startedAt: 0,
  altitude: null,       // locked height of the image centre above the floor (metres)
  ring: null,
};

const _fwd = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();

function poseFrom(detail) {
  return {
    pos: new THREE.Vector3(detail.position.x, detail.position.y, detail.position.z),
    quat: new THREE.Quaternion(detail.rotation.x, detail.rotation.y, detail.rotation.z, detail.rotation.w).normalize(),
    scale: detail.scale * detail.scaledWidth,   // world size of 1 image width
  };
}

function applyAnchor() {
  anchor.group.position.copy(anchor.pos);
  anchor.group.quaternion.copy(anchor.quat);
  anchor.group.scale.setScalar(anchor.scale);
}

function averagePoses(list) {
  const pos = new THREE.Vector3();
  let scale = 0;
  const ref = list[0].quat;
  const q = new THREE.Vector4();
  for (const p of list) {
    pos.add(p.pos);
    scale += p.scale;
    const sign = (p.quat.x * ref.x + p.quat.y * ref.y + p.quat.z * ref.z + p.quat.w * ref.w) < 0 ? -1 : 1;
    q.x += sign * p.quat.x; q.y += sign * p.quat.y; q.z += sign * p.quat.z; q.w += sign * p.quat.w;
  }
  pos.multiplyScalar(1 / list.length);
  return { pos, quat: new THREE.Quaternion(q.x, q.y, q.z, q.w).normalize(), scale: scale / list.length };
}

// Is the image lying flat (table) or standing up (wall)? Decided from gravity.
function orientationOf(quat) {
  _normal.set(0, 0, 1).applyQuaternion(quat);
  return Math.abs(_normal.y) > 0.6 ? 'table' : 'wall';
}

// Same image pose, but with "up" forced to true vertical.
//   table: anchor +Z = world up, X = the image's left→right direction on the table.
//   wall:  anchor +Y = world up, Z = out of the wall, horizontal.
function uprightQuat(quat, mode) {
  _m.makeRotationFromQuaternion(quat);
  if (mode === 'table') {
    _z.copy(UP);
    _x.setFromMatrixColumn(_m, 0).projectOnPlane(UP);
    if (_x.lengthSq() < 1e-8) _x.setFromMatrixColumn(_m, 1).projectOnPlane(UP).applyAxisAngle(UP, -Math.PI / 2);
    _x.normalize();
    _y.crossVectors(_z, _x);
  } else {
    _y.copy(UP);
    _z.setFromMatrixColumn(_m, 2).projectOnPlane(UP);
    if (_z.lengthSq() < 1e-8) _z.set(0, 0, 1);
    _z.normalize();
    _x.crossVectors(_y, _z);
  }
  return new THREE.Quaternion().setFromRotationMatrix(_m.makeBasis(_x, _y, _z));
}

function setMode(mode) {
  if (state.mode === mode) return;
  state.mode = mode;
  const radio = document.querySelector(`input[name="mode"][value="${mode}"]`);
  if (radio) radio.checked = true;
  if (state.rig) state.rig.layout();
}

function resetPlacement() {
  anchor.placed = false;
  anchor.samples = [];
  anchor.group.visible = false;
  ui.replace.hidden = true;
  if (state.worldTracking && !floor.ready) setHint('Point at the floor and move your phone slowly');
  else setHint('Point your camera at your image');
}

function placeFromSamples() {
  const avg = averagePoses(anchor.samples);
  anchor.samples = [];
  const mode = orientationOf(avg.quat);
  setMode(mode);
  if (floor.altitude === null) floor.altitude = avg.pos.y;  // locked for the session
  anchor.pos.set(avg.pos.x, floor.altitude, avg.pos.z);
  anchor.quat.copy(uprightQuat(avg.quat, mode));
  anchor.scale = avg.scale;                                   // size locked too
  anchor.placed = true;
  applyAnchor();
  anchor.group.visible = true;
  ui.replace.hidden = false;
  if (floor.ring) floor.ring.visible = false;
  window.__placed = { altitude: floor.altitude, mode, scale: anchor.scale };
  setHint(mode === 'table' ? 'Placed on the table. Walk around it.' : 'Placed in front of the wall. Walk around it.');
  clearTimeout(placeFromSamples.t);
  placeFromSamples.t = setTimeout(() => setHint(null), 2500);
}

function onImagePose(detail, camera) {
  const p = poseFrom(detail);
  if (debugCard) {
    debugCard.position.copy(p.pos); debugCard.quaternion.copy(p.quat); debugCard.scale.setScalar(p.scale);
    debugCard.visible = true;
    window.__raw = { pos: p.pos.toArray(), scale: p.scale };
  }

  if (!state.worldTracking) {
    // No world tracking (desktop webcams): follow the image, smoothed.
    if (!anchor.placed) {
      anchor.pos.copy(p.pos); anchor.quat.copy(p.quat); anchor.scale = p.scale;
      anchor.placed = true;
      anchor.group.visible = true;
      setHint(null);
    } else {
      anchor.pos.lerp(p.pos, DESKTOP_ALPHA);
      anchor.quat.slerp(p.quat, DESKTOP_ALPHA);
      anchor.scale += (p.scale - anchor.scale) * DESKTOP_ALPHA;
    }
    applyAnchor();
    return;
  }

  if (!anchor.placed) {
    if (!floor.ready) {
      setHint('Image seen. Now point at the floor for a moment so the height can be measured');
      return;
    }
    anchor.samples.push(p);
    if (anchor.samples.length >= PLACE_SAMPLES) placeFromSamples();
    return;
  }

  // Placed: correct sideways position and turn only, weighted by how
  // head-on the image is seen. Height and tilt never change.
  camera.getWorldDirection(_fwd);
  _normal.set(0, 0, 1).applyQuaternion(p.quat);
  const facing = Math.abs(_fwd.dot(_normal));
  const weight = THREE.MathUtils.clamp((facing - 0.25) / 0.5, 0, 1);
  if (weight === 0) return;
  const q = uprightQuat(p.quat, state.mode);
  const dist = Math.hypot(p.pos.x - anchor.pos.x, p.pos.z - anchor.pos.z) / Math.max(anchor.scale, 1e-6);
  const ang = anchor.quat.angleTo(q);
  if (dist < DEADBAND_DIST && ang < DEADBAND_ANGLE) return;
  const alpha = weight * THREE.MathUtils.clamp(FOLLOW_ALPHA + dist * 1.2 + ang * 0.8, FOLLOW_ALPHA, 0.35);
  anchor.pos.x += (p.pos.x - anchor.pos.x) * alpha;
  anchor.pos.z += (p.pos.z - anchor.pos.z) * alpha;
  anchor.pos.y = floor.altitude;
  anchor.quat.slerp(q, alpha);
  applyAnchor();
}

// Floor finding: show a ring where the screen centre meets the floor, and call
// the floor found once world tracking has been NORMAL for a moment.
function updateFloor(camera) {
  if (!state.worldTracking) return;
  const now = performance.now();
  if (!floor.ready) {
    const hits = XR8.XrController.hitTest(0.5, 0.6, ['ESTIMATED_SURFACE', 'DETECTED_SURFACE']) || [];
    const hit = hits[0];
    if (hit && floor.ring) {
      floor.ring.position.set(hit.position.x, hit.position.y + 0.002, hit.position.z);
      floor.ring.visible = true;
    }
    const steady = floor.normalSince && now - floor.normalSince > 700;
    const cameraHeightOk = camera.position.y > 0.15;           // camera is really above a floor
    const timedOut = now - floor.startedAt > 15000;             // don't wait forever
    if ((steady && cameraHeightOk && hit) || timedOut) {
      floor.ready = true;
      window.__floor = { at: now - floor.startedAt, cameraHeight: camera.position.y, timedOut };
      if (floor.ring) floor.ring.material.color.set(0x7fe0a0);
      setTimeout(() => { if (floor.ring) floor.ring.visible = false; }, 900);
      if (!anchor.placed) setHint('Floor found. Now point your camera at your image');
    }
  }
}

// ---------------------------------------------------------------------------
// 8th Wall session
// ---------------------------------------------------------------------------
let lastFrame = 0;
let debugCard = null;

const arModule = {
  name: 'sculpture',
  onStart: () => {
    const { scene, camera, renderer } = XR8.Threejs.xrScene();
    // Don't change the pixel ratio here: 8th Wall sizes this renderer to match
    // the camera feed, and changing it shifts the 3D layer off the image.
    renderer.toneMapping = THREE.AgXToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Keep the generator alive: 8th Wall restores the last-used GL program between frames.
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;
    arModule.pmrem = pmrem;
    renderer.getContext().useProgram(null);
    renderer.resetState();

    camera.position.set(0, 1.6, 0);
    XR8.XrController.updateCameraProjectionMatrix({ origin: camera.position, facing: camera.quaternion });

    floor.ready = !state.worldTracking;
    floor.normalSince = 0;
    floor.startedAt = performance.now();
    floor.altitude = null;
    if (!floor.ring) {
      floor.ring = new THREE.Mesh(
        new THREE.RingGeometry(0.09, 0.11, 48).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false, toneMapped: false })
      );
    }
    floor.ring.material.color.set(0xffffff);
    floor.ring.visible = false;
    scene.add(floor.ring);

    resetPlacement();
    anchor.group.add(state.rig.root);
    scene.add(anchor.group);
    if (DEBUG) {
      // Magenta card at the raw image pose, to check the 3D layer lines up with the camera feed.
      debugCard = new THREE.Mesh(
        new THREE.PlaneGeometry(1, state.aspect),
        new THREE.MeshBasicMaterial({ color: 0xff00ff, toneMapped: false, side: THREE.DoubleSide })
      );
      debugCard.visible = false;
      scene.add(debugCard);
    }
    lastFrame = performance.now();
    window.__xr = { scene, camera, renderer, anchor };
  },
  onUpdate: () => {
    const now = performance.now();
    const dt = Math.min((now - lastFrame) / 1000, 0.1);
    lastFrame = now;
    if (state.rig) state.rig.update(dt);
    updateFloor(XR8.Threejs.xrScene().camera);
  },
  onCameraStatusChange: ({ status }) => {
    if (DEBUG) (window.__ev ||= []).push(['camera', status]);
    if (status === 'failed' || status === 'denied') {
      stopAR();
      showError(inFrame
        ? `The camera is blocked inside this frame. ${openInTabLink}, then allow the camera.`
        : 'Camera access is off. Allow the camera for this site in your browser settings, then try again.');
    }
  },
  onException: (err) => {
    console.error(err);
    const msg = String((err && err.message) || err || '');
    stopAR();
    showError((inFrame ? `${openInTabLink}. ` : '') + 'The camera view stopped: ' + msg.replace(/[<>]/g, ''));
  },
  listeners: [
    { event: 'reality.imageloading', process: ({ detail }) => { if (DEBUG) (window.__ev ||= []).push(['loading', JSON.stringify(detail).slice(0, 300)]); } },
    { event: 'reality.imagescanning', process: ({ detail }) => { if (DEBUG) (window.__ev ||= []).push(['scanning', JSON.stringify(detail).slice(0, 300)]); } },
    {
      event: 'reality.imagefound',
      process: ({ detail }) => onImagePose(detail, XR8.Threejs.xrScene().camera),
    },
    {
      event: 'reality.imageupdated',
      process: ({ detail }) => onImagePose(detail, XR8.Threejs.xrScene().camera),
    },
    {
      event: 'reality.imagelost',
      process: () => {
        if (!anchor.placed) { anchor.samples = []; return; }
        if (!state.worldTracking) anchor.group.visible = true; // keep last pose
      },
    },
    {
      event: 'reality.trackingstatus',
      process: ({ detail }) => {
        if (DEBUG) (window.__ev ||= []).push(['tracking', detail.status + '/' + detail.reason]);
        if (!state.worldTracking) return;
        if (detail.status === 'NORMAL') { if (!floor.normalSince) floor.normalSince = performance.now(); }
        else floor.normalSince = 0;
        if (anchor.placed || floor.ready) return;
        if (detail.status === 'LIMITED') setHint('Point at the floor and move your phone slowly from side to side');
      },
    },
  ],
};

function startAR() {
  if (!state.target || !state.rig || !state.xrReady || state.running) return;
  showError('');

  const device = XR8.XrConfig.device();
  const mobileOk = XR8.XrDevice.isDeviceBrowserCompatible({ allowedDevices: device.MOBILE_AND_HEADSETS });
  state.worldTracking = mobileOk;
  if (!mobileOk) {
    const reasons = XR8.XrDevice.incompatibleReasons({ allowedDevices: device.MOBILE_AND_HEADSETS }) || [];
    const isMobileUA = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (isMobileUA) {
      showError('This browser can\'t run the camera view. Open the page in Safari (iPhone) or Chrome (Android).'
        + (reasons.length ? ` (${reasons.join(', ')})` : ''));
      return;
    }
  }

  // Everything below runs inside the tap, so iOS can show its camera and motion prompts.
  preview.stop();
  ui.setup.hidden = true;
  ui.ar.hidden = false;
  ui.arUi.hidden = false;
  document.body.dataset.state = 'ar';
  setHint('Starting camera…');
  ui.xrCanvas.style.display = 'block';

  XR8.XrController.configure({
    imageTargetData: [state.target],
    disableWorldTracking: !state.worldTracking,
    scale: state.worldTracking ? 'absolute' : 'responsive',   // absolute: metres, floor at y = 0
  });
  XR8.clearCameraPipelineModules();
  XR8.addCameraPipelineModules([
    window.XRExtras.FullWindowCanvas.pipelineModule(),   // sizes the canvas to the screen
    XR8.GlTextureRenderer.pipelineModule(),
    XR8.Threejs.pipelineModule(),
    XR8.XrController.pipelineModule(),
    arModule,
  ]);
  state.running = true;
  XR8.run({
    canvas: ui.xrCanvas,
    allowedDevices: state.worldTracking ? device.MOBILE_AND_HEADSETS : device.ANY,
  });
}

function stopAR() {
  if (state.running) {
    state.running = false;
    try { XR8.stop(); } catch { /* already stopped */ }
    try { XR8.clearCameraPipelineModules(); } catch { /* ignore */ }
  }
  floor.altitude = null;
  resetPlacement();
  if (state.rig) anchor.group.remove(state.rig.root);
  if (debugCard) { debugCard.removeFromParent(); debugCard = null; }
  ui.ar.hidden = true;
  ui.arUi.hidden = true;
  ui.xrCanvas.style.display = 'none';
  ui.setup.hidden = false;
  document.body.dataset.state = 'setup';
  if (state.rig) preview.attach(state.rig.root);
  preview.start();
  refreshStart();
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
function setSize(value) {
  state.size = Number(value);
  ui.size.value = value;
  ui.sizeAr.value = value;
  ui.sizeOut.textContent = `${state.size.toFixed(state.size < 1 ? 2 : 1).replace(/\.?0+$/, '')}×`;
  if (state.rig) state.rig.layout();
  preview.frame();
}

ui.size.addEventListener('input', (e) => setSize(e.target.value));
ui.sizeAr.addEventListener('input', (e) => setSize(e.target.value));
document.querySelectorAll('input[name="mode"]').forEach((el) => {
  el.addEventListener('change', (e) => {
    state.mode = e.target.value;
    if (state.rig) state.rig.layout();
    preview.frame();
  });
});
ui.file.addEventListener('change', () => {
  const file = ui.file.files && ui.file.files[0];
  if (file) prepareTarget(file);
  ui.file.value = '';
});
ui.start.addEventListener('click', startAR);
ui.back.addEventListener('click', stopAR);
ui.replace.addEventListener('click', resetPlacement);

// ---------------------------------------------------------------------------
// Sculpture library
// ---------------------------------------------------------------------------
const loader = new GLTFLoader();
loader.setDRACOLoader(new DRACOLoader().setDecoderPath('./vendor/draco/'));
loader.setMeshoptDecoder(MeshoptDecoder);

async function loadCatalog() {
  const params = new URLSearchParams(location.search);
  let catalogUrl = params.get('catalog') || '';
  if (!catalogUrl) {
    try {
      const cfg = await (await fetch('config.json', { cache: 'no-store' })).json();
      catalogUrl = (cfg.catalogUrl || '').trim();
    } catch { /* no config: built-in list */ }
  }
  if (catalogUrl) {
    try {
      const abs = new URL(catalogUrl, location.href);
      const bust = new URL(abs); bust.searchParams.set('t', Date.now());
      const res = await fetch(bust, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const cat = await res.json();
      const models = (cat.models || []).filter((m) => m && m.id && m.file).map((m) => ({
        ...m,
        title: m.title || m.id,
        file: new URL(m.file, abs).href,
        thumbnail: m.thumbnail ? new URL(m.thumbnail, abs).href : '',
        size: Number(m.size) > 0 ? Number(m.size) : 1,
      }));
      if (models.length) return { models, source: 'library' };
      console.warn('Model library is empty; using the built-in sculpture.');
    } catch (err) {
      console.warn('Model library unreachable; using the built-in sculpture.', err);
    }
  }
  return {
    models: BUILT_IN_CATALOG.models.map((m) => ({ ...m, file: new URL(m.file, location.href).href, thumbnail: new URL(m.thumbnail, location.href).href })),
    source: 'built-in',
  };
}

function pickerItem(m, compact) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'pick' + (compact ? ' compact' : '');
  b.dataset.id = m.id;
  b.setAttribute('role', 'option');
  b.title = m.description ? `${m.title}: ${m.description}` : m.title;
  const fig = document.createElement('span');
  fig.className = 'pick-thumb';
  if (m.thumbnail) {
    const img = document.createElement('img');
    img.src = m.thumbnail; img.alt = ''; img.loading = 'lazy'; img.decoding = 'async';
    img.onerror = () => { img.remove(); fig.textContent = m.title.slice(0, 1).toUpperCase(); };
    fig.append(img);
  } else {
    fig.textContent = m.title.slice(0, 1).toUpperCase();
  }
  b.append(fig);
  if (!compact) {
    const t = document.createElement('span');
    t.className = 'pick-title';
    t.textContent = m.title;
    b.append(t);
  } else {
    b.setAttribute('aria-label', m.title);
  }
  b.addEventListener('click', () => selectModel(m.id));
  return b;
}

function renderPickers() {
  ui.pickerRow.replaceChildren(...state.models.map((m) => pickerItem(m, false)));
  ui.pickerAr.replaceChildren(...state.models.map((m) => pickerItem(m, true)));
  const many = state.models.length > 1;
  ui.picker.hidden = !many;
  ui.pickerAr.hidden = !many;
}

function markSelected(id, loading) {
  for (const el of document.querySelectorAll('.pick')) {
    const on = el.dataset.id === id;
    el.setAttribute('aria-selected', on ? 'true' : 'false');
    el.classList.toggle('loading', on && loading);
  }
}

async function selectModel(id) {
  const entry = state.models.find((m) => m.id === id) || state.models[0];
  if (!entry) return;
  if (state.modelId === entry.id && state.rig) return;
  const token = ++state.loadToken;
  state.modelId = entry.id;
  markSelected(entry.id, true);
  const params = new URLSearchParams(location.search);
  params.set('model', entry.id);
  history.replaceState(null, '', `${location.pathname}?${params}${location.hash}`);

  let rig = state.rigs.get(entry.id);
  if (!rig) {
    if (!state.target) setStatus(`Loading ${entry.title}…`);
    if (state.running) setHint(`Loading ${entry.title}…`);
    try {
      const gltf = await loader.loadAsync(entry.file);
      rig = createRig(gltf);
      state.rigs.set(entry.id, rig);
    } catch (err) {
      console.error(err);
      if (token !== state.loadToken) return;
      markSelected(entry.id, false);
      setStatus(`${entry.title} failed to load. Choose another sculpture or reload the page.`, 'warn');
      return;
    }
  }
  if (token !== state.loadToken) return;

  // Swap it in wherever the current sculpture is (preview or camera view).
  const parent = state.rig ? state.rig.root.parent : null;
  if (state.rig) state.rig.root.removeFromParent();
  state.rig = rig;
  window.__rig = rig;
  setSize(entry.size);
  if (parent) parent.add(rig.root);
  else if (!state.running) preview.attach(rig.root);
  else anchor.group.add(rig.root);
  rig.layout();
  preview.frame();
  markSelected(entry.id, false);
  if (state.running && anchor.placed) { setHint(entry.title); clearTimeout(selectModel.t); selectModel.t = setTimeout(() => setHint(null), 1500); }
  else if (state.running) resetPlacement();
  if (!state.target && !state.running) setStatus('Choose an image to begin');
  refreshStart();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
preview.start();
setStatus('Loading the sculptures…');
loadCatalog().then(({ models, source }) => {
  state.models = models;
  window.__catalog = { source, count: models.length };
  renderPickers();
  const wanted = new URLSearchParams(location.search).get('model');
  selectModel(models.some((m) => m.id === wanted) ? wanted : models[0].id);
});

function onXrLoaded() {
  state.xrReady = true;
  window.__xrReady = true;
  refreshStart();
}
if (window.XR8) onXrLoaded();
else window.addEventListener('xrloaded', onXrLoaded, { once: true });

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const params = new URLSearchParams(location.search);
if (params.has('overlay')) document.body.classList.add('overlay');

const stage = document.querySelector('#stage');
const caption = document.querySelector('#caption');
const errorBox = document.querySelector('#error');
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(32, innerWidth / innerHeight, 0.1, 100);
camera.position.set(0, 1.2, 5.5);

const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.25;
stage.appendChild(renderer.domElement);

scene.add(new THREE.HemisphereLight(0xffffff, 0x4b356c, 2.1));
const key = new THREE.DirectionalLight(0xffe7d6, 3.2);
key.position.set(-3, 5, 5);
scene.add(key);
const rim = new THREE.DirectionalLight(0x9d77ff, 2.4);
rim.position.set(3, 2, -3);
scene.add(rim);

const clock = new THREE.Clock();
let mixer;
let avatarAnchor;
let avatarModel;
let actions = {};
let activeAction;
let modelReady = false;
let pendingState = null;
let captionTimer;
let lastEventId = 0;
let eventStreamReady = false;
let voiceEnabled = true;
let currentAudio;
let audioRun = 0;
let speechActive = false;
let activeState = 'idle';
let waveStartedAt = null;
let waveTeleported = false;
let idleDecisionIn = 7 + Math.random() * 12;
let glideMotion = null;
let ambientGlitchIn = 35 + Math.random() * 35;
let glitchBurst = 0;
let glitchBurstStrength = 0;
let glitchTarget;
let manualGlitchRemaining = 0;
let manualGlitchStrength = 0;
let modelHeight = 0;
let modelWidth = 0;
let modelBaseY = 0;
let modelBaseX = 0;
let modelBaseRotationZ = 0;
let cameraHalfHeight = 0;
let cameraHalfWidth = 0;
const AVATAR_POSITION_KEY = 'capriAvatarPosition';
let avatarPosition = { x: 0.68, y: -0.6 };
try {
  const savedPosition = JSON.parse(localStorage.getItem(AVATAR_POSITION_KEY) || 'null');
  if (Number.isFinite(savedPosition?.x) && Number.isFinite(savedPosition?.y)) {
    avatarPosition = { x: THREE.MathUtils.clamp(savedPosition.x, -1, 1), y: THREE.MathUtils.clamp(savedPosition.y, -1, 1) };
  }
} catch { /* Ignore an unavailable or invalid saved position. */ }
const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();
const dragPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const pointerWorld = new THREE.Vector3();
const dragOffset = new THREE.Vector3();
let draggingAvatar = false;
let demoRun = 0;
let demoActive = false;
let demoTimer;
const actionFor = { idle: 'Flotar_en_reposo', talk: 'Hablar', laugh: 'Reir', wave: 'Saludar_y_teletransportarse', think: 'Pensar', sleep: 'Dormir', surprise: 'Surpresa', bored: 'Aburrida', walk: 'Caminar' };
const oneShotStates = new Set(['laugh', 'wave', 'surprise', 'bored']);
const glitchScene = new THREE.Scene();
const glitchCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const glitchMaterial = new THREE.ShaderMaterial({
  uniforms: { tex: { value: null }, intensity: { value: 0 }, time: { value: 0 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: `
    uniform sampler2D tex;
    uniform float intensity;
    uniform float time;
    varying vec2 vUv;
    float hash(float n) { return fract(sin(n) * 43758.5453); }
    void main() {
      vec2 uv = vUv;
      float stepTime = floor(time * 18.0);
      uv.x += (hash(stepTime * 1.7) - 0.5) * 0.03 * intensity;
      float bands = mix(7.0, 36.0, hash(stepTime + 3.0));
      float band = floor(uv.y * bands);
      float randomBand = hash(band * 1.31 + stepTime * 7.1);
      if (randomBand > 0.55) uv.x += (hash(band * 3.7 + stepTime) - 0.5) * 0.32 * intensity * (randomBand - 0.55) * 2.2;
      uv = clamp(uv, 0.0, 1.0);
      float offset = (0.008 + 0.018 * hash(stepTime * 2.3)) * intensity;
      vec4 center = texture2D(tex, uv);
      vec4 left = texture2D(tex, clamp(uv + vec2(offset, 0.0), 0.0, 1.0));
      vec4 right = texture2D(tex, clamp(uv - vec2(offset, 0.0), 0.0, 1.0));
      vec3 ghosts = left.a * vec3(0.0, 0.9, 1.0) + right.a * vec3(1.0, 0.1, 0.65);
      vec3 color = center.rgb * center.a + (1.0 - center.a) * ghosts * 0.85;
      color += center.a * (left.a - right.a) * vec3(-0.1, 0.25, 0.3) * intensity;
      float alpha = max(center.a, max(left.a, right.a) * 0.8 * min(1.0, intensity * 1.5));
      vec2 block = floor(gl_FragCoord.xy / vec2(18.0, 6.0));
      float noise = hash(block.x * 13.1 + block.y * 71.7 + stepTime * 1.9);
      if (noise > 1.0 - 0.07 * intensity && alpha > 0.1) color = mix(vec3(0.02, 0.88, 0.26), vec3(1.0), step(0.5, hash(noise * 9.0)));
      if (hash(stepTime * 5.3) < 0.15 * intensity) alpha *= 0.35;
      gl_FragColor = vec4(color, alpha);
      #include <colorspace_fragment>
    }`,
  depthTest: false,
  depthWrite: false,
  blending: THREE.NoBlending,
});
glitchScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), glitchMaterial));

function play(name, once = false) {
  const clipName = actionFor[name] || name;
  const next = actions[clipName];
  if (!next) return;
  const previousState = activeState;
  activeState = name;
  waveStartedAt = name === 'wave' ? clock.elapsedTime : null;
  if (name === 'wave') waveTeleported = false;
  if (name === 'idle' && previousState !== 'idle') idleDecisionIn = 7 + Math.random() * 12;
  if (name !== 'idle' && name !== 'walk') glideMotion = null;
  next.reset();
  next.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, once ? 1 : Infinity);
  next.clampWhenFinished = once;
  next.fadeIn(0.2).play();
  if (activeAction && activeAction !== next) activeAction.fadeOut(0.2);
  activeAction = next;
  document.querySelectorAll('[data-action]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.action === name));
  });
}

function cancelDemo() {
  demoRun++;
  demoActive = false;
  clearTimeout(demoTimer);
}

function triggerGlitch(duration = 1150, strength = 0.9) {
  manualGlitchRemaining = Math.max(manualGlitchRemaining, duration / 1000);
  manualGlitchStrength = Math.max(manualGlitchStrength, strength);
}

function haltSpeech() {
  audioRun++;
  currentAudio?.pause();
  currentAudio = undefined;
  speechActive = false;
  window.speechSynthesis?.cancel();
}

function runDemo() {
  cancelDemo();
  const run = demoRun;
  demoActive = true;
  const sequence = ['idle', 'talk', 'laugh', 'think', 'surprise', 'bored', 'wave', 'sleep', 'walk', 'glitch'];
  let index = 0;
  const advance = () => {
    if (run !== demoRun) return;
    if (index >= sequence.length) {
      demoActive = false;
      play('idle');
      caption.classList.remove('visible');
      return;
    }
    const state = sequence[index++];
    if (state === 'glitch') {
      triggerGlitch(1500, 1);
      play('idle');
      demoTimer = setTimeout(advance, 1700);
      return;
    }
    if (state === 'sleep') {
      play('sleep');
      say('Zzz…', 2400);
      demoTimer = setTimeout(advance, 2500);
      return;
    }
    if (state === 'walk') {
      startGlide(3.8);
      say('Vou dar uma volta.', 2500);
      demoTimer = setTimeout(advance, 4100);
      return;
    }
    play(state, oneShotStates.has(state));
    if (state === 'idle') say('Repousando…', 1300);
    const action = actions[actionFor[state]];
    const clipSeconds = action?.getClip().duration || 2;
    const duration = state === 'idle' ? 1500 : Math.min(4800, Math.max(1800, clipSeconds * 1000));
    demoTimer = setTimeout(advance, duration);
  };
  advance();
}

function say(message, duration = 4000) {
  caption.textContent = message;
  caption.classList.add('visible');
  clearTimeout(captionTimer);
  captionTimer = setTimeout(() => caption.classList.remove('visible'), duration);
}

function registerProceduralActions(model) {
  const rad = value => THREE.MathUtils.degToRad(value);
  const add = (name, duration, frames) => {
    const times = frames.map(frame => frame.t);
    const bones = new Set(frames.flatMap(frame => Object.keys(frame.pose)));
    const tracks = [];
    for (const boneName of bones) {
      const bone = model.getObjectByName(boneName);
      if (!bone) continue;
      const hasRotation = frames.some(frame => frame.pose[boneName]?.rotation);
      const hasPosition = frames.some(frame => frame.pose[boneName]?.position);
      if (hasRotation) {
        const base = bone.quaternion.clone();
        const values = [];
        for (const frame of frames) {
          const [x = 0, y = 0, z = 0] = frame.pose[boneName]?.rotation || [];
          const q = base.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(rad(x), rad(y), rad(z), 'XYZ')));
          values.push(q.x, q.y, q.z, q.w);
        }
        tracks.push(new THREE.QuaternionKeyframeTrack(`${boneName}.quaternion`, times, values));
      }
      if (hasPosition) {
        const base = bone.position.clone();
        const values = [];
        for (const frame of frames) {
          const [x = 0, y = 0, z = 0] = frame.pose[boneName]?.position || [];
          values.push(base.x + x, base.y + y, base.z + z);
        }
        tracks.push(new THREE.VectorKeyframeTrack(`${boneName}.position`, times, values));
      }
    }
    const clip = new THREE.AnimationClip(`Capri_${name}`, duration, tracks);
    actions[actionFor[name]] = mixer.clipAction(clip);
  };

  add('sleep', 4, [
    { t: 0, pose: { Raiz: { rotation: [8, 0, 5], position: [0, -0.22, 0] }, Brazo_izquierdo: { rotation: [0, 0, 22] }, Brazo_derecho: { rotation: [0, 0, -26] }, Antebrazo_izquierdo: { rotation: [10, 0, 0] }, Antebrazo_derecho: { rotation: [-10, 0, 0] }, Mano_izquierda: { rotation: [0, 0, 8] }, Mano_derecha: { rotation: [0, 0, -8] }, Cabeza: { rotation: [16, 0, -14] } } },
    { t: 1, pose: { Raiz: { rotation: [8, 0, 5], position: [0, -0.19, 0] }, Brazo_izquierdo: { rotation: [0, 0, 22] }, Brazo_derecho: { rotation: [0, 0, -26] }, Antebrazo_izquierdo: { rotation: [10, 0, 0] }, Antebrazo_derecho: { rotation: [-10, 0, 0] }, Mano_izquierda: { rotation: [0, 0, 8] }, Mano_derecha: { rotation: [0, 0, -8] }, Cabeza: { rotation: [19, 0, -14] } } },
    { t: 2, pose: { Raiz: { rotation: [8, 0, 5], position: [0, -0.22, 0] }, Brazo_izquierdo: { rotation: [0, 0, 22] }, Brazo_derecho: { rotation: [0, 0, -26] }, Antebrazo_izquierdo: { rotation: [10, 0, 0] }, Antebrazo_derecho: { rotation: [-10, 0, 0] }, Mano_izquierda: { rotation: [0, 0, 8] }, Mano_derecha: { rotation: [0, 0, -8] }, Cabeza: { rotation: [16, 0, -14] } } },
    { t: 3, pose: { Raiz: { rotation: [8, 0, 5], position: [0, -0.25, 0] }, Brazo_izquierdo: { rotation: [0, 0, 22] }, Brazo_derecho: { rotation: [0, 0, -26] }, Antebrazo_izquierdo: { rotation: [10, 0, 0] }, Antebrazo_derecho: { rotation: [-10, 0, 0] }, Mano_izquierda: { rotation: [0, 0, 8] }, Mano_derecha: { rotation: [0, 0, -8] }, Cabeza: { rotation: [13, 0, -14] } } },
    { t: 4, pose: { Raiz: { rotation: [8, 0, 5], position: [0, -0.22, 0] }, Brazo_izquierdo: { rotation: [0, 0, 22] }, Brazo_derecho: { rotation: [0, 0, -26] }, Antebrazo_izquierdo: { rotation: [10, 0, 0] }, Antebrazo_derecho: { rotation: [-10, 0, 0] }, Mano_izquierda: { rotation: [0, 0, 8] }, Mano_derecha: { rotation: [0, 0, -8] }, Cabeza: { rotation: [16, 0, -14] } } },
  ]);
  add('surprise', 1.3, [
    { t: 0, pose: {} },
    { t: 0.18, pose: { Raiz: { rotation: [-2, 0, 0], position: [0, 0.15, 0] }, Brazo_izquierdo: { rotation: [0, 0, -30] }, Brazo_derecho: { rotation: [0, 0, 35] }, Antebrazo_izquierdo: { rotation: [0, 0, -12] }, Antebrazo_derecho: { rotation: [0, 0, 12] }, Cabeza: { rotation: [-5, 0, 2] } } },
    { t: 0.55, pose: { Raiz: { rotation: [-6, 0, 0], position: [0, 0.28, 0] }, Brazo_izquierdo: { rotation: [0, 0, -80] }, Brazo_derecho: { rotation: [0, 0, 90] }, Antebrazo_izquierdo: { rotation: [0, 0, -30] }, Antebrazo_derecho: { rotation: [0, 0, 30] }, Cabeza: { rotation: [-12, 0, 4] } } },
    { t: 1.3, pose: { Raiz: { rotation: [0, 0, 0], position: [0, 0, 0] }, Brazo_izquierdo: { rotation: [0, 0, 0] }, Brazo_derecho: { rotation: [0, 0, 0] }, Antebrazo_izquierdo: { rotation: [0, 0, 0] }, Antebrazo_derecho: { rotation: [0, 0, 0] }, Cabeza: { rotation: [0, 0, 0] } } },
  ]);
  add('bored', 4.6, [
    { t: 0, pose: {} },
    { t: 0.6, pose: { Cabeza: { rotation: [0, 0, 14] } } },
    { t: 1.2, pose: { Cabeza: { rotation: [0, 0, 0] } } },
    { t: 2.1, pose: { Cabeza: { rotation: [0, 0, 0] } } },
    { t: 2.7, pose: { Raiz: { position: [0, 0.05, 0] }, Brazo_izquierdo: { rotation: [0, 0, -45] }, Brazo_derecho: { rotation: [0, 0, 48] }, Antebrazo_izquierdo: { rotation: [0, 0, -16] }, Antebrazo_derecho: { rotation: [0, 0, 16] }, Cabeza: { rotation: [-10, 0, 0] } } },
    { t: 3.4, pose: { Raiz: { rotation: [6, 0, 0], position: [0, 0.05, 0] }, Brazo_izquierdo: { rotation: [0, 0, -70] }, Brazo_derecho: { rotation: [0, 0, 75] }, Antebrazo_izquierdo: { rotation: [0, 0, -25] }, Antebrazo_derecho: { rotation: [0, 0, 25] }, Cabeza: { rotation: [-16, 0, 0] } } },
    { t: 4.6, pose: { Raiz: { rotation: [6, 0, 0], position: [0, -0.1, 0] }, Brazo_izquierdo: { rotation: [0, 0, 14] }, Brazo_derecho: { rotation: [0, 0, -14] }, Antebrazo_izquierdo: { rotation: [0, 0, 0] }, Antebrazo_derecho: { rotation: [0, 0, 0] }, Cabeza: { rotation: [10, 0, 0] } } },
  ]);
  add('walk', 1.6, [
    { t: 0, pose: { Raiz: { rotation: [9, 0, 0], position: [0, 0.05, 0] }, Brazo_izquierdo: { rotation: [0, 0, 18] }, Brazo_derecho: { rotation: [0, 0, -22] }, Cabeza: { rotation: [-4, 0, 0] } } },
    { t: 0.4, pose: { Raiz: { rotation: [9, 0, 2], position: [0, 0.1, 0] }, Brazo_izquierdo: { rotation: [0, 0, 24] }, Brazo_derecho: { rotation: [0, 0, -28] }, Cabeza: { rotation: [-4, 0, 3] } } },
    { t: 0.8, pose: { Raiz: { rotation: [9, 0, 0], position: [0, 0.05, 0] }, Brazo_izquierdo: { rotation: [0, 0, 18] }, Brazo_derecho: { rotation: [0, 0, -22] }, Cabeza: { rotation: [-4, 0, 0] } } },
    { t: 1.2, pose: { Raiz: { rotation: [9, 0, -2], position: [0, 0] }, Brazo_izquierdo: { rotation: [0, 0, 12] }, Brazo_derecho: { rotation: [0, 0, -16] }, Cabeza: { rotation: [-4, 0, -3] } } },
    { t: 1.6, pose: { Raiz: { rotation: [9, 0, 0], position: [0, 0.05, 0] }, Brazo_izquierdo: { rotation: [0, 0, 18] }, Brazo_derecho: { rotation: [0, 0, -22] }, Cabeza: { rotation: [-4, 0, 0] } } },
  ]);
}

window.capriAvatar = {
  setState(state) {
    if (!modelReady) { pendingState = state; return; }
    if (state === 'demo') { haltSpeech(); runDemo(); return; }
    cancelDemo();
    if (state === 'glitch') { triggerGlitch(1500, 1); return; }
    if (!actionFor[state]) state = 'idle';
    if (state === 'walk') { haltSpeech(); caption.classList.remove('visible'); startGlide(); return; }
    haltSpeech();
    if (state === 'sleep') say('Zzz…', 5000);
    else caption.classList.remove('visible');
    play(state, oneShotStates.has(state));
  },
  speak(message, duration) { speakCapri(message, duration); },
  stopSpeaking() {
    audioRun++;
    currentAudio?.pause();
    currentAudio = undefined;
    speechActive = false;
    window.speechSynthesis?.cancel();
    caption.classList.remove('visible');
    play('idle');
  },
  say
};

async function speakCapri(message, duration = 7000) {
  cancelDemo();
  const text = String(message);
  const run = ++audioRun;
  speechActive = true;
  const normalized = text.toLocaleLowerCase('pt-BR');
  const gesture = /(?:\bkkk+|\bhaha+|\brsrs+|😂|🤣|😆|que engraçado|morri de rir)/u.test(normalized)
    ? 'laugh'
    : /^(?:oi\b|olá\b|ola\b|bom dia\b|boa tarde\b|boa noite\b|e aí\b|eai\b|bem-vind|valeu\b|obrigad)/u.test(normalized)
      ? 'wave'
      : 'talk';
  play(gesture, gesture !== 'talk');
  say(text, duration);
  if (currentAudio) { currentAudio.pause(); currentAudio = undefined; }
  window.speechSynthesis?.cancel();
  if (!voiceEnabled) return;
  try {
    const response = await fetch('/api/voice', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text })
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Falha na voz neural.');
    const audioUrl = URL.createObjectURL(await response.blob());
    const audio = new Audio(audioUrl);
    currentAudio = audio;
    audio.onended = audio.onerror = () => {
      URL.revokeObjectURL(audioUrl);
      if (run === audioRun) { currentAudio = undefined; speechActive = false; play('idle'); }
    };
    await audio.play();
  } catch (error) {
    console.error('Voz neural da Capri:', error);
    if ('speechSynthesis' in window) {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'pt-BR';
      utterance.onend = utterance.onerror = () => { if (run === audioRun) { speechActive = false; play('idle'); } };
      window.speechSynthesis.speak(utterance);
    } else if (run === audioRun) { speechActive = false; play('idle'); }
  }
}

document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => {
  if (button.dataset.action === 'walk') { startGlide(); return; }
  play(button.dataset.action, oneShotStates.has(button.dataset.action));
  if (button.dataset.action === 'talk') speakCapri('Oi, chat! Estou aqui com vocês.');
  else if (button.dataset.action === 'laugh') say('Essa foi boa!');
  else if (button.dataset.action === 'wave') say('Oi!');
  else caption.classList.remove('visible');
}));

new GLTFLoader().load('./assets/capri-character.glb', ({ scene: model, animations }) => {
  model.rotation.y = -0.12;
  model.traverse(object => {
    if (object.isMesh) {
      object.castShadow = true;
      object.frustumCulled = false;
      if (object.material) object.material.needsUpdate = true;
    }
  });
  const bounds = new THREE.Box3().setFromObject(model);
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  avatarAnchor = new THREE.Group();
  avatarAnchor.position.sub(center);
  avatarAnchor.add(model);
  modelHeight = Math.max(size.y, 0.1);
  modelWidth = Math.max(size.x, 0.1);
  modelBaseY = avatarAnchor.position.y;
  modelBaseX = avatarAnchor.position.x;
  modelBaseRotationZ = avatarAnchor.rotation.z;
  avatarModel = model;
  scene.add(avatarAnchor);
  mixer = new THREE.AnimationMixer(model);
  mixer.addEventListener('finished', event => {
    if (event.action === actions[actionFor.wave] && activeState === 'wave' && !waveTeleported) teleportAvatar();
    if (event.action === activeAction && demoActive) return;
    if (event.action === activeAction) play(speechActive ? 'talk' : 'idle');
  });
  for (const clip of animations) actions[clip.name] = mixer.clipAction(clip);
  registerProceduralActions(model);
  modelReady = true;
  fitCameraToModel();
  play('idle');
  if (pendingState) {
    const state = pendingState;
    pendingState = null;
    window.capriAvatar.setState(state);
  }
}, undefined, error => {
  console.error(error);
  errorBox.textContent = 'Não consegui carregar o modelo. Abra esta página por um servidor local e confira se o arquivo assets/capri-character.glb está junto dela.';
});

function resize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  fitCameraToModel();
}

function fitCameraToModel() {
  if (!modelHeight) return;
  const halfFov = THREE.MathUtils.degToRad(camera.fov / 2);
  const fit = 0.34;
  const verticalDistance = modelHeight / (2 * Math.tan(halfFov) * fit);
  const horizontalDistance = modelWidth / (2 * Math.tan(halfFov) * Math.max(camera.aspect, 0.1) * fit);
  const distance = Math.max(verticalDistance, horizontalDistance, 2.5);
  camera.position.set(0, 0, distance);
  camera.lookAt(0, 0, 0);
  cameraHalfHeight = distance * Math.tan(halfFov);
  cameraHalfWidth = cameraHalfHeight * Math.max(camera.aspect, 0.1);
  const marginX = Math.min(modelWidth / (2 * cameraHalfWidth), 0.95);
  const marginY = Math.min(modelHeight / (2 * cameraHalfHeight), 0.95);
  avatarPosition.x = THREE.MathUtils.clamp(avatarPosition.x, -1 + marginX, 1 - marginX);
  avatarPosition.y = THREE.MathUtils.clamp(avatarPosition.y, -1 + marginY, 1 - marginY);
  modelBaseX = cameraHalfWidth * avatarPosition.x;
  modelBaseY = cameraHalfHeight * avatarPosition.y;
  if (avatarAnchor) avatarAnchor.position.set(modelBaseX, modelBaseY, 0);
}

function pointerRay(event) {
  const bounds = renderer.domElement.getBoundingClientRect();
  pointerNdc.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
  pointerNdc.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
  raycaster.setFromCamera(pointerNdc, camera);
}

function pointerHitsAvatar(event) {
  if (!modelReady || !avatarModel) return false;
  pointerRay(event);
  return raycaster.intersectObject(avatarModel, true).length > 0;
}

function limitAvatarToFrame(position) {
  const halfWidth = Math.min(modelWidth / 2, cameraHalfWidth * 0.95);
  const halfHeight = Math.min(modelHeight / 2, cameraHalfHeight * 0.95);
  position.x = THREE.MathUtils.clamp(position.x, -cameraHalfWidth + halfWidth, cameraHalfWidth - halfWidth);
  position.y = THREE.MathUtils.clamp(position.y, -cameraHalfHeight + halfHeight, cameraHalfHeight - halfHeight);
}

function saveAvatarPosition() {
  avatarPosition = {
    x: cameraHalfWidth ? avatarAnchor.position.x / cameraHalfWidth : avatarPosition.x,
    y: cameraHalfHeight ? (avatarAnchor.position.y - (activeState === 'sleep' ? Math.sin(clock.elapsedTime * 0.75) * 0.04 : 0)) / cameraHalfHeight : avatarPosition.y,
  };
  modelBaseX = avatarAnchor.position.x;
  modelBaseY = avatarAnchor.position.y - (activeState === 'sleep' ? Math.sin(clock.elapsedTime * 0.75) * 0.04 : 0);
  try { localStorage.setItem(AVATAR_POSITION_KEY, JSON.stringify(avatarPosition)); } catch { /* Keep the drag working for this session. */ }
}

function teleportAvatar() {
  if (waveTeleported || !avatarAnchor || !cameraHalfWidth || !cameraHalfHeight) return;
  waveTeleported = true;
  idleDecisionIn = 7 + Math.random() * 12;

  const maxX = Math.max(0, 1 - modelWidth / (2 * cameraHalfWidth));
  const maxY = Math.max(0, 1 - modelHeight / (2 * cameraHalfHeight));
  const spots = [
    { x: -maxX * 0.78, y: maxY * 0.72 },
    { x: maxX * 0.78, y: maxY * 0.72 },
    { x: -maxX * 0.78, y: -maxY * 0.72 },
    { x: maxX * 0.78, y: -maxY * 0.72 },
    { x: 0, y: maxY * 0.78 },
    { x: 0, y: -maxY * 0.78 },
    { x: -maxX * 0.86, y: 0 },
    { x: maxX * 0.86, y: 0 },
  ];
  const current = { x: avatarAnchor.position.x / cameraHalfWidth, y: avatarAnchor.position.y / cameraHalfHeight };
  const destinations = spots.filter(spot => Math.hypot(spot.x - current.x, spot.y - current.y) > 0.48);
  const destination = destinations[Math.floor(Math.random() * destinations.length)] || spots[0];

  const waveElapsed = waveStartedAt === null ? Infinity : clock.elapsedTime - waveStartedAt;
  if (activeState !== 'wave' || waveElapsed < 3.45 || waveElapsed > 4.55) triggerGlitch(950, 0.9);
  avatarAnchor.position.set(destination.x * cameraHalfWidth, destination.y * cameraHalfHeight, 0);
  limitAvatarToFrame(avatarAnchor.position);
  saveAvatarPosition();
}

function startGlide(duration) {
  if (!avatarAnchor || !cameraHalfWidth || !cameraHalfHeight) return;
  const start = { x: avatarAnchor.position.x, y: avatarAnchor.position.y };
  const distance = cameraHalfWidth * (0.35 + Math.random() * 0.35);
  const direction = Math.random() < 0.5 ? -1 : 1;
  const destination = new THREE.Vector3(start.x + direction * distance, start.y + (Math.random() - 0.5) * cameraHalfHeight * 0.28, 0);
  limitAvatarToFrame(destination);
  if (Math.abs(destination.x - start.x) < cameraHalfWidth * 0.2) {
    destination.x = start.x - direction * distance;
    limitAvatarToFrame(destination);
  }
  glideMotion = { start, destination: { x: destination.x, y: destination.y }, elapsed: 0, duration: duration || 3 + Math.random() * 4 };
  play('walk');
}

function resetAvatarPosition() {
  avatarPosition = { x: 0.68, y: -0.6 };
  fitCameraToModel();
  try { localStorage.removeItem(AVATAR_POSITION_KEY); } catch { /* Reset the position for this session. */ }
}

renderer.domElement.style.touchAction = 'none';
renderer.domElement.title = 'Arraste a Capri para movê-la. Dê duplo clique nela para voltar ao canto inferior direito.';
renderer.domElement.addEventListener('pointerdown', event => {
  if (event.button !== 0 || !pointerHitsAvatar(event)) return;
  event.preventDefault();
  glideMotion = null;
  if (activeState === 'walk') play('idle');
  pointerRay(event);
  if (!raycaster.ray.intersectPlane(dragPlane, pointerWorld)) return;
  draggingAvatar = true;
  idleDecisionIn = 7 + Math.random() * 12;
  dragOffset.subVectors(avatarAnchor.position, pointerWorld);
  renderer.domElement.style.cursor = 'grabbing';
  renderer.domElement.setPointerCapture(event.pointerId);
});
renderer.domElement.addEventListener('pointermove', event => {
  if (!draggingAvatar) {
    renderer.domElement.style.cursor = pointerHitsAvatar(event) ? 'grab' : 'default';
    return;
  }
  pointerRay(event);
  if (!raycaster.ray.intersectPlane(dragPlane, pointerWorld)) return;
  avatarAnchor.position.copy(pointerWorld).add(dragOffset);
  limitAvatarToFrame(avatarAnchor.position);
  saveAvatarPosition();
});
const finishAvatarDrag = event => {
  if (!draggingAvatar) return;
  draggingAvatar = false;
  idleDecisionIn = 7 + Math.random() * 12;
  saveAvatarPosition();
  renderer.domElement.style.cursor = 'grab';
  if (renderer.domElement.hasPointerCapture(event.pointerId)) renderer.domElement.releasePointerCapture(event.pointerId);
};
renderer.domElement.addEventListener('pointerup', finishAvatarDrag);
renderer.domElement.addEventListener('pointercancel', finishAvatarDrag);
renderer.domElement.addEventListener('dblclick', event => {
  if (pointerHitsAvatar(event)) resetAvatarPosition();
});
addEventListener('resize', resize);

function animate() {
  requestAnimationFrame(animate);
  const delta = Math.min(clock.getDelta(), 0.05);
  if (mixer) mixer.update(delta);
  renderAvatar(delta);
}
animate();

function renderAvatar(delta) {
  let intensity = 0;
  const canGlide = modelReady && activeState === 'walk' && !speechActive && !draggingAvatar && !!glideMotion;
  const canChooseIdleAction = modelReady && activeState === 'idle' && !speechActive && !demoActive && !draggingAvatar;
  const canRoam = canGlide || canChooseIdleAction;
  if (canRoam && glideMotion) {
    glideMotion.elapsed += delta;
    const progress = Math.min(1, glideMotion.elapsed / glideMotion.duration);
    const eased = progress * progress * (3 - 2 * progress);
    avatarAnchor.position.x = THREE.MathUtils.lerp(glideMotion.start.x, glideMotion.destination.x, eased);
    avatarAnchor.position.y = THREE.MathUtils.lerp(glideMotion.start.y, glideMotion.destination.y, eased);
    glideMotion.lean = Math.sin(progress * Math.PI) * Math.sign(glideMotion.destination.x - glideMotion.start.x) * 0.045;
    if (progress >= 1) {
      glideMotion = null;
      saveAvatarPosition();
      if (activeState === 'walk') play('idle');
    }
  } else if (canRoam && activeState === 'idle' && !glideMotion) {
    idleDecisionIn -= delta;
    if (idleDecisionIn <= 0) {
      idleDecisionIn = 7 + Math.random() * 12;
      const choice = Math.random();
      if (choice >= 0.3 && choice < 0.5) {
        if (Math.random() < 0.35) play('wave', true);
        else startGlide();
      } else if (choice >= 0.5 && choice < 0.65) play('think', true);
      else if (choice < 0.8 && choice >= 0.65) play(Math.random() < 0.5 ? 'laugh' : 'think', true);
    }
  }
  if (avatarAnchor) {
    if (activeState === 'sleep') {
      avatarAnchor.position.x = modelBaseX;
      avatarAnchor.position.y = modelBaseY + Math.sin(clock.elapsedTime * 0.75) * 0.04;
      avatarAnchor.rotation.z = modelBaseRotationZ + Math.sin(clock.elapsedTime * 0.38) * 0.022;
    } else {
      avatarAnchor.rotation.z = modelBaseRotationZ + (glideMotion?.lean || 0);
    }
  }
  if (activeState === 'wave' && waveStartedAt !== null) {
    const elapsed = clock.elapsedTime - waveStartedAt;
    const ramp = (start, end) => Math.max(0, Math.min(1, (elapsed - start) / (end - start)));
    if (elapsed > 2.4 && elapsed < 2.6) intensity = 0.5;
    if (elapsed > 2.85 && elapsed < 3.5) intensity = 0.35 + 0.65 * ramp(2.85, 3.4);
    if (elapsed >= 3.5 && elapsed < 4.5) intensity = 1 - ramp(3.6, 4.5);
    if (elapsed >= 3.5) teleportAvatar();
  }
  ambientGlitchIn -= delta;
  if (ambientGlitchIn <= 0) {
    ambientGlitchIn = 35 + Math.random() * 35;
    glitchBurst = 0.22 + Math.random() * 0.18;
    glitchBurstStrength = 0.35 + Math.random() * 0.18;
  }
  if (glitchBurst > 0) {
    glitchBurst -= delta;
    intensity = Math.max(intensity, glitchBurstStrength);
  }
  if (manualGlitchRemaining > 0) {
    manualGlitchRemaining = Math.max(0, manualGlitchRemaining - delta);
    intensity = Math.max(intensity, manualGlitchStrength);
  } else manualGlitchStrength = 0;
  if (intensity < 0.01) {
    renderer.render(scene, camera);
    return;
  }
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  if (!glitchTarget || glitchTarget.width !== size.x || glitchTarget.height !== size.y) {
    glitchTarget?.dispose();
    glitchTarget = new THREE.WebGLRenderTarget(size.x, size.y, { format: THREE.RGBAFormat, type: THREE.UnsignedByteType });
  }
  renderer.setRenderTarget(glitchTarget);
  renderer.clear();
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  glitchMaterial.uniforms.tex.value = glitchTarget.texture;
  glitchMaterial.uniforms.intensity.value = intensity;
  glitchMaterial.uniforms.time.value = clock.elapsedTime;
  renderer.render(glitchScene, glitchCamera);
}

async function pollReplies() {
  try {
    const response = await fetch(`/api/events?after=${lastEventId}`, { cache: 'no-store' });
    if (response.ok) {
      const data = await response.json();
      const newEvents = data.events || [];
      if (!eventStreamReady) {
        lastEventId = Math.max(lastEventId, ...newEvents.map(event => Number(event.id) || 0));
        eventStreamReady = true;
      } else for (const event of newEvents) {
        lastEventId = Math.max(lastEventId, Number(event.id) || 0);
        if (event.kind === 'animation') window.capriAvatar.setState(event.action);
        else if (event.kind === 'thinking') window.capriAvatar.setState('think');
        else if (event.kind === 'idle') window.capriAvatar.setState('idle');
        else speakCapri(event.answer);
      }
    }
  } catch { /* Server unavailable while the overlay is being opened. */ }
  setTimeout(pollReplies, 700);
}
if (params.has('overlay')) pollReplies();

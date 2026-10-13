// Game settings passed to the WASM core (enemies, game mode) and the graphics quality
// (quality.js). The chosen option index is remembered per browser and rendered as
// segmented radio buttons in every `[data-setting="<name>"]` element.

const STORAGE_PREFIX = '1923.';
/** Receives the graphics setting (-1 auto, else a quality tier), see bindGraphics(). */
let graphicsHook = null;

const SETTINGS = {
  // Multiplies wave size and shortens the gap between waves.
  density: {
    options: [
      { label: 'Low', value: 0.5 },
      { label: 'Normal', value: 1 },
      { label: 'High', value: 1.75 },
      { label: 'Extreme', value: 2.75 },
    ],
    index: 3,
    apply: (sim, v) => sim.setEnemyDensity(v),
  },
  // Enemy skill, accuracy, gun range and damage, health and speed.
  difficulty: {
    options: [
      { label: 'Easy', value: 0 },
      { label: 'Medium', value: 1 },
      { label: 'Hard', value: 2 },
    ],
    index: 1,
    apply: (sim, v) => sim.setDifficulty(v),
  },
  // Simulator: no aim assist, true-size hitboxes, real ammunition, strict landing limits,
  // no turn back at the edge of the area, slow ground crew, lethal missiles.
  realism: {
    options: [
      { label: 'Arcade', value: 0 },
      { label: 'Simulator', value: 1 },
    ],
    index: 0,
    apply: (sim, v) => sim.setRealism(v),
  },
  // Game mode (layout.js MODE): endless waves, SAM-site strike, bomber escort or free flight.
  // Changing it mid-flight restarts the mission objectives.
  mode: {
    options: [
      { label: 'Waves', value: 0 },
      { label: 'Strike', value: 1 },
      { label: 'Escort', value: 2 },
      { label: 'Free', value: 3 },
    ],
    index: 0,
    apply: (sim, v) => sim.setMode(v),
  },
  // Graphics quality: Auto adapts resolution and effects to the frame rate (quality.js);
  // the others fix a tier. Not a core setting: it goes to the hook set by bindGraphics().
  graphics: {
    options: [
      { label: 'Auto', value: -1 },
      { label: 'Low', value: 0 },
      { label: 'Medium', value: 1 },
      { label: 'High', value: 2 },
    ],
    index: 0,
    apply: (_sim, v) => graphicsHook?.(v),
  },
};

// Storage can throw (private mode, blocked site data); settings then just aren't remembered.
function loadSaved(name) {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + name);
    const i = Number(raw);
    return raw !== null && Number.isInteger(i) ? i : null;
  } catch {
    return null;
  }
}

function save(name, index) {
  try {
    localStorage.setItem(STORAGE_PREFIX + name, String(index));
  } catch {}
}

for (const [name, setting] of Object.entries(SETTINGS)) {
  const saved = loadSaved(name);
  if (saved !== null && setting.options[saved]) setting.index = saved;
}

/** Push every setting into the core (needed after each `sim.init`, which resets them). */
export function applySettings(sim) {
  for (const s of Object.values(SETTINGS)) s.apply(sim, s.options[s.index].value);
}

function select(sim, name, index) {
  const setting = SETTINGS[name];
  setting.index = index;
  setting.apply(sim, setting.options[index].value);
  save(name, index);
  document.querySelectorAll(`[data-setting="${name}"] button`).forEach((b) => {
    b.setAttribute('aria-checked', String(Number(b.dataset.i) === index));
  });
}

/** Route the graphics setting to `hook(value)`, starting with the saved choice. */
export function bindGraphics(hook) {
  graphicsHook = hook;
  const s = SETTINGS.graphics;
  hook(s.options[s.index].value);
}

// Master volume (0..100 %), kept apart from SETTINGS because it drives the audio, not the core.
const VOLUME_KEY = STORAGE_PREFIX + 'volume';
const DEFAULT_VOLUME = 80;
const SLIDER_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

function loadVolume() {
  try {
    const raw = localStorage.getItem(VOLUME_KEY);
    const v = Number(raw);
    return raw !== null && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : DEFAULT_VOLUME;
  } catch {
    return DEFAULT_VOLUME;
  }
}

/** Wire every `[data-volume]` slider to `sound`; all copies stay in sync and the value is remembered. */
export function bindVolumeUi(sound) {
  const sliders = document.querySelectorAll('[data-volume]');
  const show = (v) => {
    sliders.forEach((s) => {
      s.value = String(v);
      s.setAttribute('aria-valuetext', `${v}%`);
      const out = s.parentElement.querySelector('.volume-value');
      if (out) out.textContent = `${v}%`;
    });
  };
  const initial = loadVolume();
  sound.volume = initial / 100;
  show(initial);
  sliders.forEach((s) => {
    s.addEventListener('input', () => {
      const v = Number(s.value);
      sound.setVolume(v / 100);
      show(v);
      try {
        localStorage.setItem(VOLUME_KEY, String(v));
      } catch {}
    });
    // Keep the slider's own keys from also steering the aircraft.
    s.addEventListener('keydown', (e) => {
      if (SLIDER_KEYS.has(e.key)) e.stopPropagation();
    });
  });
}

/** Build the option buttons for every settings group in the page. */
export function bindSettingsUi(sim) {
  document.querySelectorAll('[data-setting]').forEach((group) => {
    const name = group.dataset.setting;
    SETTINGS[name].options.forEach((option, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = option.label;
      b.dataset.i = i;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(i === SETTINGS[name].index));
      b.onclick = () => select(sim, name, i);
      group.append(b);
    });
  });
}

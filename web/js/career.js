// Pilot career: total kills across every sortie, remembered per browser, and the rank they earn.

const STORAGE_KEY = '1923.careerKills';

/** Ranks in order; `kills` is the career total needed to reach each one. */
export const RANKS = [
  { name: 'Cadet', short: 'CDT', kills: 0 },
  { name: 'Second Lieutenant', short: '2LT', kills: 5 },
  { name: 'First Lieutenant', short: '1LT', kills: 15 },
  { name: 'Captain', short: 'CPT', kills: 30 },
  { name: 'Major', short: 'MAJ', kills: 60 },
  { name: 'Lieutenant Colonel', short: 'LTC', kills: 100 },
  { name: 'Colonel', short: 'COL', kills: 175 },
  { name: 'Brigadier General', short: 'BG', kills: 275 },
  { name: 'Major General', short: 'MG', kills: 400 },
  { name: 'Lieutenant General', short: 'LTG', kills: 600 },
  { name: 'General', short: 'GEN', kills: 900 },
];

// Storage can throw (private mode, blocked site data); the career then lasts only this visit.
function load() {
  try {
    const n = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function rankIndex(kills) {
  let i = 0;
  while (i + 1 < RANKS.length && kills >= RANKS[i + 1].kills) i++;
  return i;
}

export class Career {
  constructor() {
    this.kills = load();
  }

  get rank() {
    return RANKS[rankIndex(this.kills)];
  }

  /** The next rank, or null at the top. */
  get next() {
    return RANKS[rankIndex(this.kills) + 1] ?? null;
  }

  /** Progress from the current rank toward the next (0..1, 1 at the top). */
  get progress() {
    const next = this.next;
    if (!next) return 1;
    const from = this.rank.kills;
    return (this.kills - from) / (next.kills - from);
  }

  /** Count one kill; returns the new rank when it earns a promotion, otherwise null. */
  addKill() {
    const before = rankIndex(this.kills);
    this.kills++;
    try {
      localStorage.setItem(STORAGE_KEY, String(this.kills));
    } catch {}
    const after = rankIndex(this.kills);
    return after > before ? RANKS[after] : null;
  }
}

/** Fill every `[data-career]` element with the rank, kill total and progress bar. */
export function renderCareer(career) {
  const { rank, next, kills } = career;
  const pct = Math.round(career.progress * 100);
  const goal = next ? `${next.kills - kills} kills to ${next.name}` : 'Highest rank reached';
  document.querySelectorAll('[data-career]').forEach((el) => {
    el.innerHTML = `
      <div class="career-head"><b class="career-rank">${rank.name}</b><span>${kills} kills</span></div>
      <div class="career-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${pct}%"></i></div>
      <div class="career-next">${goal}</div>`;
  });
}

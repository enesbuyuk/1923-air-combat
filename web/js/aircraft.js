// Aircraft roster, indexed by the aircraft type used in the WASM core.
// Flight performance lives in wasm/src/config.rs; this is the presentation side.
//
//   length       metres; GLB models are scaled to it
//   hitRadius    building-collision sphere (m)
//   eye          cockpit camera offset (aircraft frame)
//   cockpitHide  set from models.json for GLBs with a modelled cockpit: materials hidden in cockpit view
//   nozzles      exhaust positions, metres in the aircraft frame
//   afterburner  matches Stats.afterburner in config.rs
//   nozzleAspect nozzle height / width (rectangular Raptor exhaust)
//   missiles     missile capacity (matches STATS in config.rs)
//   mass         typical combat weight (kg); sets wingtip vortex strength
//   gOnset       effective +G stress threshold with implicit protection/straining;
//                representative pilot profiles, not certified aircraft-specific limits
//   bars         0..1 ratings shown in the menu

export const AIRCRAFT = [
  {
    key: 'f16', name: 'F-16 Fighting Falcon', role: 'Multirole fighter',
    length: 15.0, hitRadius: 4.5, eye: [0, 1.15, -3.9], nozzles: [[0, 0.05, 7.7]], nozzleRadius: 0.5,
    missiles: 6, gOnset: 6, mass: 12000, afterburner: true,
    bars: { speed: 0.78, agility: 0.8, armor: 0.33, missiles: 0.38 },
  },
  {
    key: 'f22', name: 'F-22 Raptor', role: '5th-gen air superiority',
    length: 18.9, hitRadius: 6.0, eye: [0, 1.2, -5.6], nozzles: [[-0.75, 0.0, 9.0], [0.75, 0.0, 9.0]], nozzleRadius: 0.5,
    missiles: 8, gOnset: 6, mass: 29000, afterburner: true, nozzleAspect: 0.55,
    bars: { speed: 0.95, agility: 0.95, armor: 0.4, missiles: 0.5 },
  },
  {
    key: 'b2', name: 'B-2 Spirit', role: 'Strategic stealth bomber',
    length: 21.0, hitRadius: 14.0, eye: [0, 1.9, -6.2], nozzles: [[-4.4, 0.6, 4.6], [-2.6, 0.6, 4.2], [2.6, 0.6, 4.2], [4.4, 0.6, 4.6]], nozzleRadius: 0.45,
    missiles: 0, gOnset: 4, mass: 72000, afterburner: false,
    bars: { speed: 0.5, agility: 0.3, armor: 1.0, missiles: 0.0 },
  },
  {
    key: 'kaan', name: 'KAAN MMU', role: 'National combat aircraft · TAI',
    length: 21.0, hitRadius: 6.0, eye: [0, 1.25, -6.0], nozzles: [[-0.85, 0.0, 9.9], [0.85, 0.0, 9.9]], nozzleRadius: 0.55,
    missiles: 8, gOnset: 6, mass: 27000, afterburner: true,
    bars: { speed: 0.9, agility: 0.9, armor: 0.38, missiles: 0.5 },
  },
];

/** Aircraft type index of the B-2, which gets special treatment (score, effects, audio). */
export const B2 = 2;

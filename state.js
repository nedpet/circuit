/* ═══ STATE ════════════════════════════════════════════════════════════════ */
// Central cross-section state. Anything ENGINE/CANVAS/APP need to read that
// originates outside their own scope lives here, instead of being scattered
// across individual ad hoc globals.
defineModule('state', [], () => {
  const widgetState = { delayMs: 600, particleDensity: 4, circuit: null, propagationMode: 'length' };
  return { widgetState };
});

/* ═══ ENGINE ═══════════════════════════════════════════════════════════════
   Composes the four engine-* modules — bit/gate math (engine-core), shape +
   wire geometry (engine-geometry), interactive wire routing (engine-routing),
   and the stateful circuit factory (engine-circuit) — into the single flat
   `engine` module every other module (gates/canvas/palette/app/state)
   depends on. Same public shape as before the split: every name any of the
   four sub-modules exports lands here unchanged, so nothing downstream
   needed to change when this got split out of one file into five.

   See engine-core.js, engine-geometry.js, engine-routing.js, and
   engine-circuit.js for the actual implementations, and each file's own
   header comment for why it depends on what it does. */
defineModule('engine', ['engine-core','engine-geometry','engine-routing','engine-circuit'],
  (core, geometry, routing, circuit) => ({
    ...core,
    ...geometry,
    ...routing,
    ...circuit,
  })
);

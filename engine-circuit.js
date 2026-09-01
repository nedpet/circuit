/* ═══ ENGINE: circuit factory ════════════════════════════════════════════
   The stateful simulation core — createCircuit() and every operation that
   acts on the component/wire/junction store it builds. Depends on
   engine-core (bit math + gate defs), engine-geometry (pin/wire geometry),
   engine-routing (cascading deletes on component/wire removal), and
   `state` (propagation mode/speed settings step()/wireSourceValue() read).
   Split out of engine.js; see engine.js for how this composes back
   together with the other engine-* modules. */
defineModule('engine-circuit', ['state','engine-core','engine-geometry','engine-routing'], (state, core, geometry, routing) => {
  'use strict';
  const { GATE_DEFS, BIT_WIDTH_KINDS, maskVal, pinBitWidthAt, compInputCount } = core;
  const { isWireTerminal, wireSegmentPoints, wireDelayForLength, pinAbs } = geometry;
  const { removeWireCascading, pruneDeadJunctions } = routing;

  // Runs `mutate` (some change to a geometry-affecting field on `c`, e.g.
  // bitWidth, muxInputs, or a SPLIT's bits/space) and shifts c.x/c.y by
  // however much that changed the absolute position of pin
  // `anchorKind`/`anchorIdx` on `c`, so that pin — and whatever wire is
  // attached to it — stays exactly where it was, and the shape visibly
  // grows/shrinks away from it instead of dragging it along.
  //
  // Comparing two real pinAbs calls (rather than hand-deriving "this
  // field grew by N px, so shift x/y by such-and-such") makes this
  // automatically correct for EVERY facing: pinAbs already knows how to
  // turn a change in local geometry into a change in absolute position
  // for any rotation, so this doesn't need its own copy of that math, and
  // doesn't need to special-case which facing "grows" which edge either.
  function compensateAnchor(c, anchorKind, anchorIdx, mutate) {
    const before = pinAbs(c, anchorKind, anchorIdx);
    mutate();
    const after = pinAbs(c, anchorKind, anchorIdx);
    c.x -= (after.x - before.x);
    c.y -= (after.y - before.y);
  }
  // Which pin (index 0) anchors an INPUT/OUTPUT/CONST's shape when its box
  // resizes — INPUT/CONST grow away from their single output pin; OUTPUT
  // grows away from its single input pin. Everything else that resizes
  // with bitWidth (REG) keeps a fixed footprint regardless (only its
  // little value readout grows — see setDisplayMode), so it has no anchor
  // pin at all, and this just applies the change directly.
  function ioAnchorPin(kind) {
    if (kind==='INPUT' || kind==='CONST') return 'out';
    if (kind==='OUTPUT') return 'in';
    return null;
  }
  function compensateIOAnchor(c, newBitWidth, newMode) {
    const anchorKind = ioAnchorPin(c.kind);
    const apply = () => { c.bitWidth = newBitWidth; c.displayMode = newMode; };
    if (!anchorKind) { apply(); return; }
    compensateAnchor(c, anchorKind, 0, apply);
  }

  // step()'s dirty-check (see the "Compute outputs" loop below): whether
  // two inputVals snapshots are identical, so a component whose inputs
  // haven't actually changed since the last tick can skip re-running
  // compute() and just reuse what it returned last time. Plain value
  // comparison is enough — inputVals are always flat arrays of 0/1 or
  // small ints, never objects.
  function arraysEqual(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  // Forces a component's compute() to actually run next tick even though
  // its inputVals haven't changed — for every setter below that changes
  // something OTHER than inputVals that compute() also reads (bitWidth,
  // comp.muxInputs, comp.shiftMode, a CONST's own state.value, ...). Without
  // this, e.g. widening a gate's bitWidth wouldn't visibly remask its
  // output until some unrelated input next flips.
  function markDirty(c) { c._lastInputVals = undefined; }

  // Validates a candidate SPLIT custom-layout pin-width array against a
  // trunk width: must be an array of 2..bits positive integers summing
  // exactly to bits (every trunk bit assigned to exactly one pin). Returns
  // the array unchanged if valid, otherwise null so callers (addComponent,
  // setSplitLayout) can fall back to a fresh default instead of trusting
  // stale/hand-edited data.
  function validSplitPinBits(pinBits, bits) {
    if (!Array.isArray(pinBits) || pinBits.length<2 || pinBits.length>bits) return null;
    let sum = 0;
    for (const w of pinBits) {
      if (!Number.isInteger(w) || w<1) return null;
      sum += w;
    }
    return sum===bits ? pinBits : null;
  }

  // Constructs a fresh, empty circuit instance: the mutable component/wire/
  // junction store, plus every operation — simulation stepping, mutation,
  // (de)serialization — that acts on it. Everything below lives in this
  // closure so it can share `components`/`wires`/`junctions`/id counters
  // without threading them through every call.
  function createCircuit() {
    let nextId = 1;
    let nextIoId = 1;
    const components = new Map();
    const ioComponents = new Map();
    const wires = new Map();
    const junctions = new Set(); // {x, y, sourceWireId}

    // Creates, registers, and returns a new component of `kind` at (x,y)
    // Most trailing params only apply to a few specific kinds;
    // they are stored as `undefined` on every other kind
    function addComponent(kind, x, y, facing = "right", delay = 0, label = "none", bitWidth, muxInputs, bitWidthIn, bitWidthOut, bits, space, splitType, layout, pinBits) {
      const def = GATE_DEFS[kind];
      const id = 'c'+(nextId++);
      const ioId = kind==='INPUT' || kind==='OUTPUT' ? 'io'+(nextIoId++) : ''
      // MUX and SPLIT's number of inputs varies per instance, so its
      // inputVals can't be sized off the kind's static def.inputs
      const muxN = kind==='MUX' ? Math.max(2,Math.min(4,Math.round(muxInputs||2))) : undefined;
      const splitBitsN = kind==='SPLIT' ? Math.max(2,Math.min(32,Math.round(bits||2))) : undefined;
      const splitTypeV = kind==='SPLIT' ? (splitType==='merge' ? 'merge' : 'split') : undefined;
      // The custom layout's per-pin widths, sanity-checked against the
      // resolved bit count above (see validSplitPinBits) — an invalid or
      // absent array (fresh placement, legacy save, hand-edited JSON)
      // falls back to the same one-pin-per-bit shape the regular layout
      // uses, so a freshly-flipped 'custom' component never looks
      // different from 'regular' until the user actually customizes it.
      const splitLayoutV = kind==='SPLIT' ? (layout==='custom' ? 'custom' : 'regular') : undefined;
      const splitPinBitsV = kind==='SPLIT' && splitLayoutV==='custom'
        ? (validSplitPinBits(pinBits, splitBitsN) || Array(splitBitsN).fill(1))
        : undefined;
      const inputCount = kind==='MUX' ? muxN+1
                        : (kind==='SPLIT' && splitTypeV==='merge') ? (splitLayoutV==='custom' ? splitPinBitsV.length : splitBitsN)
                        : def.inputs;
      const comp = {
        id, ioId, kind, x, y,
        state: kind==='INPUT' || kind==='CONST' ? {value:0}
            : kind==='CLOCK' ? {value:0, period:1000, lastTick:0, paused:false}
            : kind==='DFF'   ? {q:0, lastClk:0} : {},
        inputVals:  new Array(inputCount).fill(0),
        outputVals: new Array(def.outputs).fill(0),
        label: label == "none" ? String.fromCharCode(Number(ioId.slice(2)) + 64) : label,                     // for inputs/outputs: the label displayed next to component
        lastChange: 0,
        facing,                                                                                               // left, right, up, or down
        delay,                                                                                                // for gates: the ms it takes to process a signal
        bitWidth: BIT_WIDTH_KINDS.has(kind) ? Math.max(1,Math.min(32,Math.round(bitWidth||1))) : undefined,   // number of bits component-wide
        displayMode: kind==='REG' || kind==='OUTPUT' || kind==='INPUT' || kind==='CONST' ? 'bin' : undefined, // binary or hexadecimal display
        shiftMode: kind==='SHFT' ? 'left' : undefined,                                                        // logical left, logical right, arithmetic right
        muxInputs: muxN,
        muxSelectLocation: kind==='MUX' ? 'top' : undefined,                                                  // top or bottom
        bitWidthIn:  kind==='EXTND' ? Math.max(1,Math.min(32,Math.round(bitWidthIn||1)))  : undefined,
        bitWidthOut: kind==='EXTND' ? Math.max(1,Math.min(32,Math.round(bitWidthOut||1))) : undefined,
        bits:  splitBitsN,                                                                                    // number of bits to split
        space: kind==='SPLIT' ? Math.max(1,Math.min(8,Math.round(space||1))) : undefined,                     // space between 1-bit pins
        splitType: splitTypeV,                                                                                // split or merge
        layout: splitLayoutV,                                                                                 // regular (one 1-bit pin per bit) or custom (varying pin widths)
        pinBits: splitPinBitsV,                                                                               // custom layout only: each pin's own bit width, summing to `bits`
      };
      components.set(id, comp);
      if (ioId != '') {
        ioComponents.set(ioId, comp);
      }
      return comp;
    }

    // Deletes a component and every wire touching it
    function removeComponent(id) {
      const component = components.get(id);
      components.delete(id);
      if (component.ioId != ''){
        ioComponents.delete(component.ioId);
      }
      // Wires coming out of this component are deleted too
      // Wires feeding into this component are just detached
      for (const [wid,w] of [...wires]) {
        if (w.from.compId===id) {
          removeWireCascading(wid, {components, wires, junctions, removeWire});
        } else if (w.to.compId===id) {
          const p = pinAbs(component, w.to.type || 'in', w.to.pin);
          w.to = {x: p.x, y: p.y};
        }
      }
    }

    // Connects two wire terminals
    // Defaults an unlabeled pin terminal's `type` to 'out'/'in' by which side of the wire it's on
    // Refuses (and returns null instead of) creating an exact duplicate of an already-existing pin-to-pin wire
    function addWire(from, to) {
      if (isWireTerminal(from) && isWireTerminal(to)) {
        for (const w of wires.values()) {
          if (w.from.compId===from.compId && w.from.pin===from.pin &&
              w.to.compId===to.compId && w.to.pin===to.pin) return null;
        }
      }
      if (isWireTerminal(from) && !from.type) from.type='out';
      if (isWireTerminal(to) && !to.type)   to.type='in';
      const id = 'w'+(nextId++);
      const wire = {id, from, to, value:0, lastChange:0, points:[]};
      wires.set(id, wire);
      return wire;
    }

    // Deletes a wire and every junction branching off of it, then sweeps up
    // any OTHER junction this removal just left branchless
    function removeWire(id) {
      wires.delete(id);
      for (const j of junctions) {
        if (j.sourceWireId === id) junctions.delete(j);
      }
      pruneDeadJunctions({components, wires, ioComponents, junctions});
    }

    // Walks a wire back through branch junctions to find its source component pin, then returns its bit width
    // Returns null when the chain doesn't reach a real output pin, e.g. a dangling point
    function wireSourceBitWidth(wire, circuit, seen) {
      seen = seen || new Set();
      if (seen.has(wire.id)) return null;
      seen.add(wire.id);
      if (isWireTerminal(wire.from)) {
        return pinBitWidthAt(circuit.components.get(wire.from.compId), 'out', wire.from.pin);
      }
      if (typeof wire.from.x === 'number' && typeof wire.from.y === 'number') {
        for (const j of circuit.junctions) {
          if (Math.abs(j.x - wire.from.x) < 1e-6 && Math.abs(j.y - wire.from.y) < 1e-6) {
            const src = circuit.wires.get(j.sourceWireId);
            if (src) return wireSourceBitWidth(src, circuit, seen);
          }
        }
      }
      return null;
    }

    // Return whether the bit widths of the wire's out and in terminals don't match
    // If the wire doesn't end at a component, return false
    function wireBitMismatch(wire, circuit) {
      if (!isWireTerminal(wire.to)) return false;
      const dst = circuit.components.get(wire.to.compId);
      if (!dst) return false;
      const srcWidth = wireSourceBitWidth(wire, circuit);
      if (srcWidth == null) return false;
      return srcWidth !== pinBitWidthAt(dst, 'in', wire.to.pin);
    }

    // A wire's own effective delay budget, in component mode: the flat
    // `delayMs` nominal for a normal (non-branch) wire, or, for a wire
    // that's itself a branch, whatever wireSourceValue below already
    // worked out was left of it (`wire._ownDelay`, stored as a side
    // effect there — see the comment down there for why it has to be
    // computed from the PARENT's own effective delay rather than the flat
    // nominal for the recursive convergence to hold across chains of
    // branches-of-branches).
    // Length mode ignores this entirely — it's already correctly additive
    // by real geometric distance, with no shared "total budget" to
    // subdivide, so `nominalDelay` (already length-derived) passes through.
    function wireOwnDelay(w, nominalDelay) {
      if (state.widgetState.propagationMode !== 'component') return nominalDelay;
      return typeof w._ownDelay === 'number' ? w._ownDelay : nominalDelay;
    }

    // A no-op placeholder for callers that don't care about a branch's
    // own delay bookkeeping (reachMs/ownDelay) — see wireSourceValue below.
    const NO_REACH = {reachMs: 0, ownDelay: undefined};

    // Returns {value, reachMs, ownDelay} for the source of the wire, either
    // a pin or a junction. `value` is the value (0 or 1) currently visible
    // there. For branches, `reachMs`/`ownDelay` describe how long the
    // signal takes to reach the branchpoint on the parent wire, and how
    // much delay budget is left over after that — see wireOwnDelay above
    // for how that composes across chains of branches. These are NOT
    // written onto `wire` here — only step()'s caller does that, and only
    // at the exact moment `wire.pendingStart` itself gets (re)committed.
    // That matters: this function keeps recomputing every tick, but once
    // `src` finishes ITS OWN transition (pendingValue clears) partway
    // through this wire's wait, there's nothing left here to recompute —
    // the values from the tick this wire's own transition began need to
    // stay put, exactly like `wire.pendingStart` itself already does,
    // rather than being clobbered back to "no branch" on every later tick.
    function wireSourceValue(wire, circuit, now, instant) {
      if (isWireTerminal(wire.from)) {
        const src = circuit.components.get(wire.from.compId);
        if (!src) return {value: 0, ...NO_REACH};
        return {value: src.outputVals[wire.from.pin]||0, ...NO_REACH};
      }
      if (typeof wire.from.x === 'number' && typeof wire.from.y === 'number') {
        const px = wire.from.x, py = wire.from.y;
        // Look up the explicit junction registry instead of scanning geometry
        for (const j of circuit.junctions) {
          if (Math.abs(j.x - px) < 1e-6 && Math.abs(j.y - py) < 1e-6) {
            const src = circuit.wires.get(j.sourceWireId);
            if (!src) continue;

            if (instant) return {value: src.pendingValue!==undefined ? (src.pendingValue||0) : (src.value||0), ...NO_REACH};

            if (typeof src.pendingValue !== 'undefined') {
              // Find how far along the source wire the junction sits (0..1)
              const knots = wireSegmentPoints(src, circuit);
              let totalLen = 0;
              const lens = [];
              for (let i = 0; i < knots.length - 1; i++) {
                const l = Math.hypot(knots[i+1].x - knots[i].x, knots[i+1].y - knots[i].y);
                lens.push(l); totalLen += l;
              }
              let distToJunction = 0;
              for (let i = 0; i < knots.length - 1; i++) {
                const a = knots[i], b = knots[i+1];
                const onSeg =
                  (Math.abs(a.x - b.x) < 1e-6 && Math.abs(j.x - a.x) < 1e-6 && j.y >= Math.min(a.y,b.y)-1e-6 && j.y <= Math.max(a.y,b.y)+1e-6) ||
                  (Math.abs(a.y - b.y) < 1e-6 && Math.abs(j.y - a.y) < 1e-6 && j.x >= Math.min(a.x,b.x)-1e-6 && j.x <= Math.max(a.x,b.x)+1e-6);
                if (onSeg) {
                  distToJunction += Math.hypot(j.x - a.x, j.y - a.y);
                  break;
                }
                distToJunction += lens[i];
              }

              const t = totalLen > 0 ? distToJunction / totalLen : 0;
              // The signal reaches the junction at pendingStart + t * (src's
              // own EFFECTIVE delay budget) — in length mode that budget is
              // src's real geometric delay (so this is a straight physical-
              // distance fraction, same as always). In component mode it's
              // whatever src's own wireOwnDelay resolved to — which, if src
              // is itself a branch, is already reduced below the flat
              // nominal. Reading src's ACTUAL effective delay here (not the
              // flat nominal) is what lets this recurse correctly: this
              // wire's own remaining budget below is carved out of what its
              // parent actually had left, not a fresh flat delayMs, so an
              // arbitrarily deep chain of branches-of-branches still lands
              // on the same commit instant as the original root.
              const srcKnots = wireSegmentPoints(src, circuit);
              let srcTotalLen = 0;
              for (let i = 0; i < srcKnots.length - 1; i++) {
                srcTotalLen += Math.hypot(srcKnots[i+1].x - srcKnots[i].x, srcKnots[i+1].y - srcKnots[i].y);
              }
              const srcOwnDelay = wireOwnDelay(src, wireDelayForLength(srcTotalLen, state.widgetState.delayMs));
              const reachMs = t * srcOwnDelay;
              const ownDelay = Math.max(0, srcOwnDelay - reachMs);
              const arrivalTime = (src.pendingStart || 0) + reachMs;

              if (now >= arrivalTime) {
                return {value: src.pendingValue || 0, reachMs, ownDelay};
              } else {
                // Signal hasn't reached the junction yet
                return {value: src.value || 0, reachMs, ownDelay};
              }
            }

            return {value: src.value || 0, ...NO_REACH};
          }
        }
        return {value: 0, ...NO_REACH};
      }
      return {value: 0, ...NO_REACH};
    }


    // Advances the simulation by one tick, doing the following:
    //  - recomputes every component's inputs and outputs
    //  - ticks clocks
    //  - propagates values across wires
    // `instant` skips all delays, used for subcircuits or equation generation
    function step(now, delayMs, instant) {
      // Tick clocks
      for (const c of components.values()) {
        if (c.kind==='CLOCK' && !c.state.paused) {
          if (now - c.state.lastTick >= c.state.period/2) {
            c.state.value = c.state.value ? 0 : 1;
            c.state.lastTick = now;
          }
        }
      }
      // Compute outputs and hold each change for the gate's own `delay` (ms)
      // before it becomes visible on the output pin
      //
      // compute() only actually runs when this component's inputVals
      // changed since the last tick it ran (or def.alwaysRecompute opts it
      // out of the check, e.g. CLOCK) — otherwise the exact same inputVals
      // would just recompute the exact same outs, so the cached c._lastOuts
      // from last time is reused instead. For a plain gate that's a trivial
      // saving; for a CUSTOM gate it's the difference that matters — its
      // compute() runs an entire sub-circuit for up to 10 sub-steps, and
      // that cost was previously paid every tick for every instance
      // regardless of whether anything fed into it had changed, compounding
      // with every level of custom-gate nesting. A settled circuit's
      // inputVals stop changing almost everywhere, so this turns "replay
      // the whole nested tree every frame forever" into "only the part
      // that's actually still settling."
      for (const c of components.values()) {
        const def = GATE_DEFS[c.kind];
        const dirty = def.alwaysRecompute || !arraysEqual(c.inputVals, c._lastInputVals);
        const outs = dirty ? (def.compute(c.inputVals, c.state, c.bitWidth||1, c)||[]) : c._lastOuts;
        if (dirty) { c._lastInputVals = c.inputVals.slice(); c._lastOuts = outs; }
        if (!c.pendingOutputVals) c.pendingOutputVals = [];
        if (!c.pendingOutputStart) c.pendingOutputStart = [];
        for (let i=0;i<outs.length;i++) {
          if (outs[i]!==c.pendingOutputVals[i]) {
            if (outs[i]===c.outputVals[i]) {
              // Input reverted before the pending change ever landed — nothing
              // to propagate, so drop the in-flight change instead of letting
              // it commit as a stale glitch once the old timer expires.
              c.pendingOutputVals[i] = undefined;
              c.pendingOutputStart[i] = undefined;
            } else {
              // New target value: restart the delay from now instead of
              // keeping the original countdown, so the output always lands
              // one full delay after the most recent input change.
              c.pendingOutputVals[i] = outs[i];
              c.pendingOutputStart[i] = now;
            }
          }
          if (typeof c.pendingOutputVals[i] !== 'undefined' && (instant || now-(c.pendingOutputStart[i]||0) >= (c.delay||0))) {
            if (c.outputVals[i]!==c.pendingOutputVals[i]) { c.outputVals[i]=c.pendingOutputVals[i]; c.lastChange=now; }
            c.pendingOutputVals[i]=undefined; c.pendingOutputStart[i]=undefined;
          }
        }
      }
      // Propagate with delay
      for (const w of wires.values()) {
        const circuitRef = {components, wires, ioComponents, junctions};
        // A width mismatch between the pins this wire connects means the
        // signal shouldn't cross it at all, setting it to 0
        w.bitMismatch = wireBitMismatch(w, circuitRef);
        const {value: srcVal, reachMs, ownDelay} = w.bitMismatch ? {value:0, ...NO_REACH} : wireSourceValue(w, circuitRef, now, instant);
        if (srcVal!==w.pendingValue && srcVal!==w.value) {
          w.pendingValue=srcVal; w.pendingStart=now;
          // Commit this wire's own reachMs/ownDelay (see wireSourceValue)
          // ONLY at the exact tick its transition begins, same as
          // pendingStart just above — NOT every tick, since `src` (this
          // wire's parent, if it's a branch) can go on to finish ITS OWN
          // transition partway through this wire's wait, at which point
          // recomputing here would have nothing left to compute from and
          // would wrongly wipe these back to "not a branch".
          w._reachMs = reachMs; w._ownDelay = ownDelay;
        }
      }
      for (const w of wires.values()) {
        const knots = wireSegmentPoints(w, {components, wires, ioComponents});
        let wireLen = 0;
        for (let i = 0; i < knots.length - 1; i++) {
          wireLen += Math.hypot(knots[i+1].x - knots[i].x, knots[i+1].y - knots[i].y);
        }
        // wireOwnDelay: in component mode, a branch (w._reachMs>0, set by the
        // wireSourceValue pass just above) gets credit for however much of
        // its budget was already spent reaching its own pendingStart, so it
        // still lands on the same commit instant as its ultimate root wire.
        const wireDelay = wireOwnDelay(w, wireDelayForLength(wireLen, delayMs));

        if (typeof w.pendingValue !== 'undefined' && now - (w.pendingStart || 0) >= wireDelay) {
          if(w.value!==w.pendingValue){w.value=w.pendingValue;w.lastChange=now;}
          w.pendingValue=undefined; w.pendingStart=undefined;
        }
      }
      // Reset inputs from wires
      const acc = new Map();
      for (const c of components.values()) acc.set(c.id, new Array(compInputCount(c)).fill(0));
      for (const w of wires.values()) {
        if (!isWireTerminal(w.to)) continue;
        const a = acc.get(w.to.compId);
        if (a) {
          // If multiple wires drive the same input, combine drivers with OR
          a[w.to.pin] = (a[w.to.pin] || 0) || (w.value||0);
        }
      }
      for (const c of components.values()) c.inputVals=acc.get(c.id);
    }

    // Snapshots the circuit into a plain-object form suitable for JSON.stringify (Save), mirrored by load below
    function serialize() {
      return {
        components: [...components.values()].map(c=>({id:c.id,ioId:c.ioId,kind:c.kind,x:c.x,y:c.y,facing:c.facing,delay:c.delay,label:c.label,bitWidth:c.bitWidth,displayMode:c.displayMode,shiftMode:c.shiftMode,muxInputs:c.muxInputs,muxSelectLocation:c.muxSelectLocation,bitWidthIn:c.bitWidthIn,bitWidthOut:c.bitWidthOut,bits:c.bits,space:c.space,splitType:c.splitType,layout:c.layout,pinBits:c.pinBits?[...c.pinBits]:undefined,
          state:c.kind==='INPUT'||c.kind==='CONST'?{value:c.state.value}:c.kind==='CLOCK'?{period:c.state.period,paused:c.state.paused}:{}})),
        wires: [...wires.values()].map(w=>({id:w.id,from:w.from,to:w.to,points:w.points||[]})),
        junctions: [...junctions],
        nextId, nextIoId,
      };
    }

    // Replaces the circuit's contents with the components/wires/junctions encoded in `data` as produced by serialize
    function load(data) {
      components.clear(); ioComponents.clear(); wires.clear(); junctions.clear(); if(!data) return;
      // Built in two passes: addComponent()/addWire() assign throwaway sequential temp ids as a side effect of constructing the object,
      // and deletes it immediately from components to prevent it from interfering from later components that may have the same id
      // Only after every component is processed do they get assigned their actual ids
      const builtComponents = [];
      for (const cd of data.components||[]) {
        const c=addComponent(cd.kind,cd.x,cd.y,cd.facing,cd.delay,undefined,cd.bitWidth,cd.muxInputs,cd.bitWidthIn,cd.bitWidthOut,cd.bits,cd.space,cd.splitType,cd.layout,cd.pinBits); components.delete(c.id); ioComponents.delete(c.ioId);
        if(cd.label!==undefined) c.label=cd.label;
        if(cd.displayMode!==undefined) c.displayMode=cd.displayMode;
        if(cd.shiftMode!==undefined) c.shiftMode=cd.shiftMode;
        if(cd.muxSelectLocation!==undefined) c.muxSelectLocation=cd.muxSelectLocation;
        if(cd.state) Object.assign(c.state,cd.state);
        builtComponents.push({c,cd});
      }
      for (const {c,cd} of builtComponents) {
        c.id=cd.id; c.ioId=cd.ioId;
        components.set(c.id,c); ioComponents.set(c.ioId, c);
      }
      const builtWires = [];
      for (const wd of data.wires||[]) {
        const w=addWire(wd.from,wd.to); if(w){wires.delete(w.id); builtWires.push({w,wd});}
      }
      for (const {w,wd} of builtWires) {
        w.id=wd.id; w.points=wd.points||[]; wires.set(w.id,w);
      }
      for (const j of data.junctions||[]) {
        junctions.add(j);
      }
      nextId=Math.max(data.nextId||1,nextId);
      nextIoId=Math.max(data.nextIoId||1,nextIoId);
    }

    // Resets the io-pin id/label counter back to io1/'A'. Called on a full
    // canvas clear so a fresh circuit doesn't keep counting up from wherever
    // the previous one left off — see addComponent's ioId assignment above.
    function resetIoIds() { nextIoId = 1; }

    // Return for createCircuit(): returns all properties and methods the app may need to access after build
    return {
      components, wires, ioComponents, junctions,
      addComponent, removeComponent, addWire, removeWire, step, serialize, load, resetIoIds,
      // Exposed so the renderer's own pulse/waypoint-lighting animation (see
      // circuit_widget.html's wireProgress) can use the SAME effective delay
      // a branch actually commits on, instead of independently recomputing
      // the flat geometric one — see wireOwnDelay's own comment above for
      // why a branch's real delay isn't just wireDelayForLength(wireLen).
      wireOwnDelay,
      // Forces `id`'s compute() to actually run next tick even though its
      // inputVals haven't changed — see markDirty above. Exposed for
      // callers outside this module that mutate a component's state
      // directly instead of through one of the setters below, which all
      // already call markDirty themselves. Specifically: a CUSTOM gate's
      // own compute() (circuit_widget.html) pokes its sub-circuit's INPUT
      // ports' state.value this same way every time it runs, and an INPUT
      // has zero inputVals — so without this, that port's own compute()
      // would look "unchanged" forever after its first run and the whole
      // custom gate would freeze on its first-ever result.
      markComponentDirty(id) {
        const c = components.get(id);
        if (c) markDirty(c);
      },
      // Flips a single-bit INPUT's value
      toggleInput(id){
        const c=components.get(id);
        if(c&&c.kind==='INPUT') { c.state.value=c.state.value?0:1; markDirty(c); }
      },
      // Flips one bit of a multi-bit INPUT's value (in binary mode)
      toggleInputBit(id,bit){
        const c=components.get(id); if(!c||c.kind!=='INPUT') return;
        const width=c.bitWidth||1; if (bit<0||bit>=width) return;
        c.state.value = ((c.state.value||0) ^ (1<<bit)) >>> 0;
        markDirty(c);
      },
      // Increments one nibble of a multi-bit INPUT's value (in hexadecimal mode), wrapping F to 0
      // Remasks to bitWidth so a wrap on a partial top nibble can't leak bits past the pin's width
      incrementInputDigit(id,shift){
        const c=components.get(id); if(!c||c.kind!=='INPUT') return;
        const width=c.bitWidth||1;
        const v=c.state.value||0;
        const nibble=(v>>>shift)&0xF;
        const cleared=v & ~(0xF<<shift);
        c.state.value = maskVal((cleared | (((nibble+1)&0xF)<<shift))>>>0, width);
        markDirty(c);
      },
      // Changes a component's bitWidth (clamped 1-32)
      // Remasks any value already stored on it so it doesn't silently keep bits beyond the new, narrower width
      setBitWidth(id,w){
        const c=components.get(id); if(!c||!BIT_WIDTH_KINDS.has(c.kind)) return;
        const width=Math.max(1,Math.min(32,Math.round(w)||1));
        // INPUT/OUTPUT/CONST are the only BIT_WIDTH_KINDS whose box actually
        // resizes with bitWidth (see ioAnchorPin) — everything else keeps a
        // fixed footprint and just carries wider values internally. That
        // resize has one pin (INPUT/CONST: output; OUTPUT: input) which
        // should stay put so an attached wire doesn't visibly jump — see
        // compensateIOAnchor. It also applies the new bitWidth itself.
        compensateIOAnchor(c, width, c.displayMode);
        if (c.kind==='INPUT' || c.kind==='CONST') c.state.value = maskVal(c.state.value||0, width);
        if (c.kind==='REG') c.state.q = maskVal(c.state.q||0, width);
        markDirty(c);
      },
      // Sets EXTND's input width (clamped 1-32)
      setExtBitWidthIn(id,w){
        const c=components.get(id); if(!c||c.kind!=='EXTND') return;
        c.bitWidthIn=Math.max(1,Math.min(32,Math.round(w)||1));
        markDirty(c);
      },
      // Sets EXTND's output width (clamped 1-32)
      setExtBitWidthOut(id,w){
        const c=components.get(id); if(!c||c.kind!=='EXTND') return;
        c.bitWidthOut=Math.max(1,Math.min(32,Math.round(w)||1));
        markDirty(c);
      },
      // Switches a component's canvas readout between binary and hex
      setDisplayMode(id,mode){
        const c=components.get(id); if(!c||(c.kind!=='REG'&&c.kind!=='OUTPUT'&&c.kind!=='INPUT'&&c.kind!=='CONST')) return;
        const newMode = mode==='hex' ? 'hex' : 'bin';
        // REG's box and pin layout stay fixed regardless of mode — only its
        // little value readout grows (see gates.js's regValueText comment)
        // — so compensateIOAnchor just applies the mode change for it; it
        // only ever moves x/y for OUTPUT/INPUT/CONST, the kinds whose box
        // actually resizes. It also applies the new mode itself.
        compensateIOAnchor(c, c.bitWidth, newMode);
      },
      // Sets SHFT's shift direction/mode (logical left, logical right, or arithmetic right)
      setShiftMode(id,mode){
        const c=components.get(id); if(!c||c.kind!=='SHFT') return;
        c.shiftMode = (mode==='right'||mode==='arith') ? mode : 'left';
        markDirty(c);
      },
      // Changes MUX's number of inputs (clamped 2-4)
      setMuxInputs(id,n){
        const c=components.get(id); if(!c||c.kind!=='MUX') return;
        const newN=Math.max(2,Math.min(4,Math.round(n)||2));
        const oldN=c.muxInputs||2;
        if (newN===oldN) return;
        // Input pin 0 always sits at the same local position regardless of
        // input count (see muxGeometry) — the anchor pin to keep put as
        // the body grows/shrinks to fit the new count, same reasoning as
        // compensateIOAnchor.
        compensateAnchor(c, 'in', 0, () => { c.muxInputs=newN; });
        markDirty(c);
        // Wires connected to the select pin need to have their index updated
        // Wires connected to now deleted inputs are also deleted
        for (const [wid,w] of wires) {
          if (w.to.compId!==id || typeof w.to.pin!=='number') continue;
          if (w.to.pin===oldN) w.to={...w.to, pin:newN};
          else if (w.to.pin>=newN && w.to.pin<oldN) wires.delete(wid);
        }
      },
      // Moves MUX's select pin between the top and bottom edge
      setMuxSelectLocation(id,loc){
        const c=components.get(id); if(!c||c.kind!=='MUX') return;
        c.muxSelectLocation = loc==='bottom' ? 'bottom' : 'top';
      },
      // Changes SPLIT's total bit count (clamped 2-32)
      // In the custom layout, per-pin widths must keep summing to this
      // total, so a change here cascades onto the LAST pin: growing the
      // total hands the whole increase to it; shrinking it takes bits back
      // from it (and, once it's down to 1, the next-to-last pin, and so
      // on) — the same "last pin absorbs the change" rule setSplitPinCount
      // uses for adding/removing a pin, just applied to a width change
      // instead of a count change. That means the total can never drop
      // below the current pin count (every pin needs >=1 bit), so the
      // effective minimum is raised accordingly for custom layouts.
      setSplitBits(id,n){
        const c=components.get(id); if(!c||c.kind!=='SPLIT') return;
        const custom = c.layout==='custom' && Array.isArray(c.pinBits);
        const floor = custom ? Math.max(2,c.pinBits.length) : 2;
        const newN=Math.max(floor,Math.min(32,Math.round(n)||2));
        const oldN=c.bits||2;
        if (newN===oldN) return;
        // The diagonal (wide-bus) pin always sits at the same local
        // position regardless of bit count (see splitGeometry) — the
        // anchor pin to keep put as the trunk grows/shrinks to fit the
        // new count. Its kind (in for 'split' mode, out for 'merge')
        // follows splitType, same as everywhere else that pin is found.
        compensateAnchor(c, c.splitType==='merge' ? 'out' : 'in', 0, () => {
          c.bits=newN;
          if (custom) {
            let diff = newN - oldN;
            if (diff > 0) {
              c.pinBits[c.pinBits.length-1] += diff;
            } else {
              let need = -diff;
              for (let i=c.pinBits.length-1; i>=0 && need>0; i--) {
                const take = Math.min(need, c.pinBits[i]-1);
                c.pinBits[i] -= take;
                need -= take;
              }
            }
          }
        });
        markDirty(c);
        // Drop any wires still attached to now deleted pins (regular
        // layout only — in custom mode this width change never changes
        // the pin COUNT, so nothing here is actually deleted, but the
        // check is harmless to leave in place for both).
        const merge = c.splitType==='merge';
        const pinCount = custom ? c.pinBits.length : newN;
        for (const [wid,w] of wires) {
          const t = merge ? w.to : w.from;
          if (t.compId===id && typeof t.pin==='number' && t.pin>=pinCount) wires.delete(wid);
        }
      },
      // Sets the spacing (in grid units, clamped 1-8) between SPLIT's single-bit pins
      setSplitSpace(id,n){
        const c=components.get(id); if(!c||c.kind!=='SPLIT') return;
        // Same anchor-preservation reasoning as setSplitBits — space also
        // changes the trunk's own length (see splitGeometry), just via a
        // different field.
        compensateAnchor(c, c.splitType==='merge' ? 'out' : 'in', 0, () => {
          c.space=Math.max(1,Math.min(16,Math.round(n)||1));
        });
      },
      // Switches SPLIT mode between split and merge
      setSplitType(id,type){
        const c=components.get(id); if(!c||c.kind!=='SPLIT') return;
        const t = type==='merge' ? 'merge' : 'split';
        if (t===c.splitType) return;
        c.splitType=t;
        markDirty(c);
        // Delete all wires originally attached as the context in which they were attached no longer exists
        for (const [wid,w] of wires) {
          if (w.from.compId===id || w.to.compId===id) wires.delete(wid);
        }
      },
      // Switches SPLIT between the regular layout (one 1-bit pin per bit)
      // and the custom layout (pins with independently-set widths)
      setSplitLayout(id,layout){
        const c=components.get(id); if(!c||c.kind!=='SPLIT') return;
        const t = layout==='custom' ? 'custom' : 'regular';
        if (t===c.layout) return;
        // Entering custom: reuse whatever pinBits is already sitting on
        // this component (from a previous custom session) if it's still
        // valid for the current bit count, so flipping layout back and
        // forth doesn't throw away a customization the user already made.
        // If it's missing or stale (e.g. `bits` changed while regular),
        // fall back to the same one-pin-per-bit shape the regular layout
        // already shows, so the flip itself never causes a visual jump.
        const pinCountBefore = c.layout==='custom' && Array.isArray(c.pinBits) ? c.pinBits.length : (c.bits||2);
        compensateAnchor(c, c.splitType==='merge' ? 'out' : 'in', 0, () => {
          c.layout = t;
          if (t==='custom') {
            c.pinBits = validSplitPinBits(c.pinBits, c.bits||2) || Array(c.bits||2).fill(1);
          }
        });
        markDirty(c);
        // Prune wires on pins that no longer exist under the new pin count
        const merge = c.splitType==='merge';
        const pinCountAfter = t==='custom' ? c.pinBits.length : (c.bits||2);
        if (pinCountAfter < pinCountBefore) {
          for (const [wid,w] of wires) {
            const term = merge ? w.to : w.from;
            if (term.compId===id && typeof term.pin==='number' && term.pin>=pinCountAfter) wires.delete(wid);
          }
        }
      },
      // Changes SPLIT's number of pins in the custom layout (clamped 2 to
      // the current total bit count, since every pin needs >=1 bit).
      // Growing adds a new 1-bit pin and steals that bit from the last
      // pin that has one to spare; shrinking removes the last pin and
      // hands its bits to the (new) last pin — repeated once per pin
      // added/removed, so total bits never changes here, only how they're
      // divided up.
      setSplitPinCount(id,n){
        const c=components.get(id); if(!c||c.kind!=='SPLIT'||c.layout!=='custom'||!Array.isArray(c.pinBits)) return;
        const total = c.bits||2;
        const newN = Math.max(2,Math.min(total,Math.round(n)||2));
        const oldN = c.pinBits.length;
        if (newN===oldN) return;
        compensateAnchor(c, c.splitType==='merge' ? 'out' : 'in', 0, () => {
          if (newN > oldN) {
            for (let k=0;k<newN-oldN;k++) {
              let idx=-1;
              for (let i=c.pinBits.length-1;i>=0;i--) { if (c.pinBits[i]>1) { idx=i; break; } }
              if (idx===-1) break; // no spare bit anywhere — shouldn't happen since newN<=total
              c.pinBits[idx]--;
              c.pinBits.push(1);
            }
          } else {
            for (let k=0;k<oldN-newN;k++) {
              const removed = c.pinBits.pop();
              c.pinBits[c.pinBits.length-1] += removed;
            }
          }
        });
        markDirty(c);
        const merge = c.splitType==='merge';
        for (const [wid,w] of wires) {
          const t = merge ? w.to : w.from;
          if (t.compId===id && typeof t.pin==='number' && t.pin>=c.pinBits.length) wires.delete(wid);
        }
      },
      // Sets a single pin's own bit width in the custom layout, clamped to
      // 1..(total bits minus every OTHER pin's width) so the pins always
      // keep summing to the total. Never moves any pin (tap position only
      // depends on pin count/spacing, never on individual widths — see
      // splitGeometry), so unlike the other SPLIT setters this doesn't
      // need compensateAnchor.
      setSplitPinBits(id,idx,n){
        const c=components.get(id); if(!c||c.kind!=='SPLIT'||c.layout!=='custom'||!Array.isArray(c.pinBits)) return;
        if (idx<0 || idx>=c.pinBits.length) return;
        const total = c.bits||2;
        const sumOthers = c.pinBits.reduce((a,b,i)=> i===idx ? a : a+b, 0);
        const maxForPin = Math.max(1, total-sumOthers);
        const newVal = Math.max(1, Math.min(maxForPin, Math.round(n)||1));
        if (newVal === c.pinBits[idx]) return;
        c.pinBits[idx] = newVal;
        markDirty(c);
      },
      // Pauses/resumes a CLOCK
      // When resuming, restarts its tick timer to start from now so it doesn't immediately jump using a stale lastTick
      toggleClock(id){
        const c=components.get(id);
        if(c&&c.kind==='CLOCK'){
          c.state.paused=!c.state.paused;
          if(!c.state.paused)c.state.lastTick=performance.now();
        }
      },
      // Sets a CLOCK's full period, in ms
      setClockPeriod(id,p){
        const c=components.get(id);
        if(c&&c.kind==='CLOCK')c.state.period=p;
      },
      // Renames an IO component's label
      setIOLabel(id,l){
        const c=components.get(id);
        c.label=l;
      },
      // Sets a CONST's value, remasking it to its current bitWidth
      setConstValue(id,v){
        const c=components.get(id); if(!c||c.kind!=='CONST') return;
        c.state.value = maskVal(Math.max(0,Math.round(Number(v)||0)), c.bitWidth||1);
        markDirty(c);
      },
      // Rotates/mirrors a component by setting its facing (right, left, up, or down)
      setFacing(id,f){
        const c=components.get(id);
        c.facing=f;
      },
      // Sets a component's own gate propagation delay, in ms
      setDelay(id,d){
        const c=components.get(id);
        c.delay=d;
      },
      // Snapshots `id`'s full configuration for copy/paste: everything
      // serialize() keeps except id/ioId/position, which pasteComponent
      // assigns fresh. An IO's label gets "_copy" appended right here, off
      // the ORIGINAL label at copy time, so pasting the same clipboard
      // repeatedly doesn't stack more suffixes on top of each other.
      // Returns null if `id` isn't a component.
      copyComponent(id){
        const c = components.get(id); if (!c) return null;
        const isIO = c.kind==='INPUT' || c.kind==='OUTPUT';
        return {
          kind:c.kind, facing:c.facing, delay:c.delay,
          label: isIO ? c.label+'_copy' : c.label,
          bitWidth:c.bitWidth, displayMode:c.displayMode, shiftMode:c.shiftMode,
          muxInputs:c.muxInputs, muxSelectLocation:c.muxSelectLocation,
          bitWidthIn:c.bitWidthIn, bitWidthOut:c.bitWidthOut,
          bits:c.bits, space:c.space, splitType:c.splitType,
          layout:c.layout, pinBits:c.pinBits?[...c.pinBits]:undefined,
          // Only the sliver of `state` that's real configuration rather
          // than ephemeral runtime carries over — mirrors serialize(),
          // with one deliberate difference: a CLOCK drops paused/lastTick,
          // so a pasted copy always starts fresh and running instead of
          // possibly landing paused mid-cycle.
          state: c.kind==='INPUT'||c.kind==='CONST' ? {value:c.state.value}
               : c.kind==='CLOCK' ? {period:c.state.period} : {},
        };
      },
      // Recreates a copyComponent() snapshot at (x,y) — the paste half of
      // copy/paste. Same two-step reconstruction load() uses per saved
      // component: addComponent() for everything its own params cover,
      // then direct field assignment for the rest. Always wireless, same
      // as a fresh placement from the palette.
      pasteComponent(snapshot,x,y){
        if (!snapshot) return null;
        const c = addComponent(snapshot.kind, x, y, snapshot.facing, snapshot.delay, snapshot.label,
                                snapshot.bitWidth, snapshot.muxInputs, snapshot.bitWidthIn, snapshot.bitWidthOut,
                                snapshot.bits, snapshot.space, snapshot.splitType, snapshot.layout, snapshot.pinBits);
        if (snapshot.displayMode!==undefined) c.displayMode=snapshot.displayMode;
        if (snapshot.shiftMode!==undefined) c.shiftMode=snapshot.shiftMode;
        if (snapshot.muxSelectLocation!==undefined) c.muxSelectLocation=snapshot.muxSelectLocation;
        if (snapshot.state) Object.assign(c.state, snapshot.state);
        return c;
      },
    };
  }

  return { createCircuit };
});

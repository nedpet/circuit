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
    function addComponent(kind, x, y, facing = "right", delay = 0, label = "none", bitWidth, muxInputs, bitWidthIn, bitWidthOut, bits, space, splitType) {
      const def = GATE_DEFS[kind];
      const id = 'c'+(nextId++);
      const ioId = kind==='INPUT' || kind==='OUTPUT' ? 'io'+(nextIoId++) : ''
      // MUX and SPLIT's number of inputs varies per instance, so its
      // inputVals can't be sized off the kind's static def.inputs
      const muxN = kind==='MUX' ? Math.max(2,Math.min(4,Math.round(muxInputs||2))) : undefined;
      const splitBitsN = kind==='SPLIT' ? Math.max(2,Math.min(8,Math.round(bits||2))) : undefined;
      const splitTypeV = kind==='SPLIT' ? (splitType==='merge' ? 'merge' : 'split') : undefined;
      const inputCount = kind==='MUX' ? muxN+1
                        : (kind==='SPLIT' && splitTypeV==='merge') ? splitBitsN
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
      // A wire this component DROVE (its output pin is the wire's `from`)
      // has nothing left feeding it, so it goes too — and, same as
      // right-clicking it or deleting its first segment would,
      // recursively takes every branch reading from it (and every branch
      // of THOSE branches) along, rather than leaving them dangling on a
      // junction whose source just vanished. See removeWireCascading.
      //
      // A wire this component only READ from (its input pin is the
      // wire's `to`) is a completely different case: the wire itself,
      // and whatever's feeding it, is still perfectly valid — only this
      // one end has nowhere left to plug into. So it's detached rather
      // than deleted, at the exact spot the pin used to be (captured via
      // `component`, still held here even though it's already gone from
      // `components`), leaving it hanging exactly where the component
      // used to sit instead of taking it, and anything behind it, out
      // over a change that's entirely on the other end.
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
    // any OTHER junction this removal just left branchless (e.g. deleting
    // the last branch off some other wire's junction) — see
    // pruneDeadJunctions.
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

    // The value a wire is currently driven by, from its source — either a
    // component's output pin directly, or (for a wire branching off another
    // wire mid-route) whatever value has reached that branch point so far,
    // accounting for the source wire's own in-flight propagation delay.
    function wireSourceValue(wire, circuit, now, instant) {
      if (isWireTerminal(wire.from)) {
        const src = circuit.components.get(wire.from.compId);
        if (!src) return 0;
        return src.outputVals[wire.from.pin]||0;
      }
      if (typeof wire.from.x === 'number' && typeof wire.from.y === 'number') {
        const px = wire.from.x, py = wire.from.y;
        // Look up the explicit junction registry instead of scanning geometry
        for (const j of circuit.junctions) {
          if (Math.abs(j.x - px) < 1e-6 && Math.abs(j.y - py) < 1e-6) {
            const src = circuit.wires.get(j.sourceWireId);
            if (!src) continue;

            if (instant) return src.pendingValue!==undefined ? (src.pendingValue||0) : (src.value||0);

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
              // The signal reaches the junction at pendingStart + t * delayMs.
              // In component mode there's no concept of "partway along the
              // wire" — the junction sees the new value the instant the
              // source commits, and the branch pays its own flat delayMs
              // from there (so a source → branch hop still totals delayMs,
              // same as a direct wire, instead of double-paying).
              let arrivalTime;
              if (state.widgetState.propagationMode === 'component') {
                arrivalTime = src.pendingStart || 0;
              } else {
                const srcKnots = wireSegmentPoints(src, circuit);
                let srcTotalLen = 0;
                for (let i = 0; i < srcKnots.length - 1; i++) {
                  srcTotalLen += Math.hypot(srcKnots[i+1].x - srcKnots[i].x, srcKnots[i+1].y - srcKnots[i].y);
                }
                const srcWireDelay = wireDelayForLength(srcTotalLen, state.widgetState.delayMs);
                arrivalTime = (src.pendingStart || 0) + t * srcWireDelay;
              }

              if (now >= arrivalTime) {
                return src.pendingValue || 0;
              } else {
                // Signal hasn't reached the junction yet
                return src.value || 0;
              }
            }

            return src.value || 0;
          }
        }
        return 0;
      }
      return 0;
    }

    // Advances the simulation by one tick: ticks any running clocks,
    // recomputes every component's outputs (holding each change for the
    // component's own configured gate delay before it takes effect),
    // propagates values across every wire (holding each for its own travel
    // delay), and finally rebuilds every component's inputs from whatever
    // wires now drive them. `instant` skips all delays — used for settling
    // custom-gate sub-circuits and other places that need an immediate,
    // steady-state result rather than a delay-accurate animation frame.
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
      // Compute outputs, holding each change for the gate's own `delay` (ms)
      // before it becomes visible on the output pin — mirrors how wires hold
      // pendingValue for their travel time below.
      for (const c of components.values()) {
        const def = GATE_DEFS[c.kind];
        const outs = def.compute(c.inputVals, c.state, c.bitWidth||1, c)||[];
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
        // signal shouldn't cross it at all — held at 0 instead of the
        // driven value, with the mismatch itself flagged for rendering.
        w.bitMismatch = wireBitMismatch(w, circuitRef);
        const srcVal = w.bitMismatch ? 0 : wireSourceValue(w, circuitRef, now, instant);
        if (srcVal!==w.pendingValue && srcVal!==w.value) { w.pendingValue=srcVal; w.pendingStart=now; }
      }
      for (const w of wires.values()) {
        const knots = wireSegmentPoints(w, {components, wires, ioComponents});
        let wireLen = 0;
        for (let i = 0; i < knots.length - 1; i++) {
          wireLen += Math.hypot(knots[i+1].x - knots[i].x, knots[i+1].y - knots[i].y);
        }
        const wireDelay = wireDelayForLength(wireLen, delayMs);

        if (typeof w.pendingValue !== 'undefined' && now - (w.pendingStart || 0) >= wireDelay) {
          if(w.value!==w.pendingValue){w.value=w.pendingValue;w.lastChange=now;}
          w.pendingValue=undefined; w.pendingStart=undefined;
        }
        // Do not assign directly to component inputs here — inputs are
        // recomputed after propagation to avoid transient partial updates
        // that can cause a one-frame flicker when wires are reattached.
      }
      // Reset inputs from wires
      const acc = new Map();
      for (const c of components.values()) acc.set(c.id, new Array(compInputCount(c)).fill(0));
      for (const w of wires.values()) {
        if (!isWireTerminal(w.to)) continue;
        const a = acc.get(w.to.compId);
        if (a) {
          // If multiple wires drive the same input, combine drivers with OR
          // so a high on any wire keeps the input high instead of last-writer-wins.
          a[w.to.pin] = (a[w.to.pin] || 0) || (w.value||0);
        }
      }
      for (const c of components.values()) c.inputVals=acc.get(c.id);
    }

    // Snapshots the circuit into a plain-object form suitable for JSON.stringify (Save), mirrored by load below
    function serialize() {
      return {
        components: [...components.values()].map(c=>({id:c.id,ioId:c.ioId,kind:c.kind,x:c.x,y:c.y,facing:c.facing,delay:c.delay,label:c.label,bitWidth:c.bitWidth,displayMode:c.displayMode,shiftMode:c.shiftMode,muxInputs:c.muxInputs,muxSelectLocation:c.muxSelectLocation,bitWidthIn:c.bitWidthIn,bitWidthOut:c.bitWidthOut,bits:c.bits,space:c.space,splitType:c.splitType,
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
        const c=addComponent(cd.kind,cd.x,cd.y,cd.facing,cd.delay,undefined,cd.bitWidth,cd.muxInputs,cd.bitWidthIn,cd.bitWidthOut,cd.bits,cd.space,cd.splitType); components.delete(c.id); ioComponents.delete(c.ioId);
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

    // Return for createCircuit(). Returns all properties and methods the app may need to access after build
    return {
      components, wires, ioComponents, junctions,
      addComponent, removeComponent, addWire, removeWire, step, serialize, load,
      // Flips a single-bit INPUT's value
      toggleInput(id){
        const c=components.get(id);
        if(c&&c.kind==='INPUT') c.state.value=c.state.value?0:1;
      },
      // Flips one bit of a multi-bit INPUT's value (in binary mode)
      toggleInputBit(id,bit){
        const c=components.get(id); if(!c||c.kind!=='INPUT') return;
        const width=c.bitWidth||1; if (bit<0||bit>=width) return;
        c.state.value = ((c.state.value||0) ^ (1<<bit)) >>> 0;
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
      },
      // Changes a component's bitWidth (clamped 1-32)
      // Remasks any value already stored on it so it doesn't silently keep bits beyond the new, narrower width.
      setBitWidth(id,w){
        const c=components.get(id); if(!c||!BIT_WIDTH_KINDS.has(c.kind)) return;
        const width=Math.max(1,Math.min(32,Math.round(w)||1));
        c.bitWidth=width;
        if (c.kind==='INPUT' || c.kind==='CONST') c.state.value = maskVal(c.state.value||0, width);
        if (c.kind==='REG') c.state.q = maskVal(c.state.q||0, width);
      },
      // Sets EXTND's input width (clamped 1-32)
      setExtBitWidthIn(id,w){
        const c=components.get(id); if(!c||c.kind!=='EXTND') return;
        c.bitWidthIn=Math.max(1,Math.min(32,Math.round(w)||1));
      },
      // Sets EXTND's output width (clamped 1-32)
      setExtBitWidthOut(id,w){
        const c=components.get(id); if(!c||c.kind!=='EXTND') return;
        c.bitWidthOut=Math.max(1,Math.min(32,Math.round(w)||1));
      },
      // Switches a component's canvas readout between binary and hex
      setDisplayMode(id,mode){
        const c=components.get(id); if(!c||(c.kind!=='REG'&&c.kind!=='OUTPUT'&&c.kind!=='INPUT'&&c.kind!=='CONST')) return;
        c.displayMode = mode==='hex' ? 'hex' : 'bin';
      },
      // Sets SHFT's shift direction/mode (logical left, logical right, or arithmetic right)
      setShiftMode(id,mode){
        const c=components.get(id); if(!c||c.kind!=='SHFT') return;
        c.shiftMode = (mode==='right'||mode==='arith') ? mode : 'left';
      },
      // Changes MUX's number of inputs (clamped 2-4)
      setMuxInputs(id,n){
        const c=components.get(id); if(!c||c.kind!=='MUX') return;
        const newN=Math.max(2,Math.min(4,Math.round(n)||2));
        const oldN=c.muxInputs||2;
        if (newN===oldN) return;
        c.muxInputs=newN;
        // Select always sits at index === the input count, so it moves as
        // arity changes — a wire feeding it should follow to the new index
        // rather than silently become a data-line wire. Data pins beyond the
        // new count no longer exist at all, so their wires are dropped the
        // same way removeComponent drops a deleted component's wires.
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
      // Changes SPLIT's bit count (clamped 2-8)
      setSplitBits(id,n){
        const c=components.get(id); if(!c||c.kind!=='SPLIT') return;
        const newN=Math.max(2,Math.min(8,Math.round(n)||2));
        const oldN=c.bits||2;
        if (newN===oldN) return;
        c.bits=newN;
        // Drop any wires still attached to now deleted pins
        // Which side those pins are on depends on splitType (outputs in split mode, inputs in merge mode)
        const merge = c.splitType==='merge';
        for (const [wid,w] of wires) {
          const t = merge ? w.to : w.from;
          if (t.compId===id && typeof t.pin==='number' && t.pin>=newN) wires.delete(wid);
        }
      },
      // Sets the spacing (in grid units, clamped 1-8) between SPLIT's single-bit pins
      setSplitSpace(id,n){
        const c=components.get(id); if(!c||c.kind!=='SPLIT') return;
        c.space=Math.max(1,Math.min(8,Math.round(n)||1));
      },
      // Switches SPLIT mode between split and merge
      setSplitType(id,type){
        const c=components.get(id); if(!c||c.kind!=='SPLIT') return;
        const t = type==='merge' ? 'merge' : 'split';
        if (t===c.splitType) return;
        c.splitType=t;
        // Delete all wires originally attached as the context in which they were attached no longer exists
        for (const [wid,w] of wires) {
          if (w.from.compId===id || w.to.compId===id) wires.delete(wid);
        }
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
    };
  }

  return { createCircuit };
});

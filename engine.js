/* ═══ ENGINE ═══════════════════════════════════════════════════════════════ */
defineModule('engine', ['state'], (state) => {
  'use strict';

  // Every pin already maps to exactly one array slot (Q1/Q3 of the bit-width
  // research) — a "wide" pin just lets that slot hold an integer bus value
  // instead of a lone 0/1, so gate arity and wiring are untouched. maskVal
  // clamps a raw bitwise result down to the pin's configured width and back
  // to an unsigned reading, since JS's bitwise ops are 32-bit signed.
  function bitMask(width) { return width>=32 ? 0xFFFFFFFF : (Math.pow(2,width)-1); }
  function maskVal(v, width) { return (v & bitMask(width)) >>> 0; }

  // Kinds whose per-instance `bitWidth` is user-configurable (the remaining
  // sequential kinds are intentionally excluded for now).
  const BIT_WIDTH_KINDS = new Set(['INPUT','OUTPUT','AND','OR','NOT','NAND','NOR','XOR','XNOR','REG','MUX','SHFT']);

  // Most BIT_WIDTH_KINDS share one width across every pin, but REG's D input
  // and Q output are the only ones meant to carry a bus — EN/CLK/RESET stay
  // control lines and must stay 1-bit regardless of the component's bitWidth.
  const FIXED_WIDTH_PINS = { REG: { in: new Set([1,2,3]) } };

  // MUX's data inputs/output follow bitWidth like any other gate, but its
  // select pin is a control line whose OWN width is derived from muxInputs
  // (1 bit for a 2:1 mux, 2 bits once there are 3-4 data lines to address) —
  // never from bitWidth. Select always sits at input index muxInputs (the
  // last input pin), one past the last data line.
  function muxSelectWidth(muxInputs) { return (muxInputs||2) <= 2 ? 1 : 2; }

  // SHFT's shift-amount input (in1) only ever needs enough bits to address
  // every position in the value being shifted (in0/out, bitWidth wide) — a
  // standard barrel-shifter select width, derived rather than configurable.
  // bitWidth 1 has no meaningful shift amount, so it's floored at 1 bit.
  function shiftAmountWidth(bitWidth) { return Math.max(1, Math.ceil(Math.log2(Math.max(1,bitWidth||1)))); }

  // Sign-extends (or truncates) v — read as a two's-complement number in
  // fromWidth bits — into a toWidth-bit two's-complement reading. Going
  // through a signed intermediate (instead of just re-masking) is what makes
  // the top bits repeat the sign rather than zero-fill.
  function signExtend(v, fromWidth, toWidth) {
    const masked = maskVal(v, fromWidth);
    const half = Math.pow(2, fromWidth-1);
    const signed = masked >= half ? masked - Math.pow(2, fromWidth) : masked;
    const reencoded = signed < 0 ? signed + Math.pow(2, toWidth) : signed;
    return maskVal(reencoded, toWidth);
  }

  // Kinds outside BIT_WIDTH_KINDS (flip-flops other than REG, SEVEN, CLOCK)
  // only ever handle 1-bit values on all their pins.
  function pinBitWidthAt(comp, dir, idx) {
    if (!comp) return 1;
    if (comp.kind === 'MUX') {
      const n = comp.muxInputs || 2;
      if (dir === 'in' && idx === n) return muxSelectWidth(n);
      return comp.bitWidth || 1;
    }
    if (comp.kind === 'SHFT') {
      if (dir === 'in' && idx === 1) return shiftAmountWidth(comp.bitWidth);
      return comp.bitWidth || 1;
    }
    // EXTND has two independently configurable widths rather than one
    // shared bitWidth — in0 follows bitWidthIn, the output follows
    // bitWidthOut (EXTND is deliberately left out of BIT_WIDTH_KINDS since
    // that set means "one shared comp.bitWidth", which doesn't apply here).
    if (comp.kind === 'EXTND') {
      return dir === 'in' ? (comp.bitWidthIn||1) : (comp.bitWidthOut||1);
    }
    const fixed = FIXED_WIDTH_PINS[comp.kind];
    if (fixed && fixed[dir] && fixed[dir].has(idx)) return 1;
    return BIT_WIDTH_KINDS.has(comp.kind) ? (comp.bitWidth||1) : 1;
  }

  // MUX is the only kind whose *pin count* varies per instance (2-4 data
  // lines + 1 select), so unlike bitWidth this changes the size of
  // inputVals itself, not just how a slot's value is interpreted.
  function compInputCount(c) {
    return c.kind === 'MUX' ? (c.muxInputs||2) + 1 : GATE_DEFS[c.kind].inputs;
  }

  const GATE_DEFS = {
    INPUT:  { kind:'INPUT',  label:'IN',    inputs:0, outputs:1, family:'io',
              compute:(i,s,w) => [maskVal(s.value||0, w||1)] },
    OUTPUT: { kind:'OUTPUT', label:'OUT',   inputs:1, outputs:0, family:'io',
              compute:()=>[] },
    CLOCK:  { kind:'CLOCK',  label:'CLK',   inputs:0, outputs:1, family:'io',
              compute:(i,s) => [s.value?1:0] },
    SEVEN:  { kind:'SEVEN',  label:'7SEG',  inputs:7, outputs:0, family:'io',
              compute:()=>[] },
    AND:    { kind:'AND',  label:'AND',   inputs:2, outputs:1, family:'and',  compute:([a,b],s,w)=>[maskVal(a&b,w)] },
    OR:     { kind:'OR',   label:'OR',    inputs:2, outputs:1, family:'or',   compute:([a,b],s,w)=>[maskVal(a|b,w)] },
    NOT:    { kind:'NOT',  label:'NOT',   inputs:1, outputs:1, family:'not',  compute:([a],s,w)=>[maskVal(~a,w)] },
    NAND:   { kind:'NAND', label:'NAND',  inputs:2, outputs:1, family:'and',  compute:([a,b],s,w)=>[maskVal(~(a&b),w)] },
    NOR:    { kind:'NOR',  label:'NOR',   inputs:2, outputs:1, family:'or',   compute:([a,b],s,w)=>[maskVal(~(a|b),w)] },
    XOR:    { kind:'XOR',  label:'XOR',   inputs:2, outputs:1, family:'xor',  compute:([a,b],s,w)=>[maskVal(a^b,w)] },
    XNOR:   { kind:'XNOR', label:'XNOR',  inputs:2, outputs:1, family:'xor',  compute:([a,b],s,w)=>[maskVal(~(a^b),w)] },
    // inputVals is [data0..data(n-1), select] where n = comp.muxInputs (2-4);
    // arity is per-instance, so compute needs the whole comp, not just its
    // input array, to know where the select pin sits. A 3-input mux's select
    // is 2 bits (0-3) but only 3 data lines exist, so sel===3 falls back to 0.
    MUX:    { kind:'MUX',  label:'MUX',   inputs:3, outputs:1, family:'mux',
              compute:(inputVals,s,w,comp)=>{
                const n=(comp&&comp.muxInputs)||2;
                const sel=(inputVals[n]||0) & (n<=2?1:3);
                const val=(n===2) ? (sel?inputVals[1]:inputVals[0]) : ((sel<n)?(inputVals[sel]||0):0);
                return [maskVal(val||0, w||1)];
              } },
    DFF:    { kind:'DFF',  label:'D-FF',  inputs:2, outputs:1, family:'seq',
              compute:([d,clk],s)=>{ const r=clk&&!s.lastClk; s.lastClk=clk; if(r)s.q=d?1:0; return[s.q||0]; } },
    TFF:    { kind:'TFF',  label:'T-FF',  inputs:2, outputs:1, family:'seq',
              compute:([t,clk],s)=>{ const r=clk&&!s.lastClk; s.lastClk=clk; if(r&&t)s.q=s.q?0:1; return[s.q||0]; } },
    JKFF:   { kind:'JKFF', label:'JK-FF', inputs:3, outputs:1, family:'seq',
              compute:([j,k,clk],s)=>{ const r=clk&&!s.lastClk; s.lastClk=clk; if(r){if(j&&k)s.q=s.q?0:1; else if(j)s.q=1; else if(k)s.q=0;} return[s.q||0]; } },
    SRFF:   { kind:'SRFF', label:'SR-FF', inputs:2, outputs:1, family:'seq',
              compute:([s2,r],s)=>{ if(s2&&!r)s.q=1; else if(r&&!s2)s.q=0; return[s.q||0]; } },
    REG:    { kind:'REG',  label:'REGISTER',   inputs:4, outputs:1, family:'misc',
              compute:([d,en,clk,res],s,w)=>{ const r=clk&&!s.lastClk; s.lastClk=clk; if(res)s.q=0; else if(r&&en)s.q=maskVal(d||0,w||1); return[s.q||0]; } },
    // in0 (value) and out follow bitWidth; in1 (shift amount) is masked to
    // its own derived width so an unmasked/oversized value can't produce a
    // shift larger than the barrel actually supports. comp.shiftMode picks
    // the direction/fill: 'left' (logical, zero-fills from the low end —
    // the original/default behavior), 'right' (logical, zero-fills from the
    // high end), or 'arith' (right shift that repeats the sign bit instead
    // of zero-filling, per two's-complement reading of the w-bit value).
    SHFT:   { kind:'SHFT', label:'SHIFTER',  inputs:2, outputs:1, family:'misc',
              compute:([a,b],s,w,comp) => {
                const width = w||1;
                const amt = (b||0) & bitMask(shiftAmountWidth(width));
                const av = maskVal(a||0, width);
                const mode = (comp&&comp.shiftMode) || 'left';
                if (mode==='right') return [maskVal(av >>> amt, width)];
                if (mode==='arith') {
                  const half = Math.pow(2,width-1);
                  const signed = av>=half ? av-Math.pow(2,width) : av;
                  return [maskVal(Math.floor(signed/Math.pow(2,amt)), width)];
                }
                return [maskVal(av*(2**amt), width)];
              } } ,
    // Independently configurable in/out widths (bitWidthIn/bitWidthOut) live
    // on the comp itself rather than a single shared bitWidth, so compute
    // reads them off `comp` (4th arg) instead of the generic `w` width param.
    EXTND:  { kind:'EXTND', label:'EXTENDER', inputs:1, outputs:1, family:'misc',
              compute:([a],s,w,comp) => {
                const fromW = (comp&&comp.bitWidthIn)||1;
                const toW = (comp&&comp.bitWidthOut)||1;
                return [signExtend(a||0, fromW, toW)];
              } } ,
  };

  // ── Pure wire geometry helpers ──────────────────────────────────────────
  // Lives here (not in the CANVAS module) because ENGINE's step()/
  // wireSourceValue() needs these for delay propagation, and CANVAS also
  // needs them for rendering. CANVAS declares 'engine' as a dependency and
  // gets these back through its factory argument.

  function projectOrthogonalPoint(a,b,x,y) {
    if (a.x===b.x) return {x:a.x,y:Math.max(Math.min(y,Math.max(a.y,b.y)),Math.min(a.y,b.y))};
    if (a.y===b.y) return {x:Math.max(Math.min(x,Math.max(a.x,b.x)),Math.min(a.x,b.x)),y:a.y};
    return {x:a.x,y:a.y};
  }

  function terminalCoords(term, circuit) {
    if (!term) return {x:0,y:0};
    if (typeof term.compId==='string') {
      const comp = circuit.components.get(term.compId);
      if (!comp) return {x:term.x||0,y:term.y||0};
      // GATE_VIS lives in the 'gates' module, which itself depends on
      // 'engine' (for createCircuit/GATE_DEFS) — a real cycle. gates.js only
      // finishes registering after this factory returns, but pinAbs/
      // terminalCoords are never *called* until later, at simulation time,
      // by which point Modules.gates exists. So this one lookup deliberately
      // bypasses the declared-deps pattern and reaches into the registry
      // directly, instead of receiving 'gates' as a constructor argument.
      const vis = window.Modules.gates.visForComp(comp);
      const kind = term.type || (typeof term.pin==='number' && term.pin < (vis.inputs.length||0) ? 'in' : 'out');
      return pinAbs(comp, kind, term.pin);
    }
    return {x:term.x||0,y:term.y||0};
  }

  function wireKnots(x1,y1,x2,y2,pts=[]) {
    return [{x:x1,y:y1},...pts,{x:x2,y:y2}];
  }

  function resolveWire(x1,y1,x2,y2,pts=[]) {
    const knots=wireKnots(x1,y1,x2,y2,pts);
    const out=[knots[0]];
    for (let i=1;i<knots.length;i++) {
      const a=out[out.length-1], b=knots[i];
      if (a.x===b.x || a.y===b.y) {
        out.push(b);
      } else {
        out.push({x:b.x,y:a.y}, b);
      }
    }
    return out;
  }

  function wirePath(x1,y1,x2,y2,pts=[]) {
    const p=resolveWire(x1,y1,x2,y2,pts);
    return p.map((v,i)=>(i?'L ':'M ')+v.x+' '+v.y).join('');
  }

  function sampleWire(x1,y1,x2,y2,pts=[],t) {
    const p=resolveWire(x1,y1,x2,y2,pts);
    let total=0; const lens=[];
    for (let i=1;i<p.length;i++){const dx=p[i].x-p[i-1].x,dy=p[i].y-p[i-1].y,l=Math.hypot(dx,dy);lens.push(l);total+=l;}
    let d=t*total;
    for (let i=0;i<lens.length;i++){
      if(d<=lens[i]||i===lens.length-1){const f=lens[i]>0?Math.min(1,d/lens[i]):0;return[p[i].x+(p[i+1].x-p[i].x)*f,p[i].y+(p[i+1].y-p[i].y)*f];}
      d-=lens[i];
    }
    return [p[p.length-1].x,p[p.length-1].y];
  }

  function distToSeg(px,py,ax,ay,bx,by){
    const dx=bx-ax,dy=by-ay,l2=dx*dx+dy*dy;
    if(l2===0) return Math.hypot(px-ax,py-ay);
    const t=Math.max(0,Math.min(1,((px-ax)*dx+(py-ay)*dy)/l2));
    return Math.hypot(px-(ax+t*dx),py-(ay+t*dy));
  }

  function wireSegmentPoints(wire, circuit) {
    const from = terminalCoords(wire.from, circuit);
    const to = terminalCoords(wire.to, circuit);
    return wireKnots(from.x,from.y,to.x,to.y,wire.points||[]);
  }

  const WIRE_REF_LEN = 80; // roughly one gate width — reference length for length-based speed

  function wireDelayForLength(wireLen, delayMs) {
    // "component" mode: every wire takes exactly `delayMs` to propagate, so
    // two wires of different lengths off the same output still arrive
    // together. "length" mode (default): delay scales with wire length, at
    // delayMs per WIRE_REF_LEN pixels.
    if (state.widgetState.propagationMode === 'component') return delayMs;
    return (wireLen / WIRE_REF_LEN) * delayMs;
  }

  function findNearestWirePoint(wire,x,y,circuit) {
    const knots = wireSegmentPoints(wire, circuit);
    let best = {d:Infinity, point:null, index:0};
    for (let i=0;i<knots.length-1;i++) {
      const a=knots[i], b=knots[i+1];
      const proj = projectOrthogonalPoint(a,b,x,y);
      const d = Math.hypot(proj.x-x,proj.y-y);
      if (d < best.d) best = {d, point:proj, index:i};
    }
    return best;
  }

  function insertBranchPoint(wire, x, y, circuit) {
    const nearest = findNearestWirePoint(wire, x, y, circuit);
    if (!nearest.point) return null;
    const pt = nearest.point;
    const pts = wire.points || [];
    const idx = Math.max(0, nearest.index);
    const newPts = [...pts];
    newPts.splice(idx, 0, {x: pt.x, y: pt.y});
    wire.points = newPts;
    // Register this as an explicit junction so wireSourceValue
    // can find it without geometry scanning, and won't confuse
    // visual crossings with real connections.
    circuit.junctions.add({x: pt.x, y: pt.y, sourceWireId: wire.id});
    return pt;
  }

  function routeManhattanPoints(from, to, firstDir) {
    if (from.x === to.x || from.y === to.y) return [];
    const corner = firstDir === 'v' ? {x:from.x, y:to.y} : {x:to.x, y:from.y};
    return [corner];
  }

  function pinAbs(comp,kind,idx){
    const vis=window.Modules.gates.visForComp(comp),p=kind==='in'?vis.inputs[idx]:vis.outputs[idx];
    const cx=vis.w/2, cy=vis.h/2;
    if (comp.facing==='left') {
      // Mirror horizontally: flip x around centre
      return{x:comp.x+(vis.w-p.x), y:comp.y+p.y};
    }
    const angle = comp.facing==='up' ? -90 : comp.facing==='down' ? 90 : 0;
    const rad = angle * Math.PI / 180;
    const dx=p.x-cx, dy=p.y-cy;
    const rx = dx*Math.cos(rad) - dy*Math.sin(rad);
    const ry = dx*Math.sin(rad) + dy*Math.cos(rad);
    return{x:comp.x+cx+rx, y:comp.y+cy+ry};
  }

  function createCircuit() {
    let nextId = 1;
    let nextIoId = 1;
    const components = new Map();
    const ioComponents = new Map();
    const wires = new Map();
    const junctions = new Set(); // {x, y, sourceWireId}

    function addComponent(kind, x, y, facing = "right", delay = 0, label = "none", bitWidth, muxInputs, bitWidthIn, bitWidthOut) {
      const def = GATE_DEFS[kind];
      const id = 'c'+(nextId++);
      const ioId = kind==='INPUT' || kind==='OUTPUT' ? 'io'+(nextIoId++) : ''
      // MUX's pin count (unlike bitWidth) varies per instance, so its
      // inputVals can't be sized off the kind's static def.inputs.
      const muxN = kind==='MUX' ? Math.max(2,Math.min(4,Math.round(muxInputs||2))) : undefined;
      const inputCount = kind==='MUX' ? muxN+1 : def.inputs;
      const comp = {
        id, ioId, kind, x, y,
        state: kind==='INPUT' ? {value:0}
            : kind==='CLOCK' ? {value:0, period:1000, lastTick:0, paused:false}
            : kind==='DFF'   ? {q:0, lastClk:0} : {},
        inputVals:  new Array(inputCount).fill(0),
        outputVals: new Array(def.outputs).fill(0),
        label: label == "none" ? String.fromCharCode(Number(ioId.slice(2)) + 64) : label,
        lastChange: 0,
        facing,
        delay,
        bitWidth: BIT_WIDTH_KINDS.has(kind) ? Math.max(1,Math.min(32,Math.round(bitWidth||1))) : undefined,
        displayMode: kind==='REG' || kind==='OUTPUT' || kind==='INPUT' ? 'bin' : undefined,
        shiftMode: kind==='SHFT' ? 'left' : undefined,
        muxInputs: muxN,
        bitWidthIn:  kind==='EXTND' ? Math.max(1,Math.min(32,Math.round(bitWidthIn||1)))  : undefined,
        bitWidthOut: kind==='EXTND' ? Math.max(1,Math.min(32,Math.round(bitWidthOut||1))) : undefined,
      };
      components.set(id, comp);
      if (ioId != '') {
        ioComponents.set(ioId, comp);
      }
      return comp;
    }

    function removeComponent(id) {

      const component = components.get(id);
      components.delete(id);

      if (component.ioId != ''){
        ioComponents.delete(component.ioId);
      }
      for (const [wid,w] of wires) { if (w.from.compId===id||w.to.compId===id) wires.delete(wid); }
    }

    function isWireTerminal(target) {
      return target && typeof target.compId==='string' && typeof target.pin==='number';
    }

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

    function removeWire(id) {
      wires.delete(id);
      for (const j of junctions) {
        if (j.sourceWireId === id) junctions.delete(j);
      }
    }

    // Walks a wire back through branch junctions to the component pin that
    // ultimately drives it, so a branched wire is checked against the same
    // source width as the wire it forked from. Returns null when the chain
    // doesn't (yet) reach a real output pin — e.g. mid-drag or a dangling
    // free endpoint — since there's nothing to compare a width against.
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

    // A wire only has a meaningful width mismatch once both ends are real
    // pins — a branch-routing wire whose far end is still a free point isn't
    // flagged; the leaf wire that eventually lands on a pin is.
    function wireBitMismatch(wire, circuit) {
      if (!isWireTerminal(wire.to)) return false;
      const dst = circuit.components.get(wire.to.compId);
      if (!dst) return false;
      const srcWidth = wireSourceBitWidth(wire, circuit);
      if (srcWidth == null) return false;
      return srcWidth !== pinBitWidthAt(dst, 'in', wire.to.pin);
    }

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

    function serialize() {
      return {
        components: [...components.values()].map(c=>({id:c.id,ioId:c.ioId,kind:c.kind,x:c.x,y:c.y,facing:c.facing,delay:c.delay,label:c.label,bitWidth:c.bitWidth,displayMode:c.displayMode,shiftMode:c.shiftMode,muxInputs:c.muxInputs,bitWidthIn:c.bitWidthIn,bitWidthOut:c.bitWidthOut,
          state:c.kind==='INPUT'?{value:c.state.value}:c.kind==='CLOCK'?{period:c.state.period,paused:c.state.paused}:{}})),
        wires: [...wires.values()].map(w=>({id:w.id,from:w.from,to:w.to,points:w.points||[]})),
        junctions: [...junctions],
        nextId, nextIoId,
      };
    }

    function load(data) {
      components.clear(); ioComponents.clear(); wires.clear(); junctions.clear(); if(!data) return;
      // Built in two passes: addComponent()/addWire() assign throwaway
      // sequential temp ids as a side effect of constructing the object, and
      // those temp ids can coincide with another entry's *saved* id when the
      // original circuit has gaps (from earlier deletions). Inserting the
      // final id into the live map mid-loop let a later temp id silently
      // clobber an already-restored entry; instead, finish minting every
      // temp id first, then assign real ids and populate the maps once.
      const builtComponents = [];
      for (const cd of data.components||[]) {
        const c=addComponent(cd.kind,cd.x,cd.y,cd.facing,cd.delay,undefined,cd.bitWidth,cd.muxInputs,cd.bitWidthIn,cd.bitWidthOut); components.delete(c.id); ioComponents.delete(c.ioId);
        if(cd.label!==undefined) c.label=cd.label;
        if(cd.displayMode!==undefined) c.displayMode=cd.displayMode;
        if(cd.shiftMode!==undefined) c.shiftMode=cd.shiftMode;
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

    return {
      components, wires, ioComponents, junctions,
      addComponent, removeComponent, addWire, removeWire, step, serialize, load,
      toggleInput(id){const c=components.get(id);if(c&&c.kind==='INPUT')c.state.value=c.state.value?0:1;},
      toggleInputBit(id,bit){
        const c=components.get(id); if(!c||c.kind!=='INPUT') return;
        const width=c.bitWidth||1;
        if (bit<0||bit>=width) return;
        c.state.value = ((c.state.value||0) ^ (1<<bit)) >>> 0;
      },
      // Hex-mode cell click: bumps just its own nibble by 1 (wrapping 0xF->0)
      // and leaves every other nibble untouched, then re-masks to bitWidth so
      // a wrap on a partial top nibble can't leak bits past the pin's width.
      incrementInputDigit(id,shift){
        const c=components.get(id); if(!c||c.kind!=='INPUT') return;
        const width=c.bitWidth||1;
        const v=c.state.value||0;
        const nibble=(v>>>shift)&0xF;
        const cleared=v & ~(0xF<<shift);
        c.state.value = maskVal((cleared | (((nibble+1)&0xF)<<shift))>>>0, width);
      },
      setBitWidth(id,w){
        const c=components.get(id); if(!c||!BIT_WIDTH_KINDS.has(c.kind)) return;
        const width=Math.max(1,Math.min(32,Math.round(w)||1));
        c.bitWidth=width;
        if (c.kind==='INPUT') c.state.value = maskVal(c.state.value||0, width);
        if (c.kind==='REG') c.state.q = maskVal(c.state.q||0, width);
      },
      setExtBitWidthIn(id,w){
        const c=components.get(id); if(!c||c.kind!=='EXTND') return;
        c.bitWidthIn=Math.max(1,Math.min(32,Math.round(w)||1));
      },
      setExtBitWidthOut(id,w){
        const c=components.get(id); if(!c||c.kind!=='EXTND') return;
        c.bitWidthOut=Math.max(1,Math.min(32,Math.round(w)||1));
      },
      setDisplayMode(id,mode){
        const c=components.get(id); if(!c||(c.kind!=='REG'&&c.kind!=='OUTPUT'&&c.kind!=='INPUT')) return;
        c.displayMode = mode==='hex' ? 'hex' : 'bin';
      },
      setShiftMode(id,mode){
        const c=components.get(id); if(!c||c.kind!=='SHFT') return;
        c.shiftMode = (mode==='right'||mode==='arith') ? mode : 'left';
      },
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
      toggleClock(id){const c=components.get(id);if(c&&c.kind==='CLOCK'){c.state.paused=!c.state.paused;if(!c.state.paused)c.state.lastTick=performance.now();}},
      setClockPeriod(id,p){const c=components.get(id);if(c&&c.kind==='CLOCK')c.state.period=p;},
      setIOLabel(id,l){const c=components.get(id);c.label=l;},
      setFacing(id,f){const c=components.get(id);c.facing=f;},
      setDelay(id,d){const c=components.get(id);c.delay=d;},
    };
  }

  return {
    GATE_DEFS, BIT_WIDTH_KINDS, createCircuit,
    projectOrthogonalPoint, terminalCoords, wireKnots, resolveWire, wirePath,
    sampleWire, distToSeg, wireSegmentPoints, wireDelayForLength,
    findNearestWirePoint, insertBranchPoint, routeManhattanPoints, pinAbs,
  };
});

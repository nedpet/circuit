/* ═══ ENGINE ═══════════════════════════════════════════════════════════════ */
defineModule('engine', ['state'], (state) => {
  'use strict';

  const GATE_DEFS = {
    INPUT:  { kind:'INPUT',  label:'IN',    inputs:0, outputs:1, family:'io',
              compute:(i,s) => [s.value?1:0] },
    OUTPUT: { kind:'OUTPUT', label:'OUT',   inputs:1, outputs:0, family:'io',
              compute:()=>[] },
    CLOCK:  { kind:'CLOCK',  label:'CLK',   inputs:0, outputs:1, family:'io',
              compute:(i,s) => [s.value?1:0] },
    SEVEN:  { kind:'SEVEN',  label:'7SEG',  inputs:7, outputs:0, family:'io',
              compute:()=>[] },
    AND:    { kind:'AND',  label:'AND',   inputs:2, outputs:1, family:'and',  compute:([a,b])=>[(a&b)&1] },
    OR:     { kind:'OR',   label:'OR',    inputs:2, outputs:1, family:'or',   compute:([a,b])=>[(a|b)&1] },
    NOT:    { kind:'NOT',  label:'NOT',   inputs:1, outputs:1, family:'not',  compute:([a])=>[a?0:1] },
    NAND:   { kind:'NAND', label:'NAND',  inputs:2, outputs:1, family:'and',  compute:([a,b])=>[(a&b)?0:1] },
    NOR:    { kind:'NOR',  label:'NOR',   inputs:2, outputs:1, family:'or',   compute:([a,b])=>[(a|b)?0:1] },
    XOR:    { kind:'XOR',  label:'XOR',   inputs:2, outputs:1, family:'xor',  compute:([a,b])=>[(a^b)&1] },
    XNOR:   { kind:'XNOR', label:'XNOR',  inputs:2, outputs:1, family:'xor',  compute:([a,b])=>[(a^b)?0:1] },
    MUX:    { kind:'MUX',  label:'MUX',   inputs:3, outputs:1, family:'mux',  compute:([a,b,c])=>[c?b:a] },
    DFF:    { kind:'DFF',  label:'D-FF',  inputs:2, outputs:1, family:'seq',
              compute:([d,clk],s)=>{ const r=clk&&!s.lastClk; s.lastClk=clk; if(r)s.q=d?1:0; return[s.q||0]; } },
    TFF:    { kind:'TFF',  label:'T-FF',  inputs:2, outputs:1, family:'seq',
              compute:([t,clk],s)=>{ const r=clk&&!s.lastClk; s.lastClk=clk; if(r&&t)s.q=s.q?0:1; return[s.q||0]; } },
    JKFF:   { kind:'JKFF', label:'JK-FF', inputs:3, outputs:1, family:'seq',
              compute:([j,k,clk],s)=>{ const r=clk&&!s.lastClk; s.lastClk=clk; if(r){if(j&&k)s.q=s.q?0:1; else if(j)s.q=1; else if(k)s.q=0;} return[s.q||0]; } },
    SRFF:   { kind:'SRFF', label:'SR-FF', inputs:2, outputs:1, family:'seq',
              compute:([s2,r],s)=>{ if(s2&&!r)s.q=1; else if(r&&!s2)s.q=0; return[s.q||0]; } },
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
      const vis = window.Modules.gates.GATE_VIS[comp.kind];
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
    const vis=window.Modules.gates.GATE_VIS[comp.kind],p=kind==='in'?vis.inputs[idx]:vis.outputs[idx];
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

    function addComponent(kind, x, y, facing = "right", delay = 0, label = "none") {
      const def = GATE_DEFS[kind];
      const id = 'c'+(nextId++);
      const ioId = kind==='INPUT' || kind==='OUTPUT' ? 'io'+(nextIoId++) : ''
      const comp = {
        id, ioId, kind, x, y,
        state: kind==='INPUT' ? {value:0}
            : kind==='CLOCK' ? {value:0, period:1000, lastTick:0, paused:false}
            : kind==='DFF'   ? {q:0, lastClk:0} : {},
        inputVals:  new Array(def.inputs).fill(0),
        outputVals: new Array(def.outputs).fill(0),
        label: label == "none" ? String.fromCharCode(Number(ioId.slice(2)) + 64) : label,
        lastChange: 0,
        facing,
        delay,
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
        const outs = def.compute(c.inputVals, c.state)||[];
        if (!c.pendingOutputVals) c.pendingOutputVals = [];
        if (!c.pendingOutputStart) c.pendingOutputStart = [];
        for (let i=0;i<outs.length;i++) {
          if (outs[i]!==c.pendingOutputVals[i] && outs[i]!==c.outputVals[i]) {
            c.pendingOutputVals[i] = outs[i];
            c.pendingOutputStart[i] = now;
          }
          if (typeof c.pendingOutputVals[i] !== 'undefined' && (instant || now-(c.pendingOutputStart[i]||0) >= (c.delay||0))) {
            if (c.outputVals[i]!==c.pendingOutputVals[i]) { c.outputVals[i]=c.pendingOutputVals[i]; c.lastChange=now; }
            c.pendingOutputVals[i]=undefined; c.pendingOutputStart[i]=undefined;
          }
        }
      }
      // Propagate with delay
      for (const w of wires.values()) {
        const srcVal = wireSourceValue(w, {components, wires, ioComponents, junctions}, now, instant);
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
      for (const c of components.values()) acc.set(c.id, new Array(GATE_DEFS[c.kind].inputs).fill(0));
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
        components: [...components.values()].map(c=>({id:c.id,ioId:c.ioId,kind:c.kind,x:c.x,y:c.y,facing:c.facing,delay:c.delay,label:c.label,
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
        const c=addComponent(cd.kind,cd.x,cd.y,cd.facing,cd.delay); components.delete(c.id); ioComponents.delete(c.ioId);
        if(cd.label!==undefined) c.label=cd.label;
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
      toggleClock(id){const c=components.get(id);if(c&&c.kind==='CLOCK'){c.state.paused=!c.state.paused;if(!c.state.paused)c.state.lastTick=performance.now();}},
      setClockPeriod(id,p){const c=components.get(id);if(c&&c.kind==='CLOCK')c.state.period=p;},
      setIOLabel(id,l){const c=components.get(id);c.label=l;},
      setFacing(id,f){const c=components.get(id);c.facing=f;},
      setDelay(id,d){const c=components.get(id);c.delay=d;},
    };
  }

  return {
    GATE_DEFS, createCircuit,
    projectOrthogonalPoint, terminalCoords, wireKnots, resolveWire, wirePath,
    sampleWire, distToSeg, wireSegmentPoints, wireDelayForLength,
    findNearestWirePoint, insertBranchPoint, routeManhattanPoints, pinAbs,
  };
});

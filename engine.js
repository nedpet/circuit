/* ═══ ENGINE ═══════════════════════════════════════════════════════════════ */
defineModule('engine', ['state'], (state) => {
  'use strict';

  // These functions ensure v is read correctly as a width-bit unsigned input
  function bitMask(width) { 
    return width>=32 ? 0xFFFFFFFF : (Math.pow(2,width)-1); 
  }
  function maskVal(v, width) { 
    return (v & bitMask(width)) >>> 0; 
  }

  // Component whose per-instance `bitWidth` is user-configurable and consistent component-wide
  const BIT_WIDTH_KINDS = new Set(['INPUT','OUTPUT','CONST','AND','OR','NOT','NAND','NOR','XOR','XNOR','REG','MUX','SHFT']);

  // REG's EN/CLK/RESET must stay 1-bit regardless of the component's bitWidth
  const FIXED_WIDTH_PINS = { REG: { in: new Set([1,2,3]) } };

  // MUX's select pin width is derived from muxInputs, the number of inputs in the mux
  function muxSelectWidth(muxInputs) { 
    return (muxInputs||2) <= 2 ? 1 : 2; 
  }

  // SHFT's shift-amount input only needs enough bits to address every position in the value being shifted 
  // bitWidth 1 has no meaningful shift amount, so it's floored at 1 bit
  function shiftAmountWidth(bitWidth) { 
    return Math.max(1, Math.ceil(Math.log2(Math.max(1,bitWidth||1)))); 
  }

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

  // Returns the number of bits of the pin in direction dir at index idx on component comp
  // Kinds outside BIT_WIDTH_KINDS only ever handle 1-bit values on all their pins
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
    if (comp.kind === 'EXTND') {
      return dir === 'in' ? (comp.bitWidthIn||1) : (comp.bitWidthOut||1);
    }
    if (comp.kind === 'SPLIT') {
      const wide = comp.bits||2, narrow = 1;
      const merge = comp.splitType === 'merge';
      return dir === 'in' ? (merge ? narrow : wide) : (merge ? wide : narrow);
    }
    const fixed = FIXED_WIDTH_PINS[comp.kind];
    if (fixed && fixed[dir] && fixed[dir].has(idx)) return 1;
    return BIT_WIDTH_KINDS.has(comp.kind) ? (comp.bitWidth||1) : 1;
  }

  // Returns the number of inputs for component c
  // MUX and SPLIT are the only kinds whose input count varies per instance
  function compInputCount(c) {
    if (c.kind === 'MUX') return (c.muxInputs||2) + 1;
    if (c.kind === 'SPLIT') return c.splitType==='merge' ? (c.bits||2) : GATE_DEFS.SPLIT.inputs;
    return GATE_DEFS[c.kind].inputs;
  }

  const GATE_DEFS = {
    INPUT:  { kind:'INPUT',   label:'IN',    inputs:0, outputs:1, family:'io',
              compute:(i,s,w) => [maskVal(s.value||0, w||1)] },
    OUTPUT: { kind:'OUTPUT',  label:'OUT',   inputs:1, outputs:0, family:'io',
              compute:()=>[] },
    CLOCK:  { kind:'CLOCK',   label:'CLK',   inputs:0, outputs:1, family:'io',
              compute:(i,s) => [s.value?1:0] },
    CONST:  { kind:'CONST',   label:'CONST', inputs:0, outputs:1, family:'io',
              compute:(i,s,w) => [maskVal(s.value||0, w||1)] },
    SEVEN:  { kind:'SEVEN',   label:'7SEG',  inputs:7, outputs:0, family:'io',
              compute:()=>[] },
    AND:    { kind:'AND',     label:'AND',   inputs:2, outputs:1, family:'and',  
              compute:([a,b],s,w) => [maskVal(a&b,w)] },
    OR:     { kind:'OR',      label:'OR',    inputs:2, outputs:1, family:'or',   
              compute:([a,b],s,w) => [maskVal(a|b,w)] },
    NOT:    { kind:'NOT',     label:'NOT',   inputs:1, outputs:1, family:'not',  
              compute:([a],s,w)   => [maskVal(~a,w)] },
    NAND:   { kind:'NAND',    label:'NAND',  inputs:2, outputs:1, family:'and',  
              compute:([a,b],s,w) => [maskVal(~(a&b),w)] },
    NOR:    { kind:'NOR',     label:'NOR',   inputs:2, outputs:1, family:'or',   
              compute:([a,b],s,w) => [maskVal(~(a|b),w)] },
    XOR:    { kind:'XOR',     label:'XOR',   inputs:2, outputs:1, family:'xor',  
              compute:([a,b],s,w) => [maskVal(a^b,w)] },
    XNOR:   { kind:'XNOR',    label:'XNOR',  inputs:2, outputs:1, family:'xor',  
              compute:([a,b],s,w) => [maskVal(~(a^b),w)] },
    // arity is per-instance, so compute needs the whole comp to know where the select pin sits
    MUX:    { kind:'MUX',  label:'MUX',   inputs:3, outputs:1, family:'mux',
              compute:(inputVals,s,w,comp)=>{
                const n=(comp&&comp.muxInputs)||2;
                const sel=(inputVals[n]||0) & (n<=2?1:3);
                const val=(n===2) ? (sel?inputVals[1]:inputVals[0]) : ((sel<n)?(inputVals[sel]||0):0); // sel=3 when there are only 3 inputs sets it to 0
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
    SHFT:   { kind:'SHFT', label:'SHIFTER',  inputs:2, outputs:1, family:'misc',
              compute:([a,b],s,w,comp) => {
                const width = w||1;
                const amt = (b||0) & bitMask(shiftAmountWidth(width));
                const av = maskVal(a||0, width);
                const mode = (comp&&comp.shiftMode) || 'left';
                if (mode==='right') return [maskVal(av >>> amt, width)]; // logical, zero-fills from the high end
                if (mode==='arith') {                                    // right shift that repeats the sign bit
                  const half = Math.pow(2,width-1);
                  const signed = av>=half ? av-Math.pow(2,width) : av;
                  return [maskVal(Math.floor(signed/Math.pow(2,amt)), width)];
                }
                return [maskVal(av*(2**amt), width)];                    // logical, zero-fills from the low end
              } } ,
    EXTND:  { kind:'EXTND', label:'EXTENDER', inputs:1, outputs:1, family:'misc',
              compute:([a],s,w,comp) => {
                const fromW = (comp&&comp.bitWidthIn)||1;
                const toW = (comp&&comp.bitWidthOut)||1;
                return [signExtend(a||0, fromW, toW)];
              } } ,
    // 'split': one multibit input split into many 1-bit outputs
    // output i reads bit i of the input (0 = topmost pin = LSB) 
    // 'merge': many 1-bit inputs merge into one multibit output
    SPLIT:  { kind:'SPLIT', label:'SPLITTER', inputs:1, outputs:8, family:'misc',
              compute:(inputVals,s,w,comp) => {
                const n = (comp&&comp.bits)||2;
                if (comp && comp.splitType === 'merge') {
                  let v = 0;
                  for (let i=0;i<n;i++) v |= (inputVals[i]?1:0) << i;
                  return [v>>>0];
                }
                const v = inputVals[0]||0;
                return Array.from({length:n}, (_,i)=>(v>>>i)&1);
              } } ,
  };

  // ── Pure wire geometry helpers ──────────────────────────────────────────
  // Lives here (not in the CANVAS module) because ENGINE's step()/
  // wireSourceValue() needs these for delay propagation, and CANVAS also
  // needs them for rendering. CANVAS declares 'engine' as a dependency and
  // gets these back through its factory argument.

  // Projects (x,y) onto the axis-aligned segment a-b, clamped to the
  // segment's extent — used to find the closest point on a wire for
  // hit-testing and branch-point insertion. Wires are always Manhattan
  // (axis-aligned) routed, so the "neither aligned" case just falls back to
  // a's own point rather than needing a general point-to-line projection.
  function projectOrthogonalPoint(a,b,x,y) {
    if (a.x===b.x) return {x:a.x,y:Math.max(Math.min(y,Math.max(a.y,b.y)),Math.min(a.y,b.y))};
    if (a.y===b.y) return {x:Math.max(Math.min(x,Math.max(a.x,b.x)),Math.min(a.x,b.x)),y:a.y};
    return {x:a.x,y:a.y};
  }

  // Returns the absolute canvas coordinate of the end of a wire
  // Either a {compId,pin} reference, in which it calls pinAbs,
  // or a free {x,y} point (being dragged or left dangling)
  function terminalCoords(term, circuit) {
    if (!term) return {x:0,y:0};
    if (typeof term.compId==='string') {
      const comp = circuit.components.get(term.compId);
      if (!comp) return {x:term.x||0,y:term.y||0};
      const vis = window.Modules.gates.visForComp(comp);
      const kind = term.type || (typeof term.pin==='number' && term.pin < (vis.inputs.length||0) ? 'in' : 'out');
      return pinAbs(comp, kind, term.pin);
    }
    return {x:term.x||0,y:term.y||0};
  }

  // Assembles a wire's full point list in the correct order: 
  // its startpoint, then any user-added waypoints, then its endpoint 
  function wireKnots(x1,y1,x2,y2,pts=[]) {
    return [{x:x1,y:y1},...pts,{x:x2,y:y2}];
  }

  // Turns a wire's raw endpoint+waypoint list into an orthogonal path by inserting
  // an elbow point wherever two consecutive knots aren't already aligned on one axis
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

  // Renders resolveWire()'s resolved point list as an SVG path `d` string
  function wirePath(x1,y1,x2,y2,pts=[]) {
    const p=resolveWire(x1,y1,x2,y2,pts);
    return p.map((v,i)=>(i?'L ':'M ')+v.x+' '+v.y).join('');
  }

  // Returns the point at fraction `t` (0-1) along a wire's resolved, orthogonal path
  // Used to place the animated in-flight signal pulse
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

  // Shortest distance from point (px,py) to the segment (ax,ay)-(bx,by) —
  // a general (not axis-restricted) point-to-segment distance, used for
  // wire-hover/click hit-testing.
  function distToSeg(px,py,ax,ay,bx,by){
    const dx=bx-ax,dy=by-ay,l2=dx*dx+dy*dy;
    if(l2===0) return Math.hypot(px-ax,py-ay);
    const t=Math.max(0,Math.min(1,((px-ax)*dx+(py-ay)*dy)/l2));
    return Math.hypot(px-(ax+t*dx),py-(ay+t*dy));
  }

  // A wire's full knot list in absolute canvas coordinates — its resolved
  // pin endpoints plus any waypoints, unrouted (i.e. before resolveWire's
  // elbow-insertion).
  function wireSegmentPoints(wire, circuit) {
    const from = terminalCoords(wire.from, circuit);
    const to = terminalCoords(wire.to, circuit);
    return wireKnots(from.x,from.y,to.x,to.y,wire.points||[]);
  }

  const WIRE_REF_LEN = 80; // roughly one gate width — reference length for length-based speed

  // How long (ms) a wire of length `wireLen` takes to propagate a change,
  // per the current propagation mode.
  function wireDelayForLength(wireLen, delayMs) {
    // "component" mode: every wire takes exactly `delayMs` to propagate, so
    // two wires of different lengths off the same output still arrive
    // together. "length" mode (default): delay scales with wire length, at
    // delayMs per WIRE_REF_LEN pixels.
    if (state.widgetState.propagationMode === 'component') return delayMs;
    return (wireLen / WIRE_REF_LEN) * delayMs;
  }

  // Closest point on a wire's path to (x,y), and which segment (by index
  // into its knot list) it falls on — used to decide where a new
  // branch/waypoint should be inserted.
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

  // Splits a wire at the point nearest (x,y) by inserting a waypoint there
  // — unless that nearest point is already an existing knot (a prior
  // waypoint, or one of the wire's own endpoints), in which case there's
  // nothing to insert: multiple wires can already share one junction just
  // fine (wireSourceValue matches by coordinate, not by count), so this
  // only avoids piling up redundant, visually-identical duplicate waypoints
  // when several branches start from the exact same spot — e.g. dragging a
  // new branch off a waypoint that's already a junction.
  function insertBranchPoint(wire, x, y, circuit) {
    const nearest = findNearestWirePoint(wire, x, y, circuit);
    if (!nearest.point) return null;
    const pt = nearest.point;
    const pts = wire.points || [];
    const EPS = 1e-6;
    const samePoint = (a,b) => Math.abs(a.x-b.x)<EPS && Math.abs(a.y-b.y)<EPS;
    const alreadyExists = pts.some(p=>samePoint(p,pt))
      || samePoint(terminalCoords(wire.from,circuit), pt)
      || samePoint(terminalCoords(wire.to,circuit), pt);
    if (!alreadyExists) {
      const idx = Math.max(0, nearest.index);
      const newPts = [...pts];
      newPts.splice(idx, 0, {x: pt.x, y: pt.y});
      wire.points = newPts;
    }
    // Register this as an explicit junction so wireSourceValue can find it
    // without geometry scanning, and won't confuse visual crossings with
    // real connections. Skipped if one's already registered right here
    // (same reasoning as above — this point may already be a junction).
    const dup = [...circuit.junctions].some(j=>j.sourceWireId===wire.id && samePoint(j, pt));
    if (!dup) circuit.junctions.add({x: pt.x, y: pt.y, sourceWireId: wire.id});
    return pt;
  }

  // A junction never goes away by itself as a direct user action anymore
  // (see onWaypointContext in the widget, which now deletes a junction's
  // whole host wire rather than singling out just the junction) — this
  // only cleans up what's left registered after every branch reading from
  // a junction is actually gone. Called after every wire removal (explicit
  // right-click delete, a junction's host wire going with it, or a branch
  // dragged back onto its own branchpoint — see finalizeEndpointRoute) to
  // sweep up any junction that's now branchless.
  //
  // A now-branchless junction is only actually deleted, along with its
  // waypoint, when it sits at a plain pass-through on its source wire's path
  // — i.e. removing it wouldn't change the wire's shape at all, because its
  // neighbors on either side are already collinear with it. A junction at a
  // real elbow stays registered (and thus still not directly deletable)
  // even with zero branches, since deleting *that* would reshape the source
  // wire itself — this function only ever cleans up redundant bookkeeping,
  // never the source wire's own geometry. Same reasoning for a junction that
  // sits at the source wire's own endpoint rather than partway along it:
  // there's no "middle" for it to be in the middle of, so it's left alone.
  function pruneDeadJunctions(circuit) {
    const EPS = 1e-6;
    const same = (a,b) => Math.abs(a.x-b.x)<EPS && Math.abs(a.y-b.y)<EPS;
    for (const j of [...circuit.junctions]) {
      const hasBranch = [...circuit.wires.values()].some(w => w.id!==j.sourceWireId &&
        (same(terminalCoords(w.from,circuit), j) || same(terminalCoords(w.to,circuit), j)));
      if (hasBranch) continue;
      const src = circuit.wires.get(j.sourceWireId);
      if (!src) { circuit.junctions.delete(j); continue; } // source wire is already gone too
      const from = terminalCoords(src.from,circuit), to = terminalCoords(src.to,circuit);
      const knots = wireKnots(from.x, from.y, to.x, to.y, src.points || []);
      const idx = knots.findIndex(k => same(k, j));
      if (idx <= 0 || idx >= knots.length-1) continue; // at the wire's own endpoint, not partway along it
      const prev = knots[idx-1], cur = knots[idx], next = knots[idx+1];
      const straight = (prev.x===cur.x && cur.x===next.x) || (prev.y===cur.y && cur.y===next.y);
      if (!straight) continue; // a real elbow — still shapes the wire, so the junction stays
      src.points.splice(idx-1, 1); // knots[1..len-2] map 1:1 onto src.points
      circuit.junctions.delete(j);
    }
  }

  // Picks a single elbow corner for a new wire between two points that
  // don't already share an axis, going vertical-then-horizontal or
  // horizontal-then-vertical depending on firstDir. Points already sharing
  // an axis need no corner at all.
  function routeManhattanPoints(from, to, firstDir) {
    if (from.x === to.x || from.y === to.y) return [];
    const corner = firstDir === 'v' ? {x:from.x, y:to.y} : {x:to.x, y:from.y};
    return [corner];
  }

  // How far a straight, axis-aligned move from `a` toward `b` can travel
  // while staying on top of `segs` (consecutive point pairs of some wire's
  // resolved path). Returns the furthest point from `a` toward `b` that's
  // still covered by the wire — `a` itself if the move leaves it right away,
  // `b` if the whole move runs along it. Coverage carries through abutting
  // collinear segments, so a wire that turns a corner and comes back onto
  // the same line still reads as one continuous run.
  function overlapRunEnd(a, b, segs) {
    const EPS = 1e-6;
    const horiz = Math.abs(a.y - b.y) < EPS;
    if (!horiz && Math.abs(a.x - b.x) > EPS) return a; // not axis-aligned — nothing to follow
    const along = (p) => horiz ? p.x : p.y;  // coordinate the move varies
    const off   = (p) => horiz ? p.y : p.x;  // coordinate it holds fixed
    const start = along(a), end = along(b);
    const sign = end >= start ? 1 : -1;
    // Only wire segments sitting on the very same line can cover any of it.
    const spans = [];
    for (const [s,t] of segs) {
      if ((Math.abs(s.y-t.y) < EPS) !== horiz) continue;
      if (Math.abs(off(s) - off(a)) > EPS) continue;
      spans.push([Math.min(along(s),along(t)), Math.max(along(s),along(t))]);
    }
    let reach = start;
    for (;;) {
      let next = reach;
      for (const [lo,hi] of spans) {
        if (reach < lo-EPS || reach > hi+EPS) continue;   // span doesn't touch how far we've got
        const far = sign > 0 ? hi : lo;
        if ((far-next)*sign > EPS) next = far;
      }
      if ((next-reach)*sign <= EPS) break;                // nothing extends the run any further
      reach = next;
    }
    if ((reach-end)*sign > 0) reach = end;                // never run past the move's own end
    return horiz ? {x:reach, y:a.y} : {x:a.x, y:reach};
  }

  // Where a branch dragged off `wire` should actually start, and what's left
  // of its route once the part that merely retraces `wire` is dropped.
  //
  // A branch drag often opens by running *along* the wire it came from —
  // grab a horizontal wire, pull right then up, and that entire first leg
  // lies on top of the wire, drawing a second copy of a connection that's
  // already there. Rather than that, the junction slides forward to the
  // corner where the route genuinely diverges off the wire, and only the
  // part beyond that corner becomes the new wire.
  //
  // Returns {start, points}: the junction position, and the branch's
  // waypoint list measured from it. Returns null when the route never leaves
  // the wire at all — then the "branch" is pure duplicate, so callers should
  // create nothing.
  function branchRouteFrom(wire, from, to, firstDir, circuit) {
    const EPS = 1e-6;
    const route = [from, ...routeManhattanPoints(from, to, firstDir), to];
    const a = terminalCoords(wire.from, circuit), b = terminalCoords(wire.to, circuit);
    // The *resolved* path, so we compare against the wire as actually drawn
    // (elbows included) rather than its raw knot list.
    const path = resolveWire(a.x, a.y, b.x, b.y, wire.points || []);
    const segs = [];
    for (let i=1;i<path.length;i++) segs.push([path[i-1], path[i]]);

    // Follow the route leg by leg for as long as it stays on the wire. The
    // first leg to get cut short is the one carrying the branch away, and
    // where it got cut short is the corner the junction belongs at.
    let start = from, leg = 1;
    for (; leg < route.length; leg++) {
      start = overlapRunEnd(start, route[leg], segs);
      if (Math.abs(start.x-route[leg].x) > EPS || Math.abs(start.y-route[leg].y) > EPS) break;
    }
    if (leg >= route.length) return null; // every leg ran along the wire
    return { start, points: route.slice(leg, route.length-1) };
  }

  // Absolute canvas position of one pin (input or output, by index) of a
  // component, accounting for its facing — rotated about its own center for
  // up/down, or mirrored horizontally for left (matching how GateBody
  // draws the component itself).
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
      // Routed through removeWire (rather than deleting from `wires`
      // directly) so a component that anchored a branch's target, or a
      // source wire's own endpoint, gets the same junction cleanup a
      // manual wire deletion would.
      for (const [wid,w] of [...wires]) { if (w.from.compId===id||w.to.compId===id) removeWire(wid); }
    }

    // Returns true if `target` is a real component-pin reference, as opposed to a
    // free-floating {x,y} endpoint (a dangling wire end, or a branch point)
    function isWireTerminal(target) {
      return target && typeof target.compId==='string' && typeof target.pin==='number';
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

  return {
    GATE_DEFS, BIT_WIDTH_KINDS, createCircuit,
    projectOrthogonalPoint, terminalCoords, wireKnots, resolveWire, wirePath,
    sampleWire, distToSeg, wireSegmentPoints, wireDelayForLength,
    findNearestWirePoint, insertBranchPoint, routeManhattanPoints, pinAbs,
    branchRouteFrom,
  };
});

/* ═══ ENGINE: shape + wire geometry ═════════════════════════════════════════
   Pure coordinate math — component pin layouts (for the shapes whose size
   varies per instance) and wire-path geometry — with no dependency on
   engine-core's bit-level math, and none of engine-routing's interactive
   editing logic either. Depends only on `state` (for the propagation-mode
   setting wireDelayForLength reads). Split out of engine.js; see engine.js
   for how this composes back together with the other engine-* modules. */
defineModule('engine-geometry', ['state'], (state) => {
  'use strict';

  // ── Parametric component shape geometry ─────────────────────────────────
  // Pin layout and footprint for the components whose size varies per
  // instance (MUX, SPLIT, and multi-bit INPUT/OUTPUT/CONST)

  // Returns the width, height, input/output coords, and y-coord of the middle of the top/bottom edges
  // for a mux with n inputs and select pin location (top or bottom)
  function muxGeometry(n, selectLocation) {
    const count = Math.max(2, Math.min(4, n|0||2)); // number of bits (2-4)
    const bottom = selectLocation==='bottom';
    const W=80, MUX_PIN_GAP=40, MUX_TOP_MARGIN=20, STUB=12;
    const h = count*MUX_PIN_GAP; // 80 for count=2
    const inputs = Array.from({length:count},(_,i)=>({x:0,y:MUX_TOP_MARGIN+i*MUX_PIN_GAP}));
    const outY = h/2, bt=6, bb=h-6; // input (left) edge's own corners -- fixed, so its length (bb-bt) never changes with n
    // Output (right) edge's own corners -- rt (top) and rb (bottom) --
    // are solved for instead of a fixed .25/.75 split of bb, so the
    // select pin (which sits wherever the diagonal edges cross x=W*0.5 --
    // always each edge's exact midpoint, since BX sits the same distance
    // in from both sides -- offset by its STUB-px stub) lands on a grid
    // line like every other pin: (bt+rt)/2-STUB=0 gives rt=2*STUB-bt; rb
    // mirrors it (h-rt), the same way the two select-pin locations
    // mirror each other, so aligning the top edge's corner aligns the
    // bottom edge's too. Doesn't depend on h at all (bt is fixed), so 0
    // is always a valid target -- rt sits comfortably between bt and bb
    // regardless of how many inputs the mux has.
    const rt = 2*STUB - bt, rb = h - rt;
    const selectY = bottom ? h : 0;
    inputs.push({x:W*0.5,y:selectY,dir: bottom ? 'down' : 'up'});
    return { w:W, h, inputs, outputs:[{x:W,y:outY}], bt, bb, rt, rb };
  }

  // Returns the width, height, input/output locations,
  // x-coords of the vertical trunk, tap pins, and wide (trunk-side) pin,
  // coords of the tap pins, and y-coords of the top and bottom tap pins
  // for a splitter with n taps, space units between taps, and type (merge or split).
  // n is the number of TAPS, not necessarily the trunk's bit width — in the
  // regular layout they're the same (one tap per bit), but the custom
  // layout can have fewer/more taps than trunk bits, each carrying its own
  // width (see engine-core's pinBitWidthAt/GATE_DEFS.SPLIT.compute); tap
  // *position* only ever depends on the count and spacing, never on any
  // tap's individual width, so this function doesn't need to know widths.
  const SPLIT_UNIT = 20; // matches the widget's own 20px grid snap
  function splitGeometry(n, space, type) {
    const bits = Math.max(2, Math.min(32, n|0||2));
    const sp = Math.max(1, Math.min(16, space|0||1));
    const merge = type==='merge';
    const gap = sp*SPLIT_UNIT, topY = SPLIT_UNIT;
    const w = SPLIT_UNIT + 20; 
    const trunkX = merge ? w-SPLIT_UNIT : SPLIT_UNIT;
    const tapX   = merge ? 0 : w;
    const diagX  = merge ? w : 0;
    const taps = Array.from({length:bits}, (_,i)=>({x:tapX, y:topY+i*gap}));
    const diagPin = {x:diagX, y:0, dir:'up', noStub:true};     // skips GateBody's generic (cardinal-only) stub renderer in favour of a diagonal pin
    const lastY = topY + (bits-1)*gap;
    return {
      w, h: lastY,
      inputs:  merge ? taps : [diagPin],
      outputs: merge ? [diagPin] : taps,
      trunkX, tapX, diagX, taps, topY, lastY,
    };
  }

  // Returns the width of an input/output component with n cells
  // BIT_CELL_W+BIT_GAP is exactly one grid unit (20px), and BIT_PAD*2+BIT_CELL_W
  // is exactly two, so bitsRowWidth(n) always comes out to 20*(n+1) -- a grid
  // multiple for every n, not just some -- which keeps the pin (on the box's
  // far edge) grid-aligned after the component's own x/y gets snapped on drag.
  const BIT_CELL_W=18, BIT_GAP=2, BIT_PAD=11;
  function bitsRowWidth(n) { return BIT_PAD*2 + n*BIT_CELL_W + Math.max(0,n-1)*BIT_GAP; }

  // Returns the width, height, and input/output locations
  // for a multi-bit input/output component with n bits and mode (bin or hex)
  // Doesn't handle the 1-bit case
  function inputOutputGeometry(n, mode, isOutput) {
    const cellCount = mode==='hex' ? Math.ceil(n/4) : n;
    const w = bitsRowWidth(cellCount), h = 40;
    return isOutput ? { w, h, inputs:[{x:0,y:20}], outputs:[] }
                     : { w, h, inputs:[], outputs:[{x:w,y:20}] };
  }

  // Returns the width, height, and input/output locations
  // for a multi-bit constant component with n bits and mode (bin or hex)
  const CONST_CHAR_W=9, CONST_PAD=12;
  function constGeometry(n, mode) {
    const digits = mode==='hex' ? Math.ceil(n/4) : n;
    const rawW = Math.max(40, digits*CONST_CHAR_W + CONST_PAD*2);
    // Rounded up to the next grid unit (never down, so the text always still
    // fits) -- same reasoning as bitsRowWidth, but simpler here since the
    // body's just a centered readout, not a grid of individually-positioned
    // cells, so a little extra width beyond the digits' own footprint just
    // means slightly more breathing room either side rather than a gap.
    const w = Math.ceil(rawW/20)*20, h = 40;
    return { w, h, inputs:[], outputs:[{x:w,y:20}] };
  }

  // ── Pure wire geometry helpers ──────────────────────────────────────────

  // Returns the projection of (x,y) onto the axis-aligned segment a-b, clamped to the segment's extent 
  // Used to find the closest point on a wire for hit-testing and branch-point insertion
  function projectOrthogonalPoint(a,b,x,y) {
    if (a.x===b.x) return {x:a.x,y:Math.max(Math.min(y,Math.max(a.y,b.y)),Math.min(a.y,b.y))};
    if (a.y===b.y) return {x:Math.max(Math.min(x,Math.max(a.x,b.x)),Math.min(a.x,b.x)),y:a.y};
    return {x:a.x,y:a.y};
  }

  // Returns true if `target` is a real component-pin reference, as opposed to a
  // free-floating {x,y} endpoint (a dangling wire end or a branch point)
  function isWireTerminal(target) {
    return target && typeof target.compId==='string' && typeof target.pin==='number';
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

  // Recalculate's a wire's path when it is attached to a component that has just been dragged 
  // Handles all three ways a pin's move can leave that one waypoint out of date: 
  //  - it needs a corner it didn't have before (the pin moved off the axis it used to share with the next knot)
  //  - it needs to shift (still a corner, just not the same one)
  //  - it doesn't need one anymore (the pin moved back onto that axis)
  // Only ever changes the waypoint nearest to `side`
  // `oldAnchor` is the previous location of the component that was just moved
  // `commitJunctions` is only true when the component is dropped to prevent excessive "junction-thrashing" during live preview
  // Waypoints left untouched if anything else still needs that waypoint (a junction, or another wire's own endpoint)
  // Instead creates new points off of that waypoint to help connect to where the component was dragged
  function syncEndCorner(wire, side, circuit, commitJunctions=true, oldAnchor=null) {
    const EPS = 1e-6;
    const same = (a,b) => Math.abs(a.x-b.x)<EPS && Math.abs(a.y-b.y)<EPS;
    const otherSide = side==='from' ? 'to' : 'from';
    const anchor = terminalCoords(wire[side], circuit); // moved pin's current location
    const pts = wire.points || [];

    if (pts.length===0) { // no waypoints, i.e. wire was a straight line
      const other = terminalCoords(wire[otherSide], circuit);
      if (Math.abs(anchor.x-other.x)<EPS || Math.abs(anchor.y-other.y)<EPS) return; // same axis, no corners needed
      if (oldAnchor) {
        const intoVertical = Math.abs(other.x - oldAnchor.x) < EPS; // wire used to be a vertical line
        wire.points = [intoVertical
          ? {x:other.x, y:anchor.y}   // established segment was vertical — continue that column, then turn to reach anchor
          : {x:anchor.x, y:other.y}]; // established segment was horizontal — continue that row, then turn to reach anchor
        return;
      }
      wire.points = [side==='from' ? {x:other.x, y:anchor.y} : {x:anchor.x, y:other.y}]; // fallback, not guaranteed to work
      return;
    }

    const nearIdx = side==='from' ? 0 : pts.length-1;
    const nearPt = pts[nearIdx]; // the closest waypoint to the original endpoint
    const farNeighbor = pts.length>=2 
      ? (side==='from' ? pts[1] : pts[pts.length-2]) // the next waypoint in line
      : terminalCoords(wire[otherSide], circuit);    // the other endpoint

    // is nearPt needed by some other wire, i.e. is it some endpoint already?
    const hasLiveBranch = [...circuit.wires.values()].some(w=>w.id!==wire.id &&
      ((!isWireTerminal(w.from) && same(terminalCoords(w.from,circuit),nearPt)) ||
       (!isWireTerminal(w.to)   && same(terminalCoords(w.to,circuit),  nearPt))));

    if (!hasLiveBranch) {
      // Is nearPt redundant, i.e. is it collinear with the wire passing through it?
      const redundant =
        (Math.abs(nearPt.x-farNeighbor.x)<EPS && Math.abs(nearPt.x-anchor.x)<EPS) ||
        (Math.abs(nearPt.y-farNeighbor.y)<EPS && Math.abs(nearPt.y-anchor.y)<EPS);
      if (redundant) {
        wire.points = pts.filter((_,i)=>i!==nearIdx); // removes nearPt since it won't change the shape of the wire
        if (commitJunctions) {
          const ownJ = [...circuit.junctions].find(j=>j.sourceWireId===wire.id && same(j,nearPt));
          if (ownJ) circuit.junctions.delete(ownJ); // orphaned bookkeeping — pruneDeadJunctions can't find it once it's off the wire's own path
        }
        return;
      }
    }

    if (Math.abs(anchor.x-nearPt.x)<EPS || Math.abs(anchor.y-nearPt.y)<EPS) return; // pin dragged along the axis nearPt's own segment ran on: pure extend/shorten, nothing to add
    // pin dragged off that axis, thus the segment is extended/shortened then branches
    const intoVertical = Math.abs(farNeighbor.x - nearPt.x) < EPS;
    const newCorner = intoVertical
      ? {x:anchor.x, y:nearPt.y}   // nearPt's own outgoing run was horizontal
      : {x:nearPt.x, y:anchor.y};  // nearPt's own outgoing run was vertical
    wire.points = side==='from' ? [newCorner, ...pts] : [...pts, newCorner];
  }

  // Runs syncEndCorner for both ends of `wire` repeatedly until neither makes a further change
  // A single from-then-to pass isn't enough: fixing one end could change the other
  function syncWireEndCorners(wire, circuit, commitJunctions=true, oldAnchors={}) {
    for (let guard=0; guard<8; guard++) {
      const before = wire.points;
      syncEndCorner(wire, 'from', circuit, commitJunctions, oldAnchors.from);
      syncEndCorner(wire, 'to', circuit, commitJunctions, oldAnchors.to);
      if (wire.points === before) break; // neither call changed anything — stable
    }
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

  // Splits a wire's resolved path into two SVG path `d` strings:
  // "before" already reached by fraction t (0-1) of its length, and "after" part not yet reached
  // Two ways to do that cut, by the propagationStyle setting:
  //  - splitWirePathAtSegment ("discrete"): cut at the last corner the signal has reached
  //    i.e., only turn on a segment once the signal has crossed it entirely
  //  - splitWirePath ("continuous"): cut at the exact fraction `t`,
  //    interpolating within whichever segment it falls in
  // Both return `{before, after}` sharing their cut point exactly
  function splitWirePathAtSegment(x1,y1,x2,y2,pts=[],t) {
    const EPS = 1e-6;
    const p=resolveWire(x1,y1,x2,y2,pts);
    let total=0; const lens=[];
    for (let i=1;i<p.length;i++){const dx=p[i].x-p[i-1].x,dy=p[i].y-p[i-1].y,l=Math.hypot(dx,dy);lens.push(l);total+=l;}
    const target=t*total;
    let reached=0, k=0;
    for (let i=0;i<lens.length;i++) {
      if (reached+lens[i] > target+EPS) break;
      reached += lens[i];
      k = i+1;
    }
    const toD = pp => pp.map((v,i)=>(i?'L ':'M ')+v.x+' '+v.y).join('');
    return { before: toD(p.slice(0,k+1)), after: toD(p.slice(k)) };
  }
  function splitWirePath(x1,y1,x2,y2,pts=[],t) {
    const p=resolveWire(x1,y1,x2,y2,pts);
    let total=0; const lens=[];
    for (let i=1;i<p.length;i++){const dx=p[i].x-p[i-1].x,dy=p[i].y-p[i-1].y,l=Math.hypot(dx,dy);lens.push(l);total+=l;}
    const toD = pp => pp.map((v,i)=>(i?'L ':'M ')+v.x+' '+v.y).join('');
    let d=t*total;
    const before=[p[0]];
    for (let i=0;i<lens.length;i++){
      if(d<=lens[i]||i===lens.length-1){
        const f=lens[i]>0?Math.min(1,Math.max(0,d/lens[i])):0;
        const split={x:p[i].x+(p[i+1].x-p[i].x)*f, y:p[i].y+(p[i+1].y-p[i].y)*f};
        before.push(split);
        return { before: toD(before), after: toD([split, ...p.slice(i+1)]) };
      }
      before.push(p[i+1]);
      d-=lens[i];
    }
    return { before: toD(p), after: toD([p[p.length-1]]) };
  }

  // Returns a list of the cumulative distances from the origin of a wire to each of its knots
  // Used to tell if a specific waypoint has been reached by a propagating signal
  function wireKnotDistances(x1,y1,x2,y2,pts=[]) {
    const knots = wireKnots(x1,y1,x2,y2,pts);
    const dists = [0];
    for (let i=1;i<knots.length;i++) {
      dists.push(dists[i-1] + Math.hypot(knots[i].x-knots[i-1].x, knots[i].y-knots[i-1].y));
    }
    return dists;
  }

  // Shortest (non axis-restricted) distance from point (px,py) to the segment (ax,ay)-(bx,by)
  // Used for wire-hover/click hit-testing
  function distToSeg(px,py,ax,ay,bx,by){
    const dx=bx-ax,dy=by-ay,l2=dx*dx+dy*dy;
    if(l2===0) return Math.hypot(px-ax,py-ay);
    const t=Math.max(0,Math.min(1,((px-ax)*dx+(py-ay)*dy)/l2));
    return Math.hypot(px-(ax+t*dx),py-(ay+t*dy));
  }

  // Returns a wire's full list of endpoints+waypoints in absolute canvas coordinates
  // Unrouted (i.e. before resolveWire's elbow-insertion)
  function wireSegmentPoints(wire, circuit) {
    const from = terminalCoords(wire.from, circuit);
    const to = terminalCoords(wire.to, circuit);
    return wireKnots(from.x,from.y,to.x,to.y,wire.points||[]);
  }

  const WIRE_REF_LEN = 80; // roughly one gate width — reference length for length-based speed

  // How long (ms) a wire of length `wireLen` takes to propagate a change per the current propagation mode
  // "component" mode: every wire takes exactly `delayMs` to propagate
  // "length" mode (default): delay scales with wire length, at delayMs per WIRE_REF_LEN pixels
  function wireDelayForLength(wireLen, delayMs) {
    if (state.widgetState.propagationMode === 'component') return delayMs;
    return (wireLen / WIRE_REF_LEN) * delayMs;
  }

  // The point an up/down-facing component's SVG rotation transform (and
  // pinAbs below) pivots around — the shape's own geometric center,
  // snapped to the nearest grid intersection rather than used exactly as
  // drawn. Every pin already sits at a grid-aligned LOCAL position, and
  // rotating a grid-aligned offset from a grid-aligned pivot by exactly
  // 90 degrees always lands back on a grid-aligned offset (a pure
  // 90-degree turn only swaps/negates the two axes — it never scales
  // them) — so snapping the pivot is all a rotated pin needs to stay on
  // the grid too, without requiring the shape's own w/h to itself be a
  // 40px multiple (half of a plain 20px multiple can land on a 10px
  // half-grid offset once rotation swaps it onto the other axis, which is
  // exactly the gap this closes). Facing right/left never reads this at
  // all (see pinAbs and GateBody's own mirror transform), so nothing
  // about those changes.
  //
  // GATES' own rendering (GateBody's body/stub rotation, and the
  // selection outline's matching one) must pivot on this exact same
  // point, not the raw center — otherwise a pin circle (placed via
  // pinAbs) would visually detach from the end of its stub (part of the
  // rotated body) by up to 10px. Exported so both stay in sync with this
  // single definition instead of three hand-copied rounding formulas.
  const GRID = 20;
  function rotationCenter(vis) {
    return { cx: Math.round((vis.w/2)/GRID)*GRID, cy: Math.round((vis.h/2)/GRID)*GRID };
  }

  // Absolute canvas position of one pin (input or output, by index) of a component
  // Accounts for its facing: rotated about its own center for up/down, mirrored horizontally for left
  function pinAbs(comp,kind,idx){
    const vis=window.Modules.gates.visForComp(comp),p=kind==='in'?vis.inputs[idx]:vis.outputs[idx];
    const {cx,cy} = rotationCenter(vis);
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

  return {
    muxGeometry, splitGeometry, bitsRowWidth, inputOutputGeometry, constGeometry,
    BIT_CELL_W, BIT_GAP, BIT_PAD,
    projectOrthogonalPoint, isWireTerminal, terminalCoords, wireKnots, resolveWire,
    syncEndCorner, syncWireEndCorners, wirePath, sampleWire,
    splitWirePathAtSegment, splitWirePath, wireKnotDistances, distToSeg,
    wireSegmentPoints, wireDelayForLength, pinAbs, rotationCenter,
  };
});

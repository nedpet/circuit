/* ═══ ENGINE: interactive wire routing/editing ══════════════════════════════
   Branch/waypoint/segment editing logic layered on top of engine-geometry's
   pure coordinate math — hit-testing, branch-point insertion, endpoint and
   segment drags, and cascading deletes. Depends only on engine-geometry
   (no bit-level math, no live circuit state of its own — everything here
   takes `circuit` as a plain parameter). Split out of engine.js; see
   engine.js for how this composes back together with the other engine-*
   modules. */
defineModule('engine-routing', ['engine-geometry'], (geometry) => {
  'use strict';
  const { isWireTerminal, terminalCoords, wireKnots, resolveWire, wireSegmentPoints, projectOrthogonalPoint } = geometry;

  // Returns the closest point on a wire to (x,y), and which segment it falls on (by index into its knot list)
  // Used to decide where a new branch/waypoint should be inserted
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
  // unless that nearest point is already an existing knot (a prior waypoint or an endpoint)
  // Also registers the branchpoint as an explicit junction (unless, again, it already existed)
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
    const dup = [...circuit.junctions].some(j=>j.sourceWireId===wire.id && samePoint(j, pt));
    if (!dup) circuit.junctions.add({x: pt.x, y: pt.y, sourceWireId: wire.id});
    return pt;
  }

  // Removes any junctions that have been made branchless (by the deletion of some wire)
  // Can happen through a branch deletion, host wire deletion, or a branch being dragged into its own branchpoint 
  // Only removes junctions that the wire passes through in a "straight" way
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

  // Returns a single elbow corner for a wire between two points that don't already share an axis
  // Goes vertical-then-horizontal or horizontal-then-vertical depending on firstDir
  function routeManhattanPoints(from, to, firstDir) {
    if (from.x === to.x || from.y === to.y) return [];
    const corner = firstDir === 'v' ? {x:from.x, y:to.y} : {x:to.x, y:from.y};
    return [corner];
  }

  // Returns the furthest point from `a` towards `b` that's still covered by a
  // wire defined by `segs` (consecutive point pairs of some wire's resolved path)
  // Returns `a` itself if the move leaves it right away, `b` if the whole move runs along it
  // Used when branching to choose the best branchpoint
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

  // Creates a new branch, dragged off `wire`, returning {start, points}: 
  // the junction position and the branch's waypoint list measured from it
  // Returns null if the route never leaves the wire
  // Creates the junction at the point the branch actually leaves the wire
  function branchRouteFrom(wire, from, to, firstDir, circuit, snapToGrid) {
    const EPS = 1e-6;
    const route = [from, ...routeManhattanPoints(from, to, firstDir), to];
    const a = terminalCoords(wire.from, circuit), b = terminalCoords(wire.to, circuit);
    // The *resolved* path, so the wire as actually drawn is used (elbows included) rather than its raw knot list
    const path = resolveWire(a.x, a.y, b.x, b.y, wire.points || []);
    const segs = [];
    for (let i=1;i<path.length;i++) segs.push([path[i-1], path[i]]);

    let start = from, leg = 1;
    for (; leg < route.length; leg++) {
      start = overlapRunEnd(start, route[leg], segs);
      if (Math.abs(start.x-route[leg].x) > EPS || Math.abs(start.y-route[leg].y) > EPS) break;
    }
    if (leg >= route.length) return null; // every leg ran along the wire
    const points = route.slice(leg, route.length-1);
    if (!snapToGrid) return { start, points };

    let alongAxis = null;
    for (const [s,t] of segs) {
      const segHoriz = Math.abs(s.y-t.y) < EPS;
      const onSeg = segHoriz
        ? Math.abs(start.y-s.y) < EPS && start.x > Math.min(s.x,t.x)-EPS && start.x < Math.max(s.x,t.x)+EPS
        : Math.abs(start.x-s.x) < EPS && start.y > Math.min(s.y,t.y)-EPS && start.y < Math.max(s.y,t.y)+EPS;
      if (onSeg) { alongAxis = segHoriz ? 'x' : 'y'; break; }
    }
    if (!alongAxis) return { start, points };

    const original = start[alongAxis];
    const snapped = Math.round(original/SNAP_GRID)*SNAP_GRID;
    if (points.length && Math.abs(points[0][alongAxis]-original) < EPS) {
      points[0] = Object.assign({}, points[0], {[alongAxis]: snapped});
    }
    // Removes the accidental corner created when snapping in a straight branch
    if (points.length && Math.abs(points[0].x-to.x)<EPS && Math.abs(points[0].y-to.y)<EPS) {
      points.shift();
    }
    return { start: Object.assign({}, start, {[alongAxis]: snapped}), points };
  }

  // Computes the new path of a wire once its endpoint has been dragged
  // Dragging a wire's endpoint only ever changes the one segment at the dragged end
  // `d` captures the wire's original shape: 
  //  - `neighbor` is the fixed point just before this endpoint (the nearest existing waypoint or the other endpoint if no waypoints exist)
  //  - `axis` is which way ('h'/'v') the segment leading into this endpoint already ran
  //  - `basePoints` is every other point on the wire, left completely alone
  // Moving `newPos` along that same axis just slides the endpoint, extending/shortening the segment
  // Moving it off that axis appends exactly one corner point beyond `neighbor` (new segment)
  // Returns the wire's new waypoints, a new corner location (if needed), and whether the wire collapsed 
  function computeEndpointRoute(d, newPos) {
    const EPS = 1e-6;
    const aligned = d.axis==='h' ? Math.abs(newPos.y-d.neighbor.y)<EPS : Math.abs(newPos.x-d.neighbor.x)<EPS;
    if (aligned) {
      // If dragged all the way back onto the fixed point behind it, the final segment has shrunk to nothing
      // If that point was: 
      //  - one of the wire's waypoints, it's dropped and that point becomes the endpoint 
      //  - already a junction, the junction stays put, now doubling as the endpoint
      //  - not a waypoint, then it was the other endpoint, marked by collapsedToZero
      const collapsed = Math.abs(newPos.x-d.neighbor.x)<EPS && Math.abs(newPos.y-d.neighbor.y)<EPS;
      if (collapsed) {
        if (d.basePoints.length===0) return { points: [], corner: null, collapsedToZero: true };
        const points = d.side==='to' ? d.basePoints.slice(0,-1) : d.basePoints.slice(1);
        return { points, corner: null };
      }
      return { points: d.basePoints, corner: null };
    }
    const corner = d.axis==='h' ? {x:newPos.x, y:d.neighbor.y} : {x:d.neighbor.x, y:newPos.y};
    const points = d.side==='to' ? [...d.basePoints, corner] : [corner, ...d.basePoints];
    return { points, corner };
  }

  // Changes `wire`'s path after its endpoint has been dragged, based on the result of computeEndpointRoute
  // Registers a junction there if it doesn't exist 
  function finalizeEndpointRoute(wire, d, newPos, circuit) {
    const {points, corner, collapsedToZero} = computeEndpointRoute(d, newPos);
    if (collapsedToZero) {
      // Both ends now sit on the same point, so it is removed
      circuit.removeWire(wire.id);
      return true;
    }
    wire.points = points;
    if (corner) {
      const dup = [...circuit.junctions].some(j=>j.sourceWireId===wire.id && Math.abs(j.x-corner.x)<1e-6 && Math.abs(j.y-corner.y)<1e-6);
      if (!dup) circuit.junctions.add({x:corner.x, y:corner.y, sourceWireId:wire.id});
    }
    return false;
  }

  // Returns a snapshot of a wire before one of its segments is moved, including:
  // wireId, the segment-to-be-moved's index and axis ('h' or 'v'), all wire knots,
  // whether the wire's endpoints are anchored to component pins (fromPinned and toPinned),
  // and whether the segment's endpoints are anchored (startPinned and endPinned)
  // Returns null if segIndex is invalid
  // Used so changes aren't compounded each frame in a multi-frame move
  //
  // Segment's endpoints can be anchored by either some component or a junction that 
  // will still be in use by a branch after the move
  function segmentMoveSnapshot(wire, segIndex, circuit) {
    const from = terminalCoords(wire.from, circuit), to = terminalCoords(wire.to, circuit);
    const knots = wireKnots(from.x, from.y, to.x, to.y, wire.points || []);
    if (!knots[segIndex] || !knots[segIndex+1]) return null;
    const n = knots.length;
    const axis = Math.abs(knots[segIndex].y-knots[segIndex+1].y) < 1e-6 ? 'h' : 'v';
    const fromPinned = isWireTerminal(wire.from), toPinned = isWireTerminal(wire.to);
    const EPS = 1e-6;
    const same = (a,b) => Math.abs(a.x-b.x)<EPS && Math.abs(a.y-b.y)<EPS;
    const hasLiveBranchAt = p => [...circuit.wires.values()].some(w => w.id!==wire.id &&
      ((!isWireTerminal(w.from) && same(terminalCoords(w.from,circuit), p)) ||
       (!isWireTerminal(w.to)   && same(terminalCoords(w.to,circuit),   p))));
    const ownsLiveJunctionAt = p => {
      for (const j of circuit.junctions) {
        if (j.sourceWireId===wire.id && same(j, p)) return hasLiveBranchAt(p);
      }
      return false;
    };
    const pinnedAt = k => (k===0 && fromPinned) || (k===n-1 && toPinned) || ownsLiveJunctionAt(knots[k]);
    return {
      wireId: wire.id, segIndex, axis, knots,
      fromPinned, toPinned,
      startPinned: pinnedAt(segIndex),
      endPinned: pinnedAt(segIndex+1),
    };
  }

  // Builds and returns the new knot list of a wire after one of its segments has been moved
  // `d.knots` is the original set of knots, `d.segIndex` is the shifted segment's index
  // Adds `dx` or `dy` to each of the segment's endpoints, unless it is pinned, in which case
  // a new knot is placed at the original location and then moved
  // Also returns the segment's new index since it may have changed during the move
  function computeSegmentMove(d, dx, dy) {
    const knots = d.knots, n = knots.length;
    const moved = dx!==0 || dy!==0;
    const startK = d.segIndex, endK = d.segIndex+1;
    const newKnots = [];
    for (let i=0; i<startK; i++) newKnots.push({x:knots[i].x, y:knots[i].y});

    if (d.startPinned) {
      newKnots.push({x:knots[startK].x, y:knots[startK].y}); // the anchor itself, unmoved
      if (moved) newKnots.push({x:knots[startK].x+dx, y:knots[startK].y+dy}); // stub out to the dragged segment
    } else {
      newKnots.push({x:knots[startK].x+dx, y:knots[startK].y+dy});
    }
    const segIndex = newKnots.length-1; // the dragged segment always starts at whatever was just pushed last

    if (d.endPinned) {
      if (moved) newKnots.push({x:knots[endK].x+dx, y:knots[endK].y+dy}); // dragged segment's moved end
      newKnots.push({x:knots[endK].x, y:knots[endK].y}); // the anchor itself, unmoved
    } else {
      newKnots.push({x:knots[endK].x+dx, y:knots[endK].y+dy});
    }

    for (let i=endK+1; i<n; i++) newKnots.push({x:knots[i].x, y:knots[i].y});

    const m = newKnots.length;
    const from = d.fromPinned ? null : {x:newKnots[0].x, y:newKnots[0].y};
    const to = d.toPinned ? null : {x:newKnots[m-1].x, y:newKnots[m-1].y};
    const points = newKnots.slice(1, m-1);
    return {points, from, to, segIndex};
  }

  // Restricts dx, dy to what's actually possible within the circuit
  // Only changes dx, dy if the segment is the first segment of a branch,
  // and the requested dx, dy would move it invalidly according to clampAlongParentWire
  function clampSegmentMoveDelta(d, dx, dy, circuit) {
    if (dx===0 && dy===0) return {dx, dy};
    const n = d.knots.length;
    const ends = [
      {pos: d.knots[d.segIndex],   isAnchorEnd: d.segIndex===0 && !d.fromPinned},
      {pos: d.knots[d.segIndex+1], isAnchorEnd: d.segIndex+1===n-1 && !d.toPinned},
    ];
    for (const end of ends) {
      if (!end.isAnchorEnd) continue;
      let parentJ = null;
      for (const j of circuit.junctions) {
        if (j.sourceWireId===d.wireId) continue; // this wire is the SOURCE here, not anchored to it
        if (Math.abs(j.x-end.pos.x)<1e-6 && Math.abs(j.y-end.pos.y)<1e-6) { parentJ = j; break; }
      }
      if (!parentJ) continue;
      const parentWire = circuit.wires.get(parentJ.sourceWireId);
      if (!parentWire) continue;
      const target = {x: end.pos.x+dx, y: end.pos.y+dy};
      const finalPos = clampAlongParentWire(parentWire, end.pos, target, circuit, d.wireId);
      dx = finalPos.x - end.pos.x;
      dy = finalPos.y - end.pos.y;
    }
    return {dx, dy};
  }

  // Grid step wire geometry snaps to 
  const SNAP_GRID = 20;

  // Returns the closest valid position which a junction moved from `oldPos` towards `target` can go
  // `wire` is the parent wire and `movingWireId` is the branch actually being moved 
  // A position is valid when the junction does not sit on the parent wire's segment boundaries,
  // or on any other space another junction already occupies
  // The function steps back one unit (as per grid snapping) when a position is invalid
  function clampAlongParentWire(wire, oldPos, target, circuit, movingWireId) {
    const EPS = 1e-6;
    const same = (a,b) => Math.abs(a.x-b.x)<EPS && Math.abs(a.y-b.y)<EPS;
    const horiz = Math.abs(target.y-oldPos.y) < EPS;
    if (!horiz && Math.abs(target.x-oldPos.x) > EPS) return oldPos; // not an axis-aligned request
    const along = p => horiz ? p.x : p.y, off = p => horiz ? p.y : p.x;
    const mk = a => horiz ? {x:a, y:oldPos.y} : {x:oldPos.x, y:a};
    const delta = along(target) - along(oldPos);
    if (Math.abs(delta) < EPS) return oldPos;
    const sign = delta > 0 ? 1 : -1;

    const from = terminalCoords(wire.from, circuit), to = terminalCoords(wire.to, circuit);
    const knots = wireKnots(from.x, from.y, to.x, to.y, wire.points || []);
    const segs = [];
    for (let k=0; k<knots.length-1; k++) segs.push([knots[k], knots[k+1]]);
    const farProbe = mk(along(oldPos) + sign*1e9); // the run's true boundary in this direction
    const wall = overlapRunEnd(oldPos, farProbe, segs);
    const limit = along(wall) - sign*SNAP_GRID;

    const blocked = new Set();
    for (const j of circuit.junctions) {
      if (j.sourceWireId===wire.id && same(j, oldPos)) continue; // the one being moved
      if (Math.abs(off(j)-off(oldPos)) < EPS) blocked.add(along(j));
    }
    for (const w of circuit.wires.values()) {
      if (w.id===movingWireId) continue; // its own endpoint, not a collision
      for (const side of ['from','to']) {
        if (isWireTerminal(w[side])) continue;
        const p = terminalCoords(w[side], circuit);
        if (Math.abs(off(p)-off(oldPos)) < EPS) blocked.add(along(p));
      }
    }

    let a = along(target);
    if ((a-limit)*sign > EPS) a = limit;
    while ((a-along(oldPos))*sign > EPS && [...blocked].some(b => Math.abs(b-a)<EPS)) {
      a -= sign*SNAP_GRID;
    }
    if ((a-along(oldPos))*sign <= EPS) return oldPos;
    return mk(a);
  }

  // Drops the waypoint at `pos` on `wire` if it's collinear with its own neighbors 
  // and unneeded by anything (a junction, or another wire's own endpoint)
  // Run after a junction that used to sit at `pos` has already moved elsewhere
  function removeRedundantWaypoint(wire, pos, circuit) {
    const EPS = 1e-6;
    const same = (a,b) => Math.abs(a.x-b.x)<EPS && Math.abs(a.y-b.y)<EPS;
    const from = terminalCoords(wire.from, circuit), to = terminalCoords(wire.to, circuit);
    const knots = wireKnots(from.x, from.y, to.x, to.y, wire.points || []);
    const idx = knots.findIndex(k => same(k, pos));
    if (idx<=0 || idx>=knots.length-1) return; // not an interior waypoint at all
    const prev = knots[idx-1], cur = knots[idx], next = knots[idx+1];
    const straight = (prev.x===cur.x && cur.x===next.x) || (prev.y===cur.y && cur.y===next.y);
    if (!straight) return; // a real corner — still shapes the wire
    const stillNeeded = [...circuit.junctions].some(j => same(j, pos)) ||
      [...circuit.wires.values()].some(w => w.id!==wire.id &&
        ((!isWireTerminal(w.from) && same(terminalCoords(w.from,circuit), pos)) ||
         (!isWireTerminal(w.to)   && same(terminalCoords(w.to,circuit),   pos))));
    if (stillNeeded) return;
    wire.points = wire.points.filter((p,i) => i!==idx-1);
  }

  // Moves the junction `j` whenever a branch segment attached to `j` has been moved to `targetPos`
  // Stays within `parentWire`'s shape, as determined by clampAlongParentWire
  // If `j` is not in use by any other branches, then it deletes the old waypoint and moves `j` to the new location
  // If it is used, a new junction is created, and it and the associated waypoint are left untouched
  // Returns the new position of the junction
  function attachBranchToJunction(parentWire, j, targetPos, hasOtherReaders, circuit, branchWireId) {
    const EPS = 1e-6;
    const same = (a,b) => Math.abs(a.x-b.x)<EPS && Math.abs(a.y-b.y)<EPS;
    const oldPos = {x:j.x, y:j.y};
    const finalPos = clampAlongParentWire(parentWire, oldPos, targetPos, circuit, branchWireId);
    if (same(finalPos, oldPos)) return finalPos;
    if (!hasOtherReaders) {
      j.x = finalPos.x; j.y = finalPos.y;
      removeRedundantWaypoint(parentWire, oldPos, circuit);
    }
    insertBranchPoint(parentWire, finalPos.x, finalPos.y, circuit); // ensures a waypoint actually exists at finalPos
    return finalPos;
  }

  // Does some cleaning up after computeSegmentMove's result has been committed to `wire`
  // Cleans up any dead junctions that pruneDeadJunctions won't catch
  // Calls attachBranchToJunction to move any junctions to go with their branches that have been moved
  function finalizeSegmentMove(wire, d, dx, dy, circuit) {
    const EPS = 1e-6;
    const same = (a,b) => Math.abs(a.x-b.x)<EPS && Math.abs(a.y-b.y)<EPS;
    const n = d.knots.length;
    const ends = [
      {pos: d.knots[d.segIndex],   pinned: d.startPinned, side: d.segIndex===0     ? 'from' : null},
      {pos: d.knots[d.segIndex+1], pinned: d.endPinned,   side: d.segIndex+1===n-1 ? 'to'   : null},
    ];
    const moved = dx!==0 || dy!==0;
    for (const end of ends) {
      if (!end.pinned && moved) {
        const ownJ = [...circuit.junctions].find(j=>j.sourceWireId===wire.id && same(j, end.pos));
        if (ownJ) circuit.junctions.delete(ownJ);
      }
      if (end.pinned) continue;
      if (!end.side) continue; // an interior point — can't be a branch's own anchor
      const newPos = {x:end.pos.x+dx, y:end.pos.y+dy};
      const parentJ = [...circuit.junctions].find(j=>j.sourceWireId!==wire.id && same(j, end.pos));
      if (!parentJ) continue;
      const parentWire = circuit.wires.get(parentJ.sourceWireId);
      if (!parentWire) continue;
      const hasOtherReaders = [...circuit.wires.values()].some(w => w.id!==wire.id &&
        ((!isWireTerminal(w.from) && same(terminalCoords(w.from,circuit), end.pos)) ||
         (!isWireTerminal(w.to)   && same(terminalCoords(w.to,circuit),   end.pos))));
      const finalPos = attachBranchToJunction(parentWire, parentJ, newPos, hasOtherReaders, circuit, wire.id);
      wire[end.side] = {x:finalPos.x, y:finalPos.y};
    }
  }

  // Deletes `wire` and, recursively, every OTHER wire branching off of it
  // Collects the full set to remove before removing anything to prevent 
  // removing junctions still needed to delete other branches 
  function removeWireCascading(wireId, circuit) {
    const EPS = 1e-6;
    const same = (a,b) => Math.abs(a.x-b.x)<EPS && Math.abs(a.y-b.y)<EPS;
    const toDelete = [wireId];
    const seen = new Set(toDelete);
    for (let i=0; i<toDelete.length; i++) {
      const id = toDelete[i];
      const ownJunctions = [...circuit.junctions].filter(j=>j.sourceWireId===id);
      if (!ownJunctions.length) continue;
      for (const w of circuit.wires.values()) {
        if (seen.has(w.id)) continue;
        const wFrom = terminalCoords(w.from, circuit), wTo = terminalCoords(w.to, circuit);
        const isBranch = ownJunctions.some(j =>
          (!isWireTerminal(w.from) && same(wFrom, j)) || (!isWireTerminal(w.to) && same(wTo, j)));
        if (isBranch) { seen.add(w.id); toDelete.push(w.id); }
      }
    }
    for (const id of toDelete) circuit.removeWire(id);
  }

  // Deletes segment `segIndex` of `wire` and every segment after it 
  // The knot the deleted run starts from, knots[segIndex], becomes the wire's new free `to` endpoint
  // segIndex 0 has nothing "before" it to leave behind, so deleting that segment deletes the whole wire
  function truncateWireAtSegment(wire, segIndex, circuit) {
    if (segIndex === 0) { removeWireCascading(wire.id, circuit); return; }
    const EPS = 1e-6;
    const same = (a,b) => Math.abs(a.x-b.x)<EPS && Math.abs(a.y-b.y)<EPS;
    const from = terminalCoords(wire.from, circuit), to = terminalCoords(wire.to, circuit);
    const knots = wireKnots(from.x, from.y, to.x, to.y, wire.points || []);
    if (!knots[segIndex] || !knots[segIndex+1]) return;
    const cut = knots[segIndex];
    const dropped = [];
    for (const j of [...circuit.junctions]) {
      if (j.sourceWireId !== wire.id) continue;
      const idx = knots.findIndex(k => same(k, j));
      if (idx > segIndex) dropped.push(j);
    }
    wire.points = (wire.points || []).slice(0, segIndex-1);
    wire.to = {x: cut.x, y: cut.y};
    for (const j of dropped) {
      for (const w of [...circuit.wires.values()]) {
        if (w.id === wire.id) continue;
        const wFrom = terminalCoords(w.from, circuit), wTo = terminalCoords(w.to, circuit);
        const isBranch = (!isWireTerminal(w.from) && same(wFrom, j)) || (!isWireTerminal(w.to) && same(wTo, j));
        if (isBranch) removeWireCascading(w.id, circuit);
      }
      circuit.junctions.delete(j);
    }
    pruneDeadJunctions(circuit);
  }

  return {
    findNearestWirePoint, insertBranchPoint, pruneDeadJunctions, routeManhattanPoints,
    branchRouteFrom, computeEndpointRoute, finalizeEndpointRoute,
    segmentMoveSnapshot, computeSegmentMove, clampSegmentMoveDelta, clampAlongParentWire,
    removeRedundantWaypoint, attachBranchToJunction, finalizeSegmentMove,
    removeWireCascading, truncateWireAtSegment,
  };
});

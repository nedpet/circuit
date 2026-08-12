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
  // Commits computeEndpointRoute's result to `wire` and, only if it actually
  // produced a new corner, registers a junction there (skipping if an
  // equivalent one is already registered) so that corner is immediately
  // branchable — same reasoning as before, just now scoped to the one new
  // corner this drag may have added, since everything else about the wire is
  // left alone and any junctions elsewhere on it are therefore still valid.
  function finalizeEndpointRoute(wire, d, newPos, circuit) {
    const {points, corner, collapsedToZero} = computeEndpointRoute(d, newPos);
    if (collapsedToZero) {
      // Both ends now sit on the same point — nothing left to draw. Going
      // through circuit.removeWire (rather than just leaving an empty-points
      // wire in place) runs its junction cleanup too, so retracting a
      // branch back onto its own branchpoint takes that junction down with
      // it if it was the last branch there (case (c)).
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

  // Snapshot of one wire segment's shape, captured once at drag-start so a
  // multi-frame drag can recompute the whole move fresh every frame from a
  // fixed baseline instead of compounding small changes onto whatever the
  // previous frame already wrote — same reason computeEndpointRoute's `d`
  // freezes basePoints/neighbor rather than re-reading the wire live.
  // Returns null if segIndex doesn't land on a real segment.
  //
  // fromPinned/toPinned mark wire.from/wire.to specifically as anchored to
  // a component pin — used only to decide whether computeSegmentMove is
  // allowed to write a new value back into those two fields at all (never,
  // for a pin — it stays a component reference, not a plain point).
  //
  // startPinned/endPinned mark the segment's own two boundary knots —
  // whichever knots `segIndex` actually spans, which may or may not be
  // the wire's overall from/to — as unable to move with the drag at all.
  // Two different things can pin a knot this way: it's one of the pin
  // ends above, or the wire is itself the SOURCE of a junction sitting
  // exactly there that some OTHER wire still actually reads from. Moving
  // a live branchpoint would drag that other wire along with it exactly
  // the way dragging a component would tear its wire loose — a junction
  // splits what looks like one wire into two conceptually separate
  // segments meeting there, same as a component does, so it gets the
  // same treatment: the knot stays put and computeSegmentMove grows a
  // stub out to it instead of moving it.
  //
  // "Still actually reads from it" is the key qualifier — a junction
  // registration can outlive every branch that ever justified it (its
  // last branch retracted, or was deleted, without that specific corner
  // happening to be collinear at the time — see pruneDeadJunctions for
  // when it does and doesn't clean these up automatically), leaving a
  // plain-looking corner secretly still flagged as a junction with
  // nothing actually anchored to it. Pinning a knot for a branch that no
  // longer exists doesn't protect anything — it just froze an ordinary
  // corner in place and left a phantom stub behind on every drag, which
  // is indistinguishable from a genuine leftover waypoint bug to anyone
  // looking at the result. So this checks for an actual, live branch at
  // that position, not just a registry entry — same "hasBranch" test
  // pruneDeadJunctions itself uses to decide whether a junction still
  // matters.
  //
  // A branch's own free end sitting on ANOTHER wire's junction is a
  // different kind of anchoring — not owned by this wire, so it doesn't
  // pin anything here — and is handled separately, by dragging the
  // junction along within its parent's own extent instead (see
  // clampSegmentMoveDelta / finalizeSegmentMove).
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

  // Computes wire's new points (and, for whichever end is free, its new
  // from/to) for segment `d.segIndex` shifted by (dx,dy) from its ORIGINAL
  // (drag-start) position in `d.knots` — always relative to that frozen
  // baseline, never to the wire's current, possibly-already-moved shape,
  // so it's safe to call every frame of a live drag with the same
  // growing-from-zero delta and get a correct, non-compounding result
  // every time, exactly like computeEndpointRoute.
  //
  // A knot that startPinned/endPinned marks as anchored — either it's the
  // wire's own pin-attached endpoint, or the wire is the source of a
  // junction sitting exactly there — can't move; instead a brand-new
  // point is added at the shifted position once there's an actual
  // (dx,dy) to add it at, growing the wire a perpendicular "stub" out to
  // it and leaving the anchored knot (and everything on its far side)
  // untouched. This is the ONLY thing that moves for this drag — every
  // other knot keeps its exact original position, so "moving a segment"
  // never reaches past its own two ends, into whatever's on the other
  // side of a pin or a branchpoint, exactly the way it already couldn't
  // reach into a neighboring component. Skipped entirely at zero delta
  // rather than unconditionally, so merely selecting an anchored segment
  // (no real drag yet) doesn't leave a redundant zero-length stub behind.
  // A free knot — an interior waypoint, a dangling (unattached) wire end,
  // or a branch's own end anchored to ANOTHER wire's junction (see
  // clampSegmentMoveDelta / finalizeSegmentMove; that's a different kind
  // of anchoring, not one this wire owns, so it isn't pinned here) — just
  // shifts in place; `from`/`to` come back non-null only for whichever
  // end is both the wire's overall terminal AND not itself a component
  // pin.
  //
  // A stub grown at the segment's start shifts its own index up by one —
  // it's now one knot further into the (longer) knot list — so the
  // segment this same drag should keep tracking is `segIndex`, returned
  // fresh each call rather than the caller having to re-derive it. Comes
  // back equal to `d.segIndex` whenever no stub grew there, so
  // re-asserting it every frame (e.g. to keep a selection in sync) is
  // always safe, even before any stub exists.
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

  // Reduces a segment drag's raw, requested (dx,dy) to whatever a
  // branch's own anchor — if this segment touches one — can actually
  // take, per clampAlongParentWire, so the WHOLE segment (both its
  // knots) ends up moving by the SAME, consistent amount. Meant to run
  // *before* computeSegmentMove, not after: computeSegmentMove has no
  // way to only shift one of a segment's two knots part-way — both knots
  // always move by exactly the (dx,dy) it's given — so clamping needs to
  // happen to the delta itself, upfront, not patched onto one knot
  // afterward once the segment's already been drawn with the other one
  // full-length. (An earlier version tried the latter, in
  // finalizeSegmentMove, by overwriting just the anchor's own endpoint
  // after the fact — but computeSegmentMove had already moved the
  // segment's OTHER knot the full, unclamped distance, so the branch
  // still reached exactly as far as before, just with a diagonal kink
  // where the anchor snapped back.)
  //
  // A no-op — returns (dx,dy) unchanged — whenever neither of the
  // segment's two knots is a branch anchored to a DIFFERENT wire's
  // junction (most segments, most of the time).
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

  // Grid step wire geometry snaps to — mirrors the widget's own GRID
  // constant. Used below purely as the margin kept clear of a parent
  // wire's own boundary and of anything else along it, not for snapping
  // itself (the widget already snaps whatever target it asks for).
  const SNAP_GRID = 20;

  // Where a junction currently at `oldPos` on `wire` can move to, pulled
  // toward `target` along a straight line — used when the branch reading
  // from it moves (see attachBranchToJunction). `wire` itself never
  // budges — only the branch's own end does — so this can land on an
  // INTERIOR point of `wire`, not just its from/to.
  //
  // Deliberately never extends `wire` — the result always stays within
  // its EXISTING geometry, on the same straight run `oldPos` is already
  // on. Two things it also always keeps clear of, stepping back one grid
  // unit at a time until it does:
  //  - the run's own boundary in that direction (wire's own endpoint, or
  //    a genuine corner where it bends) — the junction never reaches all
  //    the way out to it, even if `target` asks for exactly that point;
  //  - any position along the same line that another junction, or
  //    another wire's own free endpoint, already occupies — landing
  //    exactly on top of one of those would conflate the two.
  // If there's no room to satisfy both (`oldPos` is already right up
  // against one), the junction just stays put. A junction sitting
  // exactly on a component pin never moves either, full stop, same
  // reasoning as everywhere else a wire meets a component — walking
  // outward from a pin has nowhere further to go anyway, so this falls
  // out of the general case rather than needing its own check.
  //
  // `movingWireId` is the id of the branch being dragged (NOT `wire`,
  // which is its parent) — excluded from the "another wire's free
  // endpoint" check below for the same reason `wire.id` is already
  // excluded from the junction one: the branch's own anchor is exactly
  // the point being moved, not something it could ever "collide" with.
  // Omitting this exclusion doesn't just misfire occasionally — the
  // branch's own endpoint is on this line on *every* call, so every call
  // saw a "collision" and stepped back from it, and since the position
  // it stepped back from was wherever the branch happened to be sitting
  // from the previous frame rather than anything fixed, the two
  // alternated: full move, see the branch's now-updated position as
  // blocking the next one, step back, see THAT position as clear again
  // next frame, move the full distance again — back and forth every
  // frame rather than settling anywhere.
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
    // The run's true boundary in this direction, independent of `target`
    // — probed far past anything realistic so overlapRunEnd's own
    // "never run past the requested point" clamp can't mistake some
    // ordinary point along the way for the wall itself.
    const farProbe = mk(along(oldPos) + sign*1e9);
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

  // Attaches branch-point junction `j` (on `parentWire`) to wherever the
  // branch reading from it drags toward `targetPos`, staying within
  // parentWire's own existing shape the whole time — never extending it,
  // never reaching its boundary or another junction/endpoint along it,
  // never merging the two into one wire — see clampAlongParentWire for
  // exactly what that rules out and why.
  //
  // If `j` is the only thing anchored there, it relocates in place — the
  // old waypoint it sat on is dropped once it's safe to
  // (removeRedundantWaypoint) and `j` itself moves. If other wires still
  // read from `j`, moving it would disconnect THEM, so it — and its
  // waypoint — are left exactly where they are, and a brand new junction
  // is split off on parentWire at the reached position for just this
  // branch.
  //
  // Returns the position actually reached, which the caller commits back
  // to the branch's own endpoint — it may fall short of targetPos, and
  // the branch must agree with wherever the junction actually ended up,
  // not where it was asked to go, or the two snap apart again.
  //
  // `branchWireId` is the branch's own wire id — passed through to
  // clampAlongParentWire purely so it can exclude the branch's own
  // (about-to-be-overwritten) endpoint from its "clear of other wires'
  // endpoints" check; see that function's comment for why skipping this
  // isn't optional.
  function attachBranchToJunction(parentWire, j, targetPos, hasOtherReaders, circuit, branchWireId) {
    const EPS = 1e-6;
    const same = (a,b) => Math.abs(a.x-b.x)<EPS && Math.abs(a.y-b.y)<EPS;
    const oldPos = {x:j.x, y:j.y};
    const finalPos = clampAlongParentWire(parentWire, oldPos, targetPos, circuit, branchWireId);
    if (same(finalPos, oldPos)) return finalPos;
    if (!hasOtherReaders) {
      // Move `j` itself first — insertBranchPoint below only cares about
      // the waypoint at this point, and its own junction-dedup check now
      // correctly finds `j` already sitting at finalPos instead of
      // registering a redundant second one there.
      j.x = finalPos.x; j.y = finalPos.y;
      removeRedundantWaypoint(parentWire, oldPos, circuit);
    }
    // Ensures a waypoint actually exists at finalPos — without this the
    // junction would be a registry entry with nothing to show or select
    // on parentWire's own path. In the shared case `j` never moved, so
    // this registers a genuinely separate, new junction there instead.
    insertBranchPoint(parentWire, finalPos.x, finalPos.y, circuit);
    return finalPos;
  }

  // Runs once, at drop, after computeSegmentMove's result has already been
  // committed to `wire` — carries along the one kind of anchoring
  // computeSegmentMove can't grow a stub for on its own: `wire` being a
  // branch itself, anchored to a junction on some OTHER wire at this
  // segment's endpoint. That junction is dragged toward the same move
  // instead (attachBranchToJunction), but only ever within the parent's
  // own existing shape — never past it — and `wire`'s own endpoint is
  // snapped to wherever it actually landed, in case that fell short of
  // the full move.
  //
  // Skips any end startPinned/endPinned already marked as anchored —
  // computeSegmentMove left it exactly where it was and grew a stub
  // instead, whether that anchoring was a component pin or a junction
  // `wire` itself is the SOURCE of, so there's nothing left to carry: a
  // branchpoint `wire` owns never moves out from under the OTHER wires
  // reading from it in the first place, same as dragging a segment can
  // never reach into whatever's on the far side of a component. Nor does
  // the remaining case apply to an end that isn't actually one of
  // `wire`'s own from/to — an interior waypoint can't be the free end of
  // a branch reading from someone else's junction, since a branch is
  // always anchored at its own from or to.
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
      // A knot that moved away from a junction this wire owns leaves that
      // junction's registration behind at the old, now off-geometry
      // position — orphaned rather than cleaned up, since
      // pruneDeadJunctions only ever sweeps a junction still sitting
      // somewhere on its source wire's own path. It could only have moved
      // here because segmentMoveSnapshot already confirmed no branch
      // reads from it (a live one would have pinned it — see there), so
      // there's nothing left this registration is doing; drop it now
      // rather than leaving a phantom entry for some later drag to trip
      // over again.
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

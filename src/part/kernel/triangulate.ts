/**
 * MinimalCAD Web
 * part/kernel/triangulate.ts
 *
 * Polygon-with-holes triangulation (our own; no library). Same calling
 * convention as the well-known earcut: `flat` is [x0,y0,x1,y1,...] with
 * the outer ring first and each hole starting at the index (in points, not
 * numbers) listed in `holeIndices`; returns triangles as point indices.
 *
 * Method: bridge every hole into the outer ring (rightmost hole vertex to a
 * mutually visible ring vertex, holes processed right-to-left), then ear-
 * clip the resulting single ring. O(n^2) -- fine for sketch profiles
 * (hundreds of points), and simple enough to trust.
 */

interface P {
  x: number;
  y: number;
  i: number; // original point index
}

function area(ring: readonly P[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j]!.x - ring[i]!.x) * (ring[i]!.y + ring[j]!.y);
  }
  return a / 2; // > 0 for counter-clockwise (Y-up)
}

const cross = (a: P, b: P, c: P): number => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

function pointInTriangle(a: P, b: P, c: P, p: P): boolean {
  const d1 = cross(a, b, p);
  const d2 = cross(b, c, p);
  const d3 = cross(c, a, p);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

const same = (a: P, b: P): boolean => a.x === b.x && a.y === b.y;

/** Index in `ring` of a vertex visible from hole vertex `m` (m is the
 *  hole's rightmost point): David Eberly's classic bridge search. */
function findBridge(ring: readonly P[], m: P): number {
  // Cast a ray from m towards +x; find the closest edge crossing.
  let bestX = Infinity;
  let edge = -1;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    // Only an edge the ray reaches from INSIDE can be bridged to: the ring
    // runs clockwise, so that is an edge going down. (An earlier hole's
    // bridge is two coincident edges, one each way -- taking the upward one
    // joins the wrong side of that slit and the fill overlaps itself. It
    // happens whenever two holes are level with each other's right edge,
    // e.g. one directly above the other.)
    if (a.y > b.y && a.y >= m.y && b.y <= m.y) {
      const x = a.x + ((m.y - a.y) * (b.x - a.x)) / (b.y - a.y);
      if (x >= m.x && x < bestX) {
        bestX = x;
        edge = i;
      }
    }
  }
  if (edge === -1) {
    // Degenerate: fall back to the nearest ring vertex.
    let best = 0;
    let bestD = Infinity;
    ring.forEach((p, i) => {
      const d = (p.x - m.x) ** 2 + (p.y - m.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }
  const a = ring[edge]!;
  const b = ring[(edge + 1) % ring.length]!;
  let candidate = a.x > b.x ? edge : (edge + 1) % ring.length;
  const hit: P = { x: bestX, y: m.y, i: -1 };
  const c = ring[candidate]!;
  if (c.x === hit.x && c.y === hit.y) return candidate;
  // Any ring vertex inside triangle (m, hit, c) blocks the view; pick the
  // one with the smallest angle to the ray instead.
  let bestAngle = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!;
    // Another copy of the candidate itself (a corner earlier holes were
    // bridged to appears once per bridge) is not "in the way" -- and taking
    // it instead would join this hole on the wrong side of that bridge.
    if (i === candidate || p.x < m.x || same(p, c)) continue;
    if (!pointInTriangle(m, hit, c, p)) continue;
    const angle = Math.abs(Math.atan2(p.y - m.y, p.x - m.x));
    if (angle < bestAngle) {
      bestAngle = angle;
      candidate = i;
    }
  }
  return candidate;
}

function isEar(ring: readonly P[], prev: number, cur: number, next: number, ccw: boolean): boolean {
  const a = ring[prev]!;
  const b = ring[cur]!;
  const c = ring[next]!;
  const turn = cross(a, b, c);
  if (ccw ? turn <= 0 : turn >= 0) return false; // reflex or flat
  for (let i = 0; i < ring.length; i++) {
    if (i === prev || i === cur || i === next) continue;
    const p = ring[i]!;
    // Bridge duplicates share positions with triangle corners: ignore them.
    if (same(p, a) || same(p, b) || same(p, c)) continue;
    // Quick reject by bounding box before the exact test.
    if (p.x < Math.min(a.x, b.x, c.x) || p.x > Math.max(a.x, b.x, c.x)) continue;
    if (p.y < Math.min(a.y, b.y, c.y) || p.y > Math.max(a.y, b.y, c.y)) continue;
    if (pointInTriangle(a, b, c, p)) return false;
  }
  return true;
}

export function triangulate(flat: readonly number[], holeIndices: readonly number[] = []): number[] {
  const n = flat.length / 2;
  const pts: P[] = [];
  for (let i = 0; i < n; i++) pts.push({ x: flat[i * 2]!, y: flat[i * 2 + 1]!, i });
  const starts = [0, ...holeIndices, n];
  let ring = pts.slice(starts[0], starts[1]);
  if (ring.length < 3) return [];
  // Outer ring clockwise, holes counter-clockwise (bridging needs opposite windings).
  if (area(ring) > 0) ring.reverse();
  const holes: P[][] = [];
  for (let h = 1; h + 1 < starts.length; h++) {
    const hole = pts.slice(starts[h], starts[h + 1]);
    if (hole.length < 3) continue;
    if (area(hole) < 0) hole.reverse();
    holes.push(hole);
  }
  // Bridge holes, rightmost first.
  const rightmost = (hole: P[]): number => hole.reduce((best, p, i) => (p.x > hole[best]!.x ? i : best), 0);
  holes.sort((a, b) => b[rightmost(b)]!.x - a[rightmost(a)]!.x);
  for (const hole of holes) {
    const mi = rightmost(hole);
    const m = hole[mi]!;
    const bi = findBridge(ring, m);
    const bridgeTo = ring[bi]!;
    const holeLoop = [...hole.slice(mi), ...hole.slice(0, mi), m];
    ring = [...ring.slice(0, bi + 1), ...holeLoop, bridgeTo, ...ring.slice(bi + 1)];
  }

  // Ear clipping.
  const out: number[] = [];
  const ccw = area(ring) > 0;
  let guard = ring.length * ring.length + 10;
  // Resume scanning where the last ear was cut instead of from the start:
  // keeps typical profiles ~O(n^2) rather than O(n^3).
  let cursor = 0;
  while (ring.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let k = 0; k < ring.length; k++) {
      const cur = (cursor + k) % ring.length;
      const prev = (cur + ring.length - 1) % ring.length;
      const next = (cur + 1) % ring.length;
      if (isEar(ring, prev, cur, next, ccw)) {
        out.push(ring[prev]!.i, ring[cur]!.i, ring[next]!.i);
        ring.splice(cur, 1);
        cursor = Math.max(0, cur - 1);
        clipped = true;
        break;
      }
    }
    if (!clipped) {
      // Numerically stuck (e.g. collinear leftovers): drop a flat vertex, or
      // clip any convex one, rather than looping forever.
      const flatIdx = ring.findIndex((_, cur) => {
        const prev = ring[(cur + ring.length - 1) % ring.length]!;
        const next = ring[(cur + 1) % ring.length]!;
        return Math.abs(cross(prev, ring[cur]!, next)) < 1e-12;
      });
      if (flatIdx >= 0) {
        ring.splice(flatIdx, 1);
        continue;
      }
      const prev = ring[ring.length - 1]!;
      out.push(prev.i, ring[0]!.i, ring[1]!.i);
      ring.splice(0, 1);
    }
  }
  if (ring.length === 3 && Math.abs(cross(ring[0]!, ring[1]!, ring[2]!)) > 0) {
    out.push(ring[0]!.i, ring[1]!.i, ring[2]!.i);
  }
  return out;
}

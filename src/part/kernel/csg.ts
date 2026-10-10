/**
 * MinimalCAD Web
 * part/kernel/csg.ts
 *
 * Solid booleans (union / subtract / intersect) on closed polygon meshes,
 * with a BSP tree -- the classic constructive-solid-geometry method (as in
 * Evan Wallace's csg.js), written fresh in TypeScript, double precision,
 * no library.
 *
 * Every polygon carries the `faceId` of the analytic face it came from, and
 * splitting preserves it, so the exact surface (plane/cylinder) of every
 * output polygon is known -- brep.ts rebuilds exact edges from that.
 *
 * Tree building and traversal are iterative (explicit stacks), so large or
 * unbalanced trees can't overflow the call stack.
 */

import type { Vec3 } from "../vec3";
import { cross, dot, normalize, sub } from "../vec3";

export interface Polygon {
  vertices: Vec3[];
  normal: Vec3;
  /** Plane offset: dot(normal, p) = w for points on the polygon's plane. */
  w: number;
  faceId: number;
}

const COPLANAR = 0;
const FRONT = 1;
const BACK = 2;
const SPANNING = 3;

/** Plane-classification tolerance; set per operation from the model size. */
let EPS = 1e-6;

export function makePolygon(vertices: Vec3[], faceId: number): Polygon | null {
  if (vertices.length < 3) return null;
  // Newell's method: robust normal even for slightly non-planar input.
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i]!;
    const b = vertices[(i + 1) % vertices.length]!;
    nx += (a.y - b.y) * (a.z + b.z);
    ny += (a.z - b.z) * (a.x + b.x);
    nz += (a.x - b.x) * (a.y + b.y);
  }
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-18) return null;
  const normal = { x: nx / len, y: ny / len, z: nz / len };
  return { vertices, normal, w: dot(normal, vertices[0]!), faceId };
}

function flip(p: Polygon): Polygon {
  return {
    vertices: p.vertices.slice().reverse(),
    normal: { x: -p.normal.x, y: -p.normal.y, z: -p.normal.z },
    w: -p.w,
    faceId: p.faceId,
  };
}

function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

interface Plane {
  normal: Vec3;
  w: number;
}

/** Splits `poly` by `plane` into the four output lists. */
function splitPolygon(
  plane: Plane,
  poly: Polygon,
  coplanarFront: Polygon[],
  coplanarBack: Polygon[],
  front: Polygon[],
  back: Polygon[],
): void {
  // A polygon always lies ON its own plane (and on the exact opposite one).
  // Measured per vertex, a sliver's shaky normal can make it "span" its own
  // plane: it would be split by itself, the pieces (same plane) handed down
  // to a child that picks that plane again -- forever, until memory runs out.
  const pn = poly.normal;
  if (pn.x === plane.normal.x && pn.y === plane.normal.y && pn.z === plane.normal.z && poly.w === plane.w) {
    coplanarFront.push(poly);
    return;
  }
  if (pn.x === -plane.normal.x && pn.y === -plane.normal.y && pn.z === -plane.normal.z && poly.w === -plane.w) {
    coplanarBack.push(poly);
    return;
  }
  const { x: nx, y: ny, z: nz } = plane.normal;
  const verts = poly.vertices;
  const n = verts.length;
  let polyType = 0;
  for (let i = 0; i < n; i++) {
    const v = verts[i]!;
    const t = nx * v.x + ny * v.y + nz * v.z - plane.w;
    polyType |= t < -EPS ? BACK : t > EPS ? FRONT : COPLANAR;
  }
  switch (polyType) {
    case COPLANAR:
      (dot(plane.normal, poly.normal) > 0 ? coplanarFront : coplanarBack).push(poly);
      return;
    case FRONT:
      front.push(poly);
      return;
    case BACK:
      back.push(poly);
      return;
  }
  // SPANNING
  const types: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = verts[i]!;
    const t = nx * v.x + ny * v.y + nz * v.z - plane.w;
    types.push(t < -EPS ? BACK : t > EPS ? FRONT : COPLANAR);
  }
  const f: Vec3[] = [];
  const b: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ti = types[i]!;
    const tj = types[j]!;
    const vi = verts[i]!;
    const vj = verts[j]!;
    if (ti !== BACK) f.push(vi);
    if (ti !== FRONT) b.push(vi);
    if ((ti | tj) === SPANNING) {
      const t = (plane.w - dot(plane.normal, vi)) / dot(plane.normal, sub(vj, vi));
      const v = lerp(vi, vj, t);
      f.push(v);
      b.push(v);
    }
  }
  if (f.length >= 3) front.push({ ...poly, vertices: f });
  if (b.length >= 3) back.push({ ...poly, vertices: b });
}

class BspNode {
  plane: Plane | null = null;
  front: BspNode | null = null;
  back: BspNode | null = null;
  polygons: Polygon[] = [];

  constructor(polygons?: Polygon[]) {
    if (polygons !== undefined) this.build(polygons);
  }

  /** Adds polygons to the tree (iteratively). */
  build(polygons: Polygon[]): void {
    const stack: [BspNode, Polygon[]][] = [[this, polygons]];
    while (stack.length > 0) {
      const [node, polys] = stack.pop()!;
      if (polys.length === 0) continue;
      if (node.plane === null) {
        const pivot = polys[polys.length >> 1]!;
        node.plane = { normal: pivot.normal, w: pivot.w };
      }
      const front: Polygon[] = [];
      const back: Polygon[] = [];
      for (const p of polys) splitPolygon(node.plane, p, node.polygons, node.polygons, front, back);
      if (front.length > 0) {
        node.front ??= new BspNode();
        stack.push([node.front, front]);
      }
      if (back.length > 0) {
        node.back ??= new BspNode();
        stack.push([node.back, back]);
      }
    }
  }

  /** Solid <-> empty space. */
  invert(): void {
    const stack: BspNode[] = [this];
    while (stack.length > 0) {
      const node = stack.pop()!;
      node.polygons = node.polygons.map(flip);
      if (node.plane !== null) node.plane = { normal: { x: -node.plane.normal.x, y: -node.plane.normal.y, z: -node.plane.normal.z }, w: -node.plane.w };
      const tmp = node.front;
      node.front = node.back;
      node.back = tmp;
      if (node.front !== null) stack.push(node.front);
      if (node.back !== null) stack.push(node.back);
    }
  }

  /**
   * Removes the parts of `polygons` inside this tree's solid. A polygon the
   * tree cut up on the way but kept every piece of comes back whole: only
   * what really loses a part is left in pieces (far fewer fragments for
   * whatever turns the result back into a body).
   */
  clipPolygons(polygons: Polygon[]): Polygon[] {
    const pieces: Polygon[] = [];
    const pieceOf: number[] = [];
    const lost = new Uint8Array(polygons.length);
    const stack: [BspNode, Polygon[], number[]][] = [[this, polygons, polygons.map((_, i) => i)]];
    while (stack.length > 0) {
      const [node, polys, origin] = stack.pop()!;
      if (node.plane === null) {
        for (let i = 0; i < polys.length; i++) {
          pieces.push(polys[i]!);
          pieceOf.push(origin[i]!);
        }
        continue;
      }
      const front: Polygon[] = [];
      const back: Polygon[] = [];
      const frontOf: number[] = [];
      const backOf: number[] = [];
      for (let i = 0; i < polys.length; i++) {
        splitPolygon(node.plane, polys[i]!, front, back, front, back);
        while (frontOf.length < front.length) frontOf.push(origin[i]!);
        while (backOf.length < back.length) backOf.push(origin[i]!);
      }
      if (node.front !== null) stack.push([node.front, front, frontOf]);
      else {
        for (let i = 0; i < front.length; i++) {
          pieces.push(front[i]!);
          pieceOf.push(frontOf[i]!);
        }
      }
      if (node.back !== null) stack.push([node.back, back, backOf]);
      // No back node: back polygons are inside the solid -- dropped.
      else for (const o of backOf) lost[o] = 1;
    }
    const out: Polygon[] = [];
    const whole = new Uint8Array(polygons.length);
    for (let i = 0; i < pieces.length; i++) {
      const o = pieceOf[i]!;
      if (lost[o] === 1) out.push(pieces[i]!);
      else if (whole[o] === 0) {
        whole[o] = 1;
        out.push(polygons[o]!);
      }
    }
    return out;
  }

  /** Clips this tree's polygons against `other`. */
  clipTo(other: BspNode): void {
    const stack: BspNode[] = [this];
    while (stack.length > 0) {
      const node = stack.pop()!;
      node.polygons = other.clipPolygons(node.polygons);
      if (node.front !== null) stack.push(node.front);
      if (node.back !== null) stack.push(node.back);
    }
  }

  allPolygons(): Polygon[] {
    const out: Polygon[] = [];
    const stack: BspNode[] = [this];
    while (stack.length > 0) {
      const node = stack.pop()!;
      out.push(...node.polygons);
      if (node.front !== null) stack.push(node.front);
      if (node.back !== null) stack.push(node.back);
    }
    return out;
  }
}

function sizeOf(polys: readonly Polygon[]): number {
  let min = { x: Infinity, y: Infinity, z: Infinity };
  let max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const p of polys) {
    for (const v of p.vertices) {
      min = { x: Math.min(min.x, v.x), y: Math.min(min.y, v.y), z: Math.min(min.z, v.z) };
      max = { x: Math.max(max.x, v.x), y: Math.max(max.y, v.y), z: Math.max(max.z, v.z) };
    }
  }
  return Math.max(1, max.x - min.x, max.y - min.y, max.z - min.z);
}

function withEps<T>(a: readonly Polygon[], b: readonly Polygon[], fn: () => T): T {
  const saved = EPS;
  EPS = 1e-9 * Math.max(sizeOf(a), sizeOf(b)) + 1e-9;
  try {
    return fn();
  } finally {
    EPS = saved;
  }
}

/** Axis-aligned box of some polygons, grown by `pad`. */
function boxOf(polys: readonly Polygon[], pad: number): { min: Vec3; max: Vec3 } {
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const p of polys) {
    for (const v of p.vertices) {
      min.x = Math.min(min.x, v.x);
      min.y = Math.min(min.y, v.y);
      min.z = Math.min(min.z, v.z);
      max.x = Math.max(max.x, v.x);
      max.y = Math.max(max.y, v.y);
      max.z = Math.max(max.z, v.z);
    }
  }
  return { min: { x: min.x - pad, y: min.y - pad, z: min.z - pad }, max: { x: max.x + pad, y: max.y + pad, z: max.z + pad } };
}

/** Splits `polys` into those touching `box` and those clear of it. */
function nearFar(polys: readonly Polygon[], box: { min: Vec3; max: Vec3 }): [Polygon[], Polygon[]] {
  const near: Polygon[] = [];
  const far: Polygon[] = [];
  for (const p of polys) {
    let lo = { x: Infinity, y: Infinity, z: Infinity };
    let hi = { x: -Infinity, y: -Infinity, z: -Infinity };
    for (const v of p.vertices) {
      lo = { x: Math.min(lo.x, v.x), y: Math.min(lo.y, v.y), z: Math.min(lo.z, v.z) };
      hi = { x: Math.max(hi.x, v.x), y: Math.max(hi.y, v.y), z: Math.max(hi.z, v.z) };
    }
    const clear =
      hi.x < box.min.x || lo.x > box.max.x || hi.y < box.min.y || lo.y > box.max.y || hi.z < box.min.z || lo.z > box.max.z;
    (clear ? far : near).push(p);
  }
  return [near, far];
}

/**
 * The parts of `polys` inside `box`: what a classifying tree is built from.
 * A tree made of a solid's whole surface inside a box tells inside from
 * outside correctly anywhere in that box -- as long as every piece really
 * lies in it (a long triangle only passing by would label space it never
 * touches), hence the cut. Null if the solid has no surface in the box.
 */
function insideBox(polys: readonly Polygon[], box: { min: Vec3; max: Vec3 }): Polygon[] | null {
  const planes: Plane[] = [
    { normal: { x: 1, y: 0, z: 0 }, w: box.max.x },
    { normal: { x: -1, y: 0, z: 0 }, w: -box.min.x },
    { normal: { x: 0, y: 1, z: 0 }, w: box.max.y },
    { normal: { x: 0, y: -1, z: 0 }, w: -box.min.y },
    { normal: { x: 0, y: 0, z: 1 }, w: box.max.z },
    { normal: { x: 0, y: 0, z: -1 }, w: -box.min.z },
  ];
  let inside = polys.slice();
  for (const plane of planes) {
    const kept: Polygon[] = [];
    const dropped: Polygon[] = [];
    for (const p of inside) splitPolygon(plane, p, kept, kept, dropped, kept);
    inside = kept;
    if (inside.length === 0) return null;
  }
  return inside;
}

/*
 * union / subtract: the csg.js sequences, but each solid's ORIGINAL polygons
 * are clipped through the other's tree (the trees only classify), instead
 * of first being chopped up by their own tree and re-inserted -- and
 * polygons clear of the other solid's box skip clipping entirely (they
 * can't be inside it). Same result, far fewer fragments: a revolved ring
 * against a part went from ~43k output polygons to a small fraction.
 */

export function union(a: Polygon[], b: Polygon[]): Polygon[] {
  return withEps(a, b, () => {
    const [aNear, aFar] = nearFar(a, boxOf(b, EPS * 10));
    const [bNear, bFar] = nearFar(b, boxOf(a, EPS * 10));
    // Each tree is built from its solid's surface inside the other's box
    // only: that is where every polygon it has to classify lies.
    const A = new BspNode(insideBox(aNear, boxOf(b, EPS * 100)) ?? a);
    const B = new BspNode(insideBox(bNear, boxOf(a, EPS * 100)) ?? b);
    // A.clipTo(B): A's parts inside B go.
    const aOut = B.clipPolygons(aNear);
    // B.clipTo(A); invert; clipTo(A); invert: B's parts inside A (and
    // those coplanar with A's faces, facing the same way) go.
    const bIn = A.clipPolygons(bNear);
    const bOut = A.clipPolygons(bIn.map(flip)).map(flip);
    return [...aOut, ...aFar, ...bOut, ...bFar];
  });
}

export function subtract(a: Polygon[], b: Polygon[]): Polygon[] {
  return withEps(a, b, () => {
    const [aNear, aFar] = nearFar(a, boxOf(b, EPS * 10));
    // B clear of A's box is dropped: outside A.
    const [bNear] = nearFar(b, boxOf(a, EPS * 10));
    // As in union: the trees only need each solid's surface near the other.
    const Ainv = new BspNode((insideBox(aNear, boxOf(b, EPS * 100)) ?? a).map(flip));
    const B = new BspNode(insideBox(bNear, boxOf(a, EPS * 100)) ?? b);
    // A.invert(); A.clipTo(B): A's parts inside B go (A kept flipped).
    const aOut = B.clipPolygons(aNear.map(flip));
    // B.clipTo(A); invert; clipTo(A); invert -- A being inverted: only B's
    // parts inside A survive.
    const b1 = Ainv.clipPolygons(bNear).map(flip);
    const b2 = Ainv.clipPolygons(b1);
    // A.build(B); A.invert(): everything flips back.
    return [...aOut.map(flip), ...aFar, ...b2];
  });
}

export function intersect(a: Polygon[], b: Polygon[]): Polygon[] {
  return withEps(a, b, () => {
    const A = new BspNode(a);
    const B = new BspNode(b);
    A.invert();
    B.clipTo(A);
    B.invert();
    A.clipTo(B);
    B.clipTo(A);
    A.build(B.allPolygons());
    A.invert();
    return A.allPolygons();
  });
}

/** Unit normal of the triangle (a, b, c); zero vector if degenerate. */
export function triangleNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  return normalize(cross(sub(b, a), sub(c, a)));
}

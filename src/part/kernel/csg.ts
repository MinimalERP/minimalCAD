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
  let polyType = 0;
  const types: number[] = [];
  for (const v of poly.vertices) {
    const t = dot(plane.normal, v) - plane.w;
    const type = t < -EPS ? BACK : t > EPS ? FRONT : COPLANAR;
    polyType |= type;
    types.push(type);
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
  const f: Vec3[] = [];
  const b: Vec3[] = [];
  const n = poly.vertices.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ti = types[i]!;
    const tj = types[j]!;
    const vi = poly.vertices[i]!;
    const vj = poly.vertices[j]!;
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
      if (node.plane === null) node.plane = { normal: polys[0]!.normal, w: polys[0]!.w };
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

  /** Removes the parts of `polygons` inside this tree's solid. */
  clipPolygons(polygons: Polygon[]): Polygon[] {
    const out: Polygon[] = [];
    const stack: [BspNode, Polygon[]][] = [[this, polygons]];
    while (stack.length > 0) {
      const [node, polys] = stack.pop()!;
      if (node.plane === null) {
        out.push(...polys);
        continue;
      }
      let front: Polygon[] = [];
      let back: Polygon[] = [];
      for (const p of polys) splitPolygon(node.plane, p, front, back, front, back);
      if (node.front !== null) stack.push([node.front, front]);
      else out.push(...front);
      if (node.back !== null) stack.push([node.back, back]);
      // No back node: back polygons are inside the solid -- dropped.
      front = [];
      back = [];
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

export function union(a: Polygon[], b: Polygon[]): Polygon[] {
  return withEps(a, b, () => {
    const A = new BspNode(a);
    const B = new BspNode(b);
    A.clipTo(B);
    B.clipTo(A);
    B.invert();
    B.clipTo(A);
    B.invert();
    A.build(B.allPolygons());
    return A.allPolygons();
  });
}

export function subtract(a: Polygon[], b: Polygon[]): Polygon[] {
  return withEps(a, b, () => {
    const A = new BspNode(a);
    const B = new BspNode(b);
    A.invert();
    A.clipTo(B);
    B.clipTo(A);
    B.invert();
    B.clipTo(A);
    B.invert();
    A.build(B.allPolygons());
    A.invert();
    return A.allPolygons();
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

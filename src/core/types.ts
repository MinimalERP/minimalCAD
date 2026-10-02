/**
 * MinimalCAD Web
 * core/types.ts
 *
 * Shared primitive types used throughout the app. World space is Y-down,
 * matching the desktop app's own convention (see entities/style.py's
 * rotatePoint docstring in the Python source) -- do not flip Y anywhere in
 * this port; other math (dynamic input angle parsing, mirror reflection)
 * depends on staying consistent with it.
 */

export interface Point {
  x: number;
  y: number;
}

export function pointAdd(a: Point, b: Point): Point {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function pointSub(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function pointScale(p: Point, s: number): Point {
  return { x: p.x * s, y: p.y * s };
}

export function pointDistance(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Axis-aligned bounding box as [minX, minY, maxX, maxY]. */
export type Bounds = [number, number, number, number];

export function unionBounds(a: Bounds, b: Bounds): Bounds {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

export function boundsOverlap(a: Bounds, b: Bounds, tol = 0): boolean {
  return a[0] <= b[2] + tol && b[0] <= a[2] + tol && a[1] <= b[3] + tol && b[1] <= a[3] + tol;
}

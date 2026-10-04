/**
 * MinimalCAD Web
 * engine/viewport.ts
 *
 * Pure scale+translate world<->screen projection -- no rotation, ever (see
 * graphics/canvas.py's own zoom/pan_offset pair in the Python source). All
 * rendering in this port pre-transforms world points to screen points in JS
 * before touching the Canvas 2D API (rather than driving the canvas's own
 * ctx.scale/ctx.translate), so cosmetic (always-1px) stroke widths and
 * fixed-screen-size glyphs (grips, snap markers) need no zoom-compensation
 * anywhere -- see the plan's rendering-approach writeup for why.
 */

import { pointAdd, type Bounds, type Point } from "../core/types";

const HOME_MARGIN_PX = 60.0;
const MIN_ZOOM = 0.01;
const MAX_ZOOM = 200.0;
const WHEEL_ZOOM_FACTOR = 1.15;

export class Viewport {
  zoom = 1.0;
  panOffset: Point = { x: 0, y: 0 };

  constructor(
    private getViewportWidth: () => number,
    private getViewportHeight: () => number,
  ) {}

  screenToWorld(screenPt: Point): Point {
    return {
      x: (screenPt.x - this.panOffset.x) / this.zoom,
      y: (screenPt.y - this.panOffset.y) / this.zoom,
    };
  }

  worldToScreen(worldPt: Point): Point {
    return {
      x: worldPt.x * this.zoom + this.panOffset.x,
      y: worldPt.y * this.zoom + this.panOffset.y,
    };
  }

  /** Places world origin (0,0) near the bottom-left of the viewport, zoom=1. */
  resetView(): void {
    this.zoom = 1.0;
    const height = this.getViewportHeight() > 0 ? this.getViewportHeight() : 600;
    this.panOffset = { x: HOME_MARGIN_PX, y: height - HOME_MARGIN_PX };
  }

  /** Fits `bounds` into the viewport with 10% padding, preserving aspect ratio. */
  zoomExtents(bounds: Bounds | null): void {
    const width = this.getViewportWidth();
    const height = this.getViewportHeight();

    if (bounds === null) {
      this.resetView();
      return;
    }

    let [minX, minY, maxX, maxY] = bounds;
    let docW = maxX - minX;
    let docH = maxY - minY;

    if (docW <= 0.01 || docH <= 0.01) {
      this.resetView();
      return;
    }

    const padding = Math.max(docW, docH) * 0.1;
    minX -= padding;
    minY -= padding;
    docW += padding * 2;
    docH += padding * 2;

    const scaleX = width / docW;
    const scaleY = height / docH;
    this.zoom = Math.min(scaleX, scaleY);

    this.panOffset = {
      x: (width - docW * this.zoom) / 2 - minX * this.zoom,
      y: (height - docH * this.zoom) / 2 - minY * this.zoom,
    };
  }

  /** World origin (0,0) at the middle of the viewport, zoomed so `bounds`
   *  (if any) still fits around it -- how a part sketch opens. */
  centerOrigin(bounds: Bounds | null): void {
    const width = this.getViewportWidth() > 0 ? this.getViewportWidth() : 800;
    const height = this.getViewportHeight() > 0 ? this.getViewportHeight() : 600;
    this.zoom = 1.0;
    if (bounds !== null) {
      const halfW = Math.max(Math.abs(bounds[0]), Math.abs(bounds[2])) * 1.1;
      const halfH = Math.max(Math.abs(bounds[1]), Math.abs(bounds[3])) * 1.1;
      const fit = Math.min(halfW > 0.01 ? width / (2 * halfW) : Infinity, halfH > 0.01 ? height / (2 * halfH) : Infinity);
      if (Number.isFinite(fit)) this.zoom = Math.min(Math.max(fit, MIN_ZOOM), MAX_ZOOM);
    }
    this.panOffset = { x: width / 2, y: height / 2 };
  }

  /** Zoom by one wheel notch, keeping `cursorScreenPt`'s world point fixed under the cursor. */
  zoomAtCursor(cursorScreenPt: Point, wheelDeltaY: number): void {
    const factor = wheelDeltaY < 0 ? WHEEL_ZOOM_FACTOR : 1.0 / WHEEL_ZOOM_FACTOR;
    this.zoomByFactor(cursorScreenPt, factor);
  }

  /** Same fixed-point zoom math as zoomAtCursor, but by an arbitrary
   *  multiplicative `factor` instead of one fixed wheel-notch step -- shared
   *  with touch pinch-to-zoom, which derives its own continuous factor from
   *  the ratio of the two touch points' current vs. previous distance. */
  zoomByFactor(cursorScreenPt: Point, factor: number): void {
    const worldBefore = this.screenToWorld(cursorScreenPt);
    const newZoom = this.zoom * factor;

    if (newZoom < MIN_ZOOM || newZoom > MAX_ZOOM) return;

    this.zoom = newZoom;
    this.panOffset = {
      x: cursorScreenPt.x - worldBefore.x * this.zoom,
      y: cursorScreenPt.y - worldBefore.y * this.zoom,
    };
  }

  pan(screenDelta: Point): void {
    this.panOffset = pointAdd(this.panOffset, screenDelta);
  }

  /** Fixed on-screen pixel radius converted to a world-space tolerance at the current zoom. */
  pickTolerance(screenPx = 6.0): number {
    return screenPx / Math.max(this.zoom, 0.0001);
  }

  /** The world-space rectangle currently visible in the viewport, as [minX,minY,maxX,maxY]. */
  visibleWorldRect(): Bounds {
    const topLeft = this.screenToWorld({ x: 0, y: 0 });
    const bottomRight = this.screenToWorld({ x: this.getViewportWidth(), y: this.getViewportHeight() });
    return [
      Math.min(topLeft.x, bottomRight.x),
      Math.min(topLeft.y, bottomRight.y),
      Math.max(topLeft.x, bottomRight.x),
      Math.max(topLeft.y, bottomRight.y),
    ];
  }
}

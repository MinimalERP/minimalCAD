/**
 * MinimalCAD Web
 * commands/trim.ts
 *
 * Ported from the ALREADY-FIXED commands/trim.py this session's earlier work
 * landed on the desktop app -- not the original buggy version. One-click
 * universal trim: find every intersection between the clicked entity and
 * every other entity, split the clicked entity at those intersection
 * parameters, remove the clicked sub-segment, and merge the untouched
 * remainder into as few pieces as possible (at most one piece on each side
 * of the removed interval) rather than fragmenting at every interior
 * crossing.
 *
 * Ways to use it, like AutoCAD's quick trim: click one piece; hold the
 * button and DRAG -- everything the stroke crosses is trimmed where it is
 * crossed; or click two empty points for a straight FENCE that does the
 * same. A whole drag or fence is one undo step. The piece a click would
 * take is shown in red under the cursor before it is clicked.
 *
 * With Shift held it EXTENDS instead: the end of a line or arc nearest the
 * click runs out to the next edge in its way (shown in green first). EXTEND
 * is the same command the other way round -- extend by default, Shift trims.
 *
 * Scope: Line, Circle, Arc, Ellipse -- and a Polyline (a rectangle), which
 * is opened into its Lines and Arcs for the trim and joined back into as
 * few outlines as what is left of it makes (commands/polylineCorners.ts).
 * A polyline that is not being trimmed still cuts: its segments are
 * cutting edges like any other entity.
 */

import type { Point } from "../core/types";
import type { Engine } from "../engine/engine";
import type { Entity } from "../entities/entity";
import { BaseCommand } from "./base";
import { Line } from "../entities/line";
import { Circle } from "../entities/circle";
import { Arc } from "../entities/arc";
import { Ellipse } from "../entities/ellipse";
import { findIntersections } from "../geometry/intersect";
import { entityAt } from "../engine/picking";
import { Polyline } from "../entities/polyline";
import { PolylineCorners } from "./polylineCorners";

const TWO_PI = 2.0 * Math.PI;
const MIN_SEGMENT = 0.01;

function normalizeAngle(angle: number): number {
  return ((angle % TWO_PI) + TWO_PI) % TWO_PI;
}

type Trimmable = Line | Circle | Arc | Ellipse;

export class TrimCommand extends BaseCommand {
  /** EXTEND is this command with the two actions swapped. */
  protected extendByDefault = false;
  /** Asked only to say what a click WOULD take: nothing is changed. */
  private previewing = false;
  private previewPiece: Entity | null = null;
  /** Where the mouse is while no button is held. */
  private hover: Point | null = null;
  /** The first point of a two-click fence, once an empty spot was clicked. */
  private fenceStart: Point | null = null;
  /** The press now held down landed on something (or ended a fence). */
  private pressUsed = false;
  private corners: PolylineCorners;
  /** The path of the drag in progress (world points), or null between drags. */
  private stroke: Point[] | null = null;
  /** One undo step for everything a press-drag-release trims. */
  private undoPushed = false;

  constructor(engine: Engine) {
    super(engine);
    this.corners = new PolylineCorners(engine);
  }

  start(): void {
    this.fenceStart = null;
    this.commandBar.setStatus(this.title(), this.extendByDefault ? "Click near the end of a line or arc to extend it to the next edge (Shift: trim)" : "Click a piece to trim it away, or drag across several (Shift: extend)");
  }

  /** A pick box for a cursor; the piece itself is shown by draw(), so no
   *  whole entity is lit. */
  pick(): (entity: Entity) => boolean {
    return () => false;
  }

  private title(): string {
    return this.extendByDefault ? "EXTEND" : "TRIM";
  }

  private say(message: string): void {
    if (!this.previewing) this.commandBar.setStatus(this.title(), message);
  }

  /** Extend rather than trim, right now? Shift swaps the command's action. */
  private extending(): boolean {
    return this.engine.shiftHeld !== this.extendByDefault;
  }

  leftClick(worldPos: Point): void {
    this.corners.close();
    this.undoPushed = false;
    this.stroke = [worldPos];
    this.hover = null;

    if (this.fenceStart !== null) {
      const from = this.fenceStart;
      this.fenceStart = null;
      this.pressUsed = true;
      this.across(from, worldPos);
      this.start();
      return;
    }

    const extend = this.extending();
    if (!extend) this.corners.openAt(worldPos);
    const trimmable = this.document.getEntities().filter((e) => this.isTrimmable(e));
    const target = entityAt(trimmable, worldPos, this.engine.pickTolerance());
    this.pressUsed = target !== null;
    if (target === null) return;
    if (extend) this.extendTarget(target as Trimmable, worldPos, trimmable as Trimmable[]);
    else this.trimTarget(target as Trimmable, worldPos);
  }

  /** While the button is held: whatever the stroke has just crossed is
   *  trimmed at the crossing. */
  mouseMove(worldPos: Point): void {
    if (this.stroke === null) {
      this.hover = worldPos; // draw() shows what a click here would take
      this.engine.requestRedraw();
      return;
    }
    const from = this.stroke[this.stroke.length - 1]!;
    this.stroke.push(worldPos);
    this.across(from, worldPos);
    this.engine.requestRedraw();
  }

  /** Trims (or extends) everything the straight step from -> to crosses, at
   *  the crossing. */
  private across(from: Point, worldPos: Point): void {
    if (Math.hypot(worldPos.x - from.x, worldPos.y - from.y) < 1e-9) return;
    const extend = this.extending();
    const step = new Line(from, worldPos);
    const crossed = (e: Trimmable): Point | null => {
      for (const p of findIntersections(step, e, 0)) {
        // on the stroke itself, not on its extension
        const t = ((p.x - from.x) * (worldPos.x - from.x) + (p.y - from.y) * (worldPos.y - from.y)) / ((worldPos.x - from.x) ** 2 + (worldPos.y - from.y) ** 2);
        if (t >= -1e-9 && t <= 1 + 1e-9) return p;
      }
      return null;
    };

    for (const e of extend ? [] : [...this.document.getEntities()]) {
      if (e instanceof Polyline && (e.segmentEntities() as Trimmable[]).some((s) => crossed(s) !== null)) this.corners.open(e);
    }
    const hits: [Trimmable, Point][] = [];
    for (const e of this.document.getEntities()) {
      if (!this.isTrimmable(e)) continue;
      const at = crossed(e as Trimmable);
      if (at !== null) hits.push([e as Trimmable, at]);
    }
    for (const [target, at] of hits) {
      if (!this.document.getEntities().includes(target)) continue;
      if (extend) this.extendTarget(target, at, this.cutters());
      else this.trimTarget(target, at);
    }
  }

  leftRelease(): void {
    const stroke = this.stroke;
    this.stroke = null;
    this.corners.close();
    // A plain click on an empty spot (no drag): the first point of a fence.
    if (stroke !== null && !this.pressUsed) {
      const start = stroke[0]!;
      const tol = this.engine.pickTolerance();
      if (stroke.every((q) => Math.hypot(q.x - start.x, q.y - start.y) <= tol)) {
        this.fenceStart = start;
        this.commandBar.setStatus(this.title(), "Fence: click the second point - everything the line crosses is " + (this.extendByDefault ? "extended" : "trimmed"));
      }
    }
    this.engine.requestRedraw();
  }

  /** Every entity that can cut or bound -- a polyline through its segments. */
  private cutters(): Trimmable[] {
    return this.document.getEntities().flatMap((e) => (e instanceof Polyline ? e.segmentEntities() : this.isTrimmable(e) ? [e] : [])) as Trimmable[];
  }

  /**
   * Runs the end of a Line or Arc nearest `at` out to the next edge in its
   * way. In preview only says what would be added.
   */
  private extendTarget(target: Trimmable, at: Point, edges: Trimmable[]): void {
    const others = edges.filter((e) => e !== target);
    const d = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
    if (target instanceof Line) {
      const atStart = d(at, target.startPoint) < d(at, target.endPoint);
      const end = atStart ? target.startPoint : target.endPoint;
      const other = atStart ? target.endPoint : target.startPoint;
      const len = d(end, other);
      if (len < 1e-9) return;
      const reach = Math.max(len, 1) * 1e5;
      const ray = new Line(end, { x: end.x + ((end.x - other.x) / len) * reach, y: end.y + ((end.y - other.y) / len) * reach });
      let best: Point | null = null;
      for (const e of others) {
        for (const q of findIntersections(ray, e, 0)) {
          if (d(q, end) > 1e-6 && (best === null || d(q, end) < d(best, end))) best = q;
        }
      }
      if (best === null) return this.say("Nothing in the way to extend to");
      if (this.previewing) {
        this.previewPiece = new Line(end, best);
        return;
      }
      this.pushUndo();
      if (atStart) target.startPoint = best;
      else target.endPoint = best;
      this.engine.requestRedraw();
      return;
    }
    if (target instanceof Arc) {
      const c = target.center;
      const sAng = normalizeAngle(target.startAngle);
      const eAng = normalizeAngle(target.endAngle);
      let sweep = normalizeAngle(eAng - sAng);
      if (sweep === 0) sweep = TWO_PI;
      const room = TWO_PI - sweep;
      const atEnd = normalizeAngle(Math.atan2(at.y - c.y, at.x - c.x) - sAng) > sweep / 2;
      const whole = new Circle(c, target.radius);
      let best: number | null = null;
      for (const e of others) {
        for (const q of findIntersections(whole, e, 0)) {
          const ang = Math.atan2(q.y - c.y, q.x - c.x);
          const delta = atEnd ? normalizeAngle(ang - eAng) : normalizeAngle(sAng - ang);
          if (delta > 1e-6 && delta < room - 1e-6 && (best === null || delta < best)) best = delta;
        }
      }
      if (best === null) return this.say("Nothing in the way to extend to");
      if (this.previewing) {
        this.previewPiece = atEnd ? new Arc(c, target.radius, eAng, eAng + best) : new Arc(c, target.radius, sAng - best, sAng);
        return;
      }
      this.pushUndo();
      if (atEnd) target.endAngle = normalizeAngle(eAng + best);
      else target.startAngle = normalizeAngle(sAng - best);
      this.engine.requestRedraw();
      return;
    }
    this.say("Only a line or an arc can be extended");
  }

  private pushUndo(): void {
    if (this.undoPushed) return;
    this.undoPushed = true;
    this.undo.push(this.corners.undoState());
  }

  /** Trims `target` at `at`: the piece of it between the cutting edges on
   *  either side of that point goes. */
  private trimTarget(target: Trimmable, at: Point, edges?: Trimmable[]): void {
    const worldPos = at;
    const gap = this.engine.pickTolerance();
    const points: Point[] = [];
    // every other entity cuts -- a polyline through its segments
    const cutters = edges ?? this.cutters();
    for (const other of cutters) {
      if (other === target) continue;
      points.push(...findIntersections(target, other as Trimmable, gap));
    }

    const uniquePoints: Point[] = [];
    for (const p of points) {
      if (!uniquePoints.some((u) => Math.hypot(p.x - u.x, p.y - u.y) < 1e-4)) {
        uniquePoints.push(p);
      }
    }

    if (this.previewing) {
      this.trimEntity(target, uniquePoints, worldPos);
      return;
    }
    // what replaces a loose entity stays loose: only an opened polyline's own pieces are joined back
    const loose = this.corners.isLoose(target);
    const had = new Set(this.document.getEntities());
    this.trimEntity(target, uniquePoints, worldPos);
    if (loose) this.corners.keepApart(this.document.getEntities().filter((e) => !had.has(e)));
  }

  private isTrimmable(e: Entity): boolean {
    return e instanceof Line || e instanceof Circle || e instanceof Arc || e instanceof Ellipse;
  }

  private trimEntity(entity: Entity, splitPoints: Point[], clickPt: Point): void {
    if (entity instanceof Line) this.trimLine(entity, splitPoints, clickPt);
    else if (entity instanceof Circle) this.trimCircle(entity, splitPoints, clickPt);
    else if (entity instanceof Arc) this.trimArc(entity, splitPoints, clickPt);
    else if (entity instanceof Ellipse) this.trimEllipse(entity, splitPoints, clickPt);
  }

  private trimLine(entity: Line, splitPoints: Point[], clickPt: Point): void {
    const p0 = entity.startPoint;
    const ux = entity.endPoint.x - p0.x;
    const uy = entity.endPoint.y - p0.y;
    const lenSq = ux * ux + uy * uy;
    if (lenSq === 0) return;

    const params = splitPoints.map((p) => {
      const t = ((p.x - p0.x) * ux + (p.y - p0.y) * uy) / lenSq;
      return Math.max(0, Math.min(1, t));
    });
    const clickT = ((clickPt.x - p0.x) * ux + (clickPt.y - p0.y) * uy) / lenSq;
    const clickParam = Math.max(0, Math.min(1, clickT));

    const realTouches = Array.from(new Set(params));
    let bounds = Array.from(new Set([0, ...params, 1])).sort((a, b) => a - b);

    if (bounds.length < 3) {
      if (realTouches.length < 2) {
        this.say("No cutting edge found - nothing trimmed");
        return;
      }
      // Both real cutting points collapsed into this line's own [0,1] anchors
      // (e.g. a rectangle side whose only neighbors touch it exactly at its
      // corners) -- the whole line IS "the segment between the two
      // intersections"; a click anywhere on it deletes the entire line.
      bounds = [0, 1];
    }

    let trimmedIdx = -1;
    for (let i = 0; i < bounds.length - 1; i++) {
      if (clickParam >= bounds[i]! && clickParam <= bounds[i + 1]!) {
        trimmedIdx = i;
        break;
      }
    }
    if (trimmedIdx === -1) return;
    if (this.previewing) {
      this.previewPiece = new Line({ x: p0.x + bounds[trimmedIdx]! * ux, y: p0.y + bounds[trimmedIdx]! * uy }, { x: p0.x + bounds[trimmedIdx + 1]! * ux, y: p0.y + bounds[trimmedIdx + 1]! * uy });
      return;
    }

    this.pushUndo();
    this.document.removeEntity(entity);

    const point = (t: number): Point => ({ x: p0.x + t * ux, y: p0.y + t * uy });
    if (bounds[trimmedIdx]! - bounds[0]! > MIN_SEGMENT) {
      this.document.addEntity(new Line(point(bounds[0]!), point(bounds[trimmedIdx]!), { lineType: entity.lineType }));
    }
    if (bounds[bounds.length - 1]! - bounds[trimmedIdx + 1]! > MIN_SEGMENT) {
      this.document.addEntity(
        new Line(point(bounds[trimmedIdx + 1]!), point(bounds[bounds.length - 1]!), { lineType: entity.lineType }),
      );
    }
    this.engine.requestRedraw();
    this.start();
  }

  private trimCircle(entity: Circle, splitPoints: Point[], clickPt: Point): void {
    if (splitPoints.length === 0) return;
    const cx = entity.center.x, cy = entity.center.y;

    const angles = Array.from(
      new Set(splitPoints.map((p) => normalizeAngle(Math.atan2(p.y - cy, p.x - cx)))),
    ).sort((a, b) => a - b);
    if (angles.length < 2) {
      this.say("Need at least 2 cutting points on a circle - nothing trimmed");
      return;
    }
    const clickParam = normalizeAngle(Math.atan2(clickPt.y - cy, clickPt.x - cx));

    const bounds = [...angles, angles[0]! + TWO_PI];
    let trimmedIdx = -1;
    for (let i = 0; i < bounds.length - 1; i++) {
      let testP = clickParam;
      if (i === bounds.length - 2 && testP < bounds[i]!) testP += TWO_PI;
      if (testP >= bounds[i]! && testP <= bounds[i + 1]!) {
        trimmedIdx = i;
        break;
      }
    }
    if (trimmedIdx === -1) return;
    if (this.previewing) {
      this.previewPiece = new Arc(entity.center, entity.radius, normalizeAngle(bounds[trimmedIdx]!), normalizeAngle(bounds[trimmedIdx + 1]!));
      return;
    }

    this.pushUndo();
    this.document.removeEntity(entity);

    // AutoCAD standard: circles trimmed form a single spanning arc.
    const a0 = normalizeAngle(bounds[trimmedIdx + 1]!);
    const a1 = normalizeAngle(bounds[trimmedIdx]!);
    this.document.addEntity(new Arc(entity.center, entity.radius, a0, a1, { lineType: entity.lineType }));
    this.engine.requestRedraw();
    this.start();
  }

  private trimArc(entity: Arc, splitPoints: Point[], clickPt: Point): void {
    const cx = entity.center.x, cy = entity.center.y;
    const sAng = normalizeAngle(entity.startAngle);
    const eAng = normalizeAngle(entity.endAngle);
    let totalSweep = ((eAng - sAng) % TWO_PI + TWO_PI) % TWO_PI;
    if (totalSweep === 0) totalSweep = TWO_PI;

    const allOffsets: number[] = [];
    const validSplitOffsets: number[] = [];
    for (const p of splitPoints) {
      const ang = normalizeAngle(Math.atan2(p.y - cy, p.x - cx));
      const relOffset = ((ang - sAng) % TWO_PI + TWO_PI) % TWO_PI;
      allOffsets.push(relOffset);
      if (relOffset > 1e-4 && relOffset < totalSweep - 1e-4) validSplitOffsets.push(relOffset);
    }

    const clickAng = normalizeAngle(Math.atan2(clickPt.y - cy, clickPt.x - cx));
    const clickParam = ((clickAng - sAng) % TWO_PI + TWO_PI) % TWO_PI;

    const realTouches = Array.from(new Set(allOffsets));
    let bounds = Array.from(new Set([0, ...validSplitOffsets, totalSweep])).sort((a, b) => a - b);

    if (bounds.length < 3) {
      if (realTouches.length < 2) {
        this.say("No cutting edge found - nothing trimmed");
        return;
      }
      // Both real cutting points sit at this arc's own two ends (a corner
      // join on each side) -- same whole-entity-is-the-segment case as Line.
      bounds = [0, totalSweep];
    }

    let trimmedIdx = -1;
    for (let i = 0; i < bounds.length - 1; i++) {
      if (clickParam >= bounds[i]! && clickParam <= bounds[i + 1]!) {
        trimmedIdx = i;
        break;
      }
    }
    if (trimmedIdx === -1) return;
    if (this.previewing) {
      this.previewPiece = new Arc(entity.center, entity.radius, normalizeAngle(sAng + bounds[trimmedIdx]!), normalizeAngle(sAng + bounds[trimmedIdx + 1]!));
      return;
    }

    this.pushUndo();
    this.document.removeEntity(entity);

    // Merge each side of the removed interval into at most one surviving
    // piece -- untouched interior crossings don't fragment the survivors.
    const o0a = bounds[0]!, o1a = bounds[trimmedIdx]!;
    if (o1a - o0a > 1e-4) {
      this.document.addEntity(
        new Arc(entity.center, entity.radius, normalizeAngle(sAng + o0a), normalizeAngle(sAng + o1a), {
          lineType: entity.lineType,
        }),
      );
    }
    const o0b = bounds[trimmedIdx + 1]!, o1b = bounds[bounds.length - 1]!;
    if (o1b - o0b > 1e-4) {
      this.document.addEntity(
        new Arc(entity.center, entity.radius, normalizeAngle(sAng + o0b), normalizeAngle(sAng + o1b), {
          lineType: entity.lineType,
        }),
      );
    }
    this.engine.requestRedraw();
    this.start();
  }

  /** Dispatches to whichever of trimCircle/trimArc's own two algorithms
   *  applies -- a FULL ellipse is a closed loop with no real endpoints (any
   *  angle="0" reference is arbitrary, so bounding pieces at a fixed 0/2*PI
   *  would carve a fake seam at a spot nothing actually cuts, same failure
   *  Circle avoids by never anchoring on anything but its own real cutting
   *  angles); a partial elliptical arc has genuine endpoints, same as Arc. */
  private trimEllipse(entity: Ellipse, splitPoints: Point[], clickPt: Point): void {
    if (entity.isFull()) this.trimFullEllipse(entity, splitPoints, clickPt);
    else this.trimPartialEllipse(entity, splitPoints, clickPt);
  }

  /** Identical to trimCircle, against Ellipse's own paramAngleOf()
   *  parametrization instead of plain atan2 -- same "one spanning piece"
   *  standard. */
  private trimFullEllipse(entity: Ellipse, splitPoints: Point[], clickPt: Point): void {
    if (splitPoints.length === 0) return;

    const angles = Array.from(new Set(splitPoints.map((p) => entity.paramAngleOf(p)))).sort((a, b) => a - b);
    if (angles.length < 2) {
      this.say("Need at least 2 cutting points on an ellipse - nothing trimmed");
      return;
    }
    const clickParam = entity.paramAngleOf(clickPt);

    const bounds = [...angles, angles[0]! + TWO_PI];
    let trimmedIdx = -1;
    for (let i = 0; i < bounds.length - 1; i++) {
      let testP = clickParam;
      if (i === bounds.length - 2 && testP < bounds[i]!) testP += TWO_PI;
      if (testP >= bounds[i]! && testP <= bounds[i + 1]!) {
        trimmedIdx = i;
        break;
      }
    }
    if (trimmedIdx === -1) return;
    if (this.previewing) {
      this.previewPiece = new Ellipse(entity.center, entity.radiusX, entity.radiusY, entity.rotation, normalizeAngle(bounds[trimmedIdx]!), normalizeAngle(bounds[trimmedIdx + 1]!));
      return;
    }

    this.pushUndo();
    this.document.removeEntity(entity);

    const a0 = normalizeAngle(bounds[trimmedIdx + 1]!);
    const a1 = normalizeAngle(bounds[trimmedIdx]!);
    this.document.addEntity(
      new Ellipse(entity.center, entity.radiusX, entity.radiusY, entity.rotation, a0, a1, {
        lineType: entity.lineType,
      }),
    );
    this.engine.requestRedraw();
    this.start();
  }

  /** Identical splitting logic to trimArc, just against Ellipse's own
   *  paramAngleOf()/pointAt() parametrization instead of plain atan2. */
  private trimPartialEllipse(entity: Ellipse, splitPoints: Point[], clickPt: Point): void {
    const sAng = normalizeAngle(entity.startAngle);
    const eAng = normalizeAngle(entity.endAngle);
    let totalSweep = ((eAng - sAng) % TWO_PI + TWO_PI) % TWO_PI;
    if (totalSweep === 0) totalSweep = TWO_PI;

    const allOffsets: number[] = [];
    const validSplitOffsets: number[] = [];
    for (const p of splitPoints) {
      const ang = entity.paramAngleOf(p);
      const relOffset = ((ang - sAng) % TWO_PI + TWO_PI) % TWO_PI;
      allOffsets.push(relOffset);
      if (relOffset > 1e-4 && relOffset < totalSweep - 1e-4) validSplitOffsets.push(relOffset);
    }

    const clickAng = entity.paramAngleOf(clickPt);
    const clickParam = ((clickAng - sAng) % TWO_PI + TWO_PI) % TWO_PI;

    const realTouches = Array.from(new Set(allOffsets));
    let bounds = Array.from(new Set([0, ...validSplitOffsets, totalSweep])).sort((a, b) => a - b);

    if (bounds.length < 3) {
      if (realTouches.length < 2) {
        this.say("No cutting edge found - nothing trimmed");
        return;
      }
      bounds = [0, totalSweep];
    }

    let trimmedIdx = -1;
    for (let i = 0; i < bounds.length - 1; i++) {
      if (clickParam >= bounds[i]! && clickParam <= bounds[i + 1]!) {
        trimmedIdx = i;
        break;
      }
    }
    if (trimmedIdx === -1) return;
    if (this.previewing) {
      this.previewPiece = new Ellipse(entity.center, entity.radiusX, entity.radiusY, entity.rotation, normalizeAngle(sAng + bounds[trimmedIdx]!), normalizeAngle(sAng + bounds[trimmedIdx + 1]!));
      return;
    }

    this.pushUndo();
    this.document.removeEntity(entity);

    const o0a = bounds[0]!, o1a = bounds[trimmedIdx]!;
    if (o1a - o0a > 1e-4) {
      this.document.addEntity(
        new Ellipse(
          entity.center,
          entity.radiusX,
          entity.radiusY,
          entity.rotation,
          normalizeAngle(sAng + o0a),
          normalizeAngle(sAng + o1a),
          { lineType: entity.lineType },
        ),
      );
    }
    const o0b = bounds[trimmedIdx + 1]!, o1b = bounds[bounds.length - 1]!;
    if (o1b - o0b > 1e-4) {
      this.document.addEntity(
        new Ellipse(
          entity.center,
          entity.radiusX,
          entity.radiusY,
          entity.rotation,
          normalizeAngle(sAng + o0b),
          normalizeAngle(sAng + o1b),
          { lineType: entity.lineType },
        ),
      );
    }
    this.engine.requestRedraw();
    this.start();
  }

  rightClick(): void {
    this.engine.cancelCommand();
  }

  /** What a click where the mouse is would take away (red) or add (green). */
  private drawPreview(ctx: CanvasRenderingContext2D): void {
    if (this.hover === null) return;
    const extend = this.extending();
    // a polyline is looked at through its segments, without opening it
    const edges = extend ? (this.document.getEntities().filter((e) => this.isTrimmable(e)) as Trimmable[]) : this.cutters();
    const target = entityAt(edges, this.hover, this.engine.pickTolerance());
    if (target === null) return;
    this.previewing = true;
    this.previewPiece = null;
    try {
      if (extend) this.extendTarget(target, this.hover, this.cutters());
      else this.trimTarget(target, this.hover, edges);
    } finally {
      this.previewing = false;
    }
    const piece = this.previewPiece as Entity | null;
    if (piece === null) return;
    // drawn by the entity's own draw(), with its colour and weight overruled
    const tinted = new Proxy(ctx, {
      set(t, key, value) {
        if (key === "strokeStyle" || key === "fillStyle" || key === "lineWidth") return true;
        Reflect.set(t, key, value);
        return true;
      },
      get(t, key) {
        const v = Reflect.get(t, key) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    ctx.save();
    ctx.strokeStyle = extend ? "#3ddc84" : "#ff4d4d";
    ctx.lineWidth = 3;
    piece.draw(tinted, this.engine.viewport, false);
    ctx.restore();
  }

  /** The stroke of a drag in progress, so it is plain what has been swept;
   *  between drags, the fence being placed and the piece under the cursor. */
  draw(ctx: CanvasRenderingContext2D): void {
    if (this.stroke === null) {
      if (this.fenceStart !== null && this.hover !== null) {
        const a = this.engine.viewport.worldToScreen(this.fenceStart);
        const b = this.engine.viewport.worldToScreen(this.hover);
        ctx.save();
        ctx.strokeStyle = "#ffb000";
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.restore();
      } else {
        this.drawPreview(ctx);
      }
      return;
    }
    if (this.stroke.length < 2) return;
    ctx.save();
    ctx.strokeStyle = "#ffb000";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    this.stroke.forEach((p, i) => {
      const s = this.engine.viewport.worldToScreen(p);
      if (i === 0) ctx.moveTo(s.x, s.y);
      else ctx.lineTo(s.x, s.y);
    });
    ctx.stroke();
    ctx.restore();
  }

  cancel(): void {
    this.stroke = null;
    this.hover = null;
    this.fenceStart = null;
    this.corners.close();
    this.commandBar.setReady();
  }
}

/** EXTEND: the same command with its two actions swapped -- a click extends,
 *  Shift+click trims. */
export class ExtendCommand extends TrimCommand {
  protected override extendByDefault = true;
}

/**
 * MinimalCAD Web
 * view3d/commands/line3dCommand.ts
 *
 * 3D Line, AutoCAD-style: click points anywhere in the 3D view, osnapping
 * to the solid's corners (End), straight-edge middles (Mid) and circle
 * centres (Cen). With no osnap a point lands on the face under the cursor,
 * or -- over empty space -- on the plane through the last point facing you.
 * Once three points span a plane, the loop is held flat on it.
 *
 * Closing the loop (click its first point, or type C) makes a work plane
 * through the loop and a sketch of its lines on it, then opens Extrude with
 * that shape chosen: it extrudes off the loop's own plane. Enter finishes an
 * open chain (kept as a sketch when it spans a plane).
 *
 * Typed: x,y,z (absolute), @dx,dy,dz (from the last point), a bare length
 * (along the rubber band), C (close), U (undo a point).
 */

import type { WorkPlane } from "../../part/types";
import { nextId } from "../../part/types";
import { pointsFrame } from "../../part/workPlane";
import type { Snap3d } from "../../part/line3d";
import { chainToSketch, isPlanar, loopPlane, planeTol, planeTriple, snapPoints3d } from "../../part/line3d";
import type { Vec3 } from "../../part/vec3";
import { add, dot, length, normalize, scale, sub } from "../../part/vec3";
import type { Hit } from "../modelView";
import type { ModelCommand, ModelContext } from "./context";
import { ExtrudeCommand } from "./extrudeCommand";
import { showToast } from "../../ui/toast";

type PointHit = Extract<Hit, { kind: "point3d" }>;

const NAME = "3D LINE";

export class Line3dCommand implements ModelCommand {
  private points: Vec3[] = [];
  private solidSnaps: Snap3d[];
  /** Where the cursor would put the next point (for the rubber band and a typed length). */
  private cursor: { p: Vec3; snapped: boolean } | null = null;

  constructor(private ctx: ModelContext) {
    this.solidSnaps = snapPoints3d(ctx.result()?.bodies ?? []);
    ctx.view.setOriginPlanesVisible(false);
    ctx.view.setPoint3dMode(this.candidates());
    ctx.view.onPoint3dHover = (hit) => this.onHover(hit);
    this.prompt();
  }

  /** The loop's plane once three points span one. */
  private plane(): { origin: Vec3; n: Vec3 } | null {
    return loopPlane(this.points);
  }

  private onPlane(p: Vec3): boolean {
    const pl = this.plane();
    return pl === null || Math.abs(dot(sub(p, pl.origin), pl.n)) <= planeTol([...this.points, p]) * 10;
  }

  /** Osnap candidates: the solid's (only those on the loop's plane once it has one) and the chain's own points. */
  private candidates(): { p: Vec3; kind: string }[] {
    const own = this.points.map((p, i) => ({ p, kind: i === 0 ? "start" : "end" }));
    // The chain's own points first: on a tie (the start is also a corner) they win.
    return [...own, ...this.solidSnaps.filter((s) => this.onPlane(s.p))];
  }

  /** Where the ray meets the plane through `o` with normal `n`, or null. */
  private static rayPlane(ray: PointHit["ray"], o: Vec3, n: Vec3): Vec3 | null {
    const denom = dot(ray.d, n);
    if (Math.abs(denom) < 1e-9) return null;
    return add(ray.o, scale(ray.d, dot(sub(o, ray.o), n) / denom));
  }

  /** The point a hover / click gives. */
  private resolve(hit: PointHit): { p: Vec3; snapped: boolean } | null {
    if (hit.snap !== null) return { p: hit.snap.p, snapped: true };
    const pl = this.plane();
    if (pl !== null) {
      const p = Line3dCommand.rayPlane(hit.ray, pl.origin, pl.n);
      return p === null ? null : { p, snapped: false };
    }
    if (hit.at !== null) return { p: hit.at, snapped: false };
    const last = this.points[this.points.length - 1];
    // Nothing yet: the ground (XY). Otherwise the plane through the last point facing the view.
    const p = last === undefined ? Line3dCommand.rayPlane(hit.ray, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }) : Line3dCommand.rayPlane(hit.ray, last, normalize(hit.ray.d));
    return p === null ? null : { p, snapped: false };
  }

  private onHover(hit: PointHit | null): void {
    this.cursor = hit === null ? null : this.resolve(hit);
    if (hit?.snap != null) this.ctx.status(NAME, `${SNAP_LABEL[hit.snap.kind] ?? hit.snap.kind} - click to use it`);
    else this.prompt();
    this.draw();
  }

  onPick(hit: Hit): void {
    if (hit.kind !== "point3d") return;
    const first = this.points[0];
    const onStart = hit.snap !== null && first !== undefined && length(sub(hit.snap.p, first)) <= planeTol(this.points);
    if (onStart) {
      if (this.points.length >= 3) this.close();
      else this.ctx.status(NAME, "A loop needs at least three points before it can close");
      return;
    }
    const r = this.resolve(hit);
    if (r !== null) this.add(r.p);
  }

  private add(p: Vec3): void {
    const last = this.points[this.points.length - 1];
    if (last !== undefined && length(sub(p, last)) <= planeTol(this.points)) return;
    if (!this.onPlane(p)) {
      this.ctx.status(NAME, "That point isn't on the loop's plane - the loop must stay flat to extrude");
      return;
    }
    this.points.push(p);
    this.ctx.view.setPoint3dCandidates(this.candidates());
    this.prompt();
    this.draw();
  }

  private draw(): void {
    const last = this.points[this.points.length - 1];
    this.ctx.view.setChainPreview(this.points, last !== undefined && this.cursor !== null ? [last, this.cursor.p] : null, this.cursor);
  }

  private prompt(): void {
    const n = this.points.length;
    this.ctx.status(
      NAME,
      n === 0
        ? "Click the first point (snaps to corners, midpoints, centres) - or type x,y,z"
        : n < 3
          ? "Click the next point - or type a length, @dx,dy,dz, U to undo"
          : "Next point - click the first point (or type C) to close and extrude, Enter to finish",
    );
  }

  textInput(text: string): boolean {
    const t = text.trim().toLowerCase();
    if (t === "") return true;
    if (t === "c" || t === "close") {
      this.close();
      return true;
    }
    if (t === "u" || t === "undo") {
      this.points.pop();
      this.ctx.view.setPoint3dCandidates(this.candidates());
      this.prompt();
      this.draw();
      return true;
    }
    const last = this.points[this.points.length - 1];
    const nums = (s: string): number[] | null => {
      const parts = s.split(",").map((x) => Number(x.trim()));
      return parts.length === 3 && parts.every(Number.isFinite) ? parts : null;
    };
    if (t.startsWith("@")) {
      const d = nums(t.slice(1));
      if (d === null || last === undefined) return this.badInput();
      this.add(add(last, { x: d[0]!, y: d[1]!, z: d[2]! }));
      return true;
    }
    const abs = nums(t);
    if (abs !== null) {
      this.add({ x: abs[0]!, y: abs[1]!, z: abs[2]! });
      return true;
    }
    const len = Number(t);
    if (Number.isFinite(len) && last !== undefined && this.cursor !== null) {
      const dir = sub(this.cursor.p, last);
      if (!(length(dir) > 0)) return this.badInput();
      this.add(add(last, scale(normalize(dir), len)));
      return true;
    }
    return this.badInput();
  }

  private badInput(): boolean {
    this.ctx.status(NAME, "Type x,y,z  or  @dx,dy,dz  or a length (with a point placed), C to close, U to undo");
    return true;
  }

  /** Close the loop: work plane + sketch through it, then Extrude it. */
  private close(): void {
    if (this.points.length < 3 || planeTriple(this.points) === null) {
      this.ctx.status(NAME, "A loop needs at least three points that aren't in one line");
      return;
    }
    if (!isPlanar(this.points)) {
      this.ctx.status(NAME, "The points aren't on one plane - a loop must be flat to extrude");
      return;
    }
    const sketchId = this.save(true);
    if (sketchId === null) return;
    // Hand straight over to Extrude with the new shape chosen.
    const ctx = this.ctx;
    ctx.done();
    ctx.startCommand(() => ExtrudeCommand.start(ctx, null, { sketch: sketchId }));
  }

  /** Adds the work plane and the sketch; returns the sketch id. */
  private save(closed: boolean): string | null {
    const triple = planeTriple(this.points);
    if (triple === null) return null;
    const placed = pointsFrame(triple, 0);
    if (typeof placed === "string") return null;
    const entities = chainToSketch(this.points, placed.frame, closed);
    const xyz = (p: Vec3): Vec3 => ({ x: p.x, y: p.y, z: p.z });
    let sketchId = "";
    this.close3d();
    this.ctx.commit((part) => {
      const wp: WorkPlane = { id: nextId(part, "WorkPlane"), base: "XY", offset: "0", angle: "0", axis: "u", on: { points: [xyz(triple[0]), xyz(triple[1]), xyz(triple[2])] } };
      part.planes.push(wp);
      sketchId = nextId(part, "Sketch");
      part.sketches.push({ id: sketchId, plane: { base: wp.id, offset: 0 }, entities, constraints: [] });
    });
    return sketchId;
  }

  /** Enter: finish. An open chain is kept as a sketch if it spans a plane. */
  ok(): void {
    if (this.points.length >= 3 && isPlanar(this.points)) {
      const first = this.points[0]!;
      const last = this.points[this.points.length - 1]!;
      // Ended back on the start: that's a closed loop.
      if (length(sub(first, last)) <= planeTol(this.points)) {
        this.points.pop();
        this.close();
        return;
      }
      this.save(false);
      showToast("Lines kept as a sketch on their own plane (not closed, so nothing to extrude).");
    } else if (this.points.length >= 2) showToast("Not kept - lines need a flat shape of 3+ points to become a sketch.");
    this.close3d();
    this.ctx.done();
  }

  cancel(): void {
    this.close3d();
    this.ctx.done();
  }

  private close3d(): void {
    this.ctx.view.onPoint3dHover = null;
    this.ctx.view.setChainPreview([], null, null);
    this.ctx.view.setPickMode("none");
  }
}

const SNAP_LABEL: Record<string, string> = { end: "Endpoint", mid: "Midpoint", cen: "Centre", start: "Close the loop (first point)" };

/**
 * MinimalCAD Web
 * view3d/commands/workPlaneCommand.ts
 *
 * Work Plane (a saved, parametric UCS), driven by a dialog. Types:
 *
 *  - From origin: one of XY / XZ / YZ (or click it), offset, tilted about
 *    one of its own axes.
 *  - Angle from face: click a flat face, then one of its straight edges to
 *    hinge on; Angle tilts the plane from the face about that edge.
 *  - Offset from face: click a flat face; the plane is parallel to it.
 *  - Tangent: click a round face; Angle is where round its axis the plane
 *    touches it; a negative Offset sinks it into the part (a flat, a keyway).
 *  - Between 2 faces: click two parallel flat faces; the plane is halfway.
 *  - 3 points: click three points of the model (they snap to corners,
 *    middles and centres).
 *
 * Offset moves any of them along its own normal. Every type but the first
 * is tied to the model and follows it. Live plane preview throughout.
 */

import type { BasePlane, ModelPlaneRef, WorkPlane } from "../../part/types";
import { isBasePlane, modelPlaneKind, nextId } from "../../part/types";
import { workPlaneFrame } from "../../part/plane";
import { evalExpression } from "../../part/params";
import type { HingeEdge } from "../../part/workPlane";
import { hingeEdges, hingeRef, modelPlane, resolveFlatFace, resolveHinge, resolveRoundFace } from "../../part/workPlane";
import { surfaceTo3d } from "../../part/cylFrame";
import type { Body, Face } from "../../part/kernel/types";
import type { Vec3 } from "../../part/vec3";
import type { Hit } from "../modelView";
import { FeatureDialog, ICONS } from "../featureDialog";
import type { ChoiceHandle, FieldHandle, SelectionHandle } from "../featureDialog";
import type { ModelCommand, ModelContext } from "./context";

/** Human axis names of a base plane's (u, v) directions. */
export function planeAxes(base: string): [string, string] {
  const axes: Record<string, [string, string]> = { XY: ["X", "Y"], XZ: ["X", "Z"], YZ: ["Y", "Z"] };
  return axes[base] ?? ["u", "v"];
}

type PlaneType = "origin" | "hinge" | "parallel" | "tangent" | "mid" | "points";
type Rows = { setVisible(v: boolean): void };
type Picked = { body: Body; face: Face };

const TYPE_HINT: Record<PlaneType, string> = {
  origin: "Choose or click the plane to start from, set offset / angle, then OK",
  hinge: "Click a flat face of the solid, then the straight edge of it to hinge on",
  parallel: "Click a flat face of the solid: the plane is parallel to it, Offset away",
  tangent: "Click a round face: the plane touches it at Angle round its axis",
  mid: "Click two parallel flat faces: the plane is halfway between them",
  points: "Click three points of the model (corners, middles and centres snap)",
};

export class WorkPlaneCommand implements ModelCommand {
  private dialog: FeatureDialog;
  private type: PlaneType;
  private base: BasePlane;
  private axis: "u" | "v";
  private offset: string;
  private angle: string;
  private baseChoice!: ChoiceHandle<BasePlane>;
  private axisChoice!: ChoiceHandle<"u" | "v">;
  private angleField: FieldHandle;
  private rows: Partial<Record<"origin" | "hinge" | "face" | "mid" | "points" | "tilt" | "flip", Rows>> = {};
  private faceSel!: SelectionHandle;
  private hingeSel!: SelectionHandle;
  private oneFaceSel!: SelectionHandle;
  private face1Sel!: SelectionHandle;
  private face2Sel!: SelectionHandle;
  private pointsSel!: SelectionHandle;
  /** The picked faces (one; two for "mid"), the hinge among the first one's
   *  edges, and the picked points ("points"). */
  private faces: Picked[] = [];
  private edges: HingeEdge[] = [];
  private hinge: HingeEdge | null = null;
  private points: Vec3[] = [];
  private hover: number | null = null;
  private stage: "face" | "hinge" = "face";

  constructor(
    private ctx: ModelContext,
    private editing: WorkPlane | null,
  ) {
    const bodies = ctx.result()?.bodies ?? [];
    this.type = editing?.on !== undefined ? modelPlaneKind(editing.on) : "origin";
    this.base = editing?.base ?? "XY";
    this.axis = editing?.axis ?? "u";
    this.offset = editing?.offset ?? "0";
    this.angle = editing?.angle ?? "0";
    const on = editing?.on;
    if (on !== undefined) {
      // What it was made from, as the model stands now.
      if ("points" in on) this.points = on.points.map((p) => ({ ...p }));
      else if ("hinge" in on) {
        const h = resolveHinge(bodies, on);
        if (typeof h !== "string") this.setFace(h.body, h.face, h);
      } else if ("tangent" in on) {
        const r = resolveRoundFace(bodies, on);
        if (typeof r !== "string") this.faces = [r];
      } else {
        for (const ref of "face2" in on ? [on.face, on.face2] : [on.face]) {
          const f = resolveFlatFace(bodies, ref);
          if (typeof f !== "string") this.faces.push(f);
        }
      }
    }

    const d = (this.dialog = new FeatureDialog(ctx.dialogParent, editing === null ? "Work Plane" : `Edit ${editing.id}`, {
      onOk: () => this.ok(),
      onCancel: () => this.cancel(),
    }));
    if (editing === null && bodies.length > 0) {
      d.choice<PlaneType>(
        "Type",
        [
          { value: "origin", label: "From origin", title: "Offset / tilt one of the XY, XZ, YZ planes" },
          { value: "hinge", label: "Angle from face", title: "Tilt from a flat face of the solid, hinged on one of its edges" },
          { value: "parallel", label: "Offset from face", title: "Parallel to a flat face of the solid, a distance away" },
          { value: "tangent", label: "Tangent", title: "Touching a round face, at an angle round its axis" },
          { value: "mid", label: "Between 2 faces", title: "Halfway between two parallel flat faces" },
          { value: "points", label: "3 points", title: "Through three points of the model" },
        ],
        this.type,
        (t) => this.setType(t),
      );
    }
    this.rows.origin = d.rowGroup(() => {
      this.baseChoice = d.choice<BasePlane>(
        "Start from",
        [
          { value: "XY", label: "XY", title: "Top (ground) plane" },
          { value: "XZ", label: "XZ", title: "Front plane" },
          { value: "YZ", label: "YZ", title: "Right plane" },
        ],
        this.base,
        (b) => {
          this.base = b;
          this.relabelAxes();
          this.update();
        },
      );
    });
    this.rows.hinge = d.rowGroup(() => {
      this.faceSel = d.selection("Face", "", false, () => this.setStage("face"));
      this.hingeSel = d.selection("Hinge edge", "", false, () => this.setStage("hinge"));
    });
    this.rows.face = d.rowGroup(() => (this.oneFaceSel = d.selection("Face", "")));
    this.rows.mid = d.rowGroup(() => {
      this.face1Sel = d.selection("Face 1", "");
      this.face2Sel = d.selection("Face 2", "");
    });
    this.rows.points = d.rowGroup(() => {
      this.pointsSel = d.selection("Points", "");
      d.buttons("", [
        {
          label: "Pick again",
          onClick: () => {
            this.points = [];
            this.update();
          },
        },
      ]);
    });
    this.rows.tilt = d.rowGroup(() => this.buildAxisChoice());
    this.angleField = d.number("Angle", "°", this.angle, (t) => {
      this.angle = t;
      this.update();
    });
    this.rows.flip = d.rowGroup(() =>
      d.buttons("Tilt", [
        {
          label: "Flip",
          onClick: () => {
            // The other way round the hinge: negate the angle as typed.
            const a = this.angle.trim();
            this.angle = a.startsWith("-(") && a.endsWith(")") ? a.slice(2, -1) : a.startsWith("-") ? a.slice(1) : /^[\d.]+$/.test(a) ? `-${a}` : `-(${a})`;
            this.angleField.set(this.angle);
            this.update();
          },
        },
      ]),
    );
    d.number("Offset", "mm", this.offset, (t) => {
      this.offset = t;
      this.update();
    });
    d.hint("Like a saved UCS. A plane made from the model follows it; sketches on it follow later edits.");

    ctx.view.onEdgeHover = (hit) => this.onHover(hit);
    this.startPicking();
    this.update();
    d.focusFirst();
  }

  private setType(t: PlaneType): void {
    this.type = t;
    this.faces = [];
    this.edges = [];
    this.hinge = null;
    this.points = [];
    // A fresh hinged plane at 0 degrees would just lie on its face.
    if (t === "hinge" && this.angle === "0") this.angleField.set((this.angle = "30"));
    if (t === "tangent" && this.angle === "30") this.angleField.set((this.angle = "0"));
    this.startPicking();
    this.update();
  }

  private buildAxisChoice(): void {
    const [u, v] = planeAxes(this.base);
    this.axisChoice = this.dialog.choice<"u" | "v">(
      "Tilt about",
      [
        { value: "u", label: `${u} axis`, icon: ICONS.axisU },
        { value: "v", label: `${v} axis`, icon: ICONS.axisV },
      ],
      this.axis,
      (a) => {
        this.axis = a;
        this.update();
      },
    );
  }

  private relabelAxes(): void {
    const [u, v] = planeAxes(this.base);
    const labels = this.dialog.el.querySelectorAll<HTMLSpanElement>(".fd-choice-btn span");
    // The tilt choice's two labels follow the base's.
    const tilt = [...labels].filter((s) => /axis$/.test(s.textContent ?? ""));
    if (tilt.length === 2) {
      tilt[0]!.textContent = `${u} axis`;
      tilt[1]!.textContent = `${v} axis`;
    }
  }

  /** Sets up the view's picking for the current type. */
  private startPicking(): void {
    const view = this.ctx.view;
    view.setMarkers(null, [], null);
    view.setOriginPlanesVisible(this.type === "origin");
    if (this.type === "hinge") this.setStage(this.faces.length === 0 ? "face" : "hinge");
    else if (this.type === "tangent") view.setEdgePickMode([]); // faces of any kind
    else if (this.type === "points") view.setSurfacePointMode();
    else view.setPickMode("plane"); // origin planes / flat faces
    if (this.type !== "hinge") this.ctx.status("WORK PLANE", TYPE_HINT[this.type]);
  }

  private setFace(body: Body, face: Face, hinge: HingeEdge | null = null): void {
    this.faces = [{ body, face }];
    this.edges = hingeEdges(body, face);
    this.hinge = hinge === null ? null : (this.edges.find((e) => e.a === hinge.a && e.b === hinge.b) ?? hinge);
  }

  private setStage(stage: "face" | "hinge"): void {
    if (this.type !== "hinge") return;
    if (stage === "hinge" && this.faces.length === 0) stage = "face";
    this.stage = stage;
    this.hover = null;
    if (stage === "face") {
      this.ctx.view.setPickMode("plane");
      this.ctx.status("WORK PLANE", "Click a flat face of the solid to start the plane from");
    } else {
      this.ctx.view.setEdgePickMode(this.edges.map((e) => [e.a, e.b]));
      this.ctx.status(
        "WORK PLANE",
        this.hinge === null ? "Now click the straight edge of that face to hinge the plane on" : "Hinge picked (blue) - click another edge or face to change, set the angle, then OK",
      );
    }
    this.faceSel.setActive(stage === "face");
    this.hingeSel.setActive(stage === "hinge");
    this.drawEdges();
  }

  onPick(hit: Hit): void {
    if (this.type === "origin") {
      if (hit.kind === "plane" && isBasePlane(hit.key)) {
        this.base = hit.key;
        this.baseChoice.set(hit.key);
        this.relabelAxes();
        this.update();
      }
      return;
    }
    if (this.type === "points") {
      if (hit.kind !== "surfacePoint") return;
      if (this.points.length >= 3) this.points = []; // a fourth click starts over
      this.points.push(surfaceTo3d(hit.frame, hit.point));
      this.update();
      return;
    }
    if (hit.kind === "edge" && this.type === "hinge" && this.stage === "hinge") {
      this.hinge = this.edges[hit.index] ?? null;
      this.setStage("hinge");
      this.update();
      return;
    }
    if (hit.kind !== "face") return;
    const face = hit.body.faces[hit.faceId];
    if (face === undefined) return;
    const picked = { body: hit.body, face };
    if (this.type === "tangent") {
      if (face.geom.kind !== "cylinder" && face.geom.kind !== "cone") {
        this.dialog.setError("That face is not round - click a cylinder or a cone");
        return;
      }
      this.faces = [picked];
    } else if (face.geom.kind !== "plane") {
      this.dialog.setError("That face is round - click a flat face");
      return;
    } else if (this.type === "parallel") this.faces = [picked];
    else if (this.type === "mid") {
      // Third click starts over; the same face twice is ignored.
      if (this.faces.length >= 2) this.faces = [];
      if (this.faces[0]?.face !== face) this.faces.push(picked);
    } else {
      // hinge: any click on a flat face (re)starts from that face.
      if (this.faces[0]?.face === face && this.stage === "hinge") return;
      this.setFace(hit.body, face);
      if (this.edges.length === 1) this.hinge = this.edges[0]!; // only one possible hinge
      this.setStage("hinge");
    }
    this.update();
  }

  onSurfaceHover(hit: Extract<Hit, { kind: "surfacePoint" }> | null): void {
    if (this.type !== "points") return;
    this.ctx.view.setMarkers(hit?.frame ?? null, [], hit === null ? null : { point: hit.point, snap: hit.snap });
  }

  private onHover(hit: Hit | null): void {
    if (this.type !== "hinge" || this.stage !== "hinge") return;
    this.hover = hit?.kind === "edge" ? hit.index : null;
    this.drawEdges();
  }

  /** Blue: the hinge, or the picked points joined up. Yellow: the hovered edge. */
  private drawEdges(): void {
    const selected: Vec3[][] = [];
    if (this.type === "hinge" && this.hinge !== null) selected.push([this.hinge.a, this.hinge.b]);
    if (this.type === "points" && this.points.length >= 2) selected.push(this.points.length === 3 ? [...this.points, this.points[0]!] : this.points);
    const hover = this.type === "hinge" && this.hover !== null ? this.edges[this.hover] : undefined;
    this.ctx.view.setEdgeHighlights(selected, hover === undefined ? [] : [[hover.a, hover.b]]);
  }

  /** What the plane is made from, as stored -- or what is still missing. */
  private on(): ModelPlaneRef | string {
    const [a, b] = this.faces;
    if (this.type === "points") {
      const left = 3 - this.points.length;
      return left > 0 ? `Click ${left} more point${left === 1 ? "" : "s"} on the model` : { points: this.points.map((p) => ({ ...p })) as [Vec3, Vec3, Vec3] };
    }
    if (this.type === "tangent") return a === undefined ? "Click a round face of the solid" : { face: a.face.ref, tangent: true };
    if (a === undefined) return "Click a flat face of the solid";
    if (this.type === "parallel") return { face: a.face.ref, parallel: true };
    if (this.type === "mid") return b === undefined ? "Click the second face - parallel to the first" : { face: a.face.ref, face2: b.face.ref };
    if (this.edges.length === 0) return "That face has no straight edge to hinge on - pick another face";
    return this.hinge === null ? "Click the edge of the face to hinge the plane on" : { face: a.face.ref, hinge: hingeRef(this.hinge) };
  }

  private update(): void {
    const t = this.type;
    const show: Record<keyof WorkPlaneCommand["rows"], boolean> = {
      origin: t === "origin",
      tilt: t === "origin",
      hinge: t === "hinge",
      flip: t === "hinge",
      face: t === "parallel" || t === "tangent",
      mid: t === "mid",
      points: t === "points",
    };
    for (const [key, rows] of Object.entries(this.rows)) rows?.setVisible(show[key as keyof typeof show]);
    this.angleField.setVisible(t === "origin" || t === "hinge" || t === "tangent");

    const name = (p: Picked | undefined, missing: string): [string, boolean] => (p === undefined ? [missing, false] : [`Face of ${p.face.ref.feature}`, true]);
    const [a, b] = this.faces;
    this.faceSel.set(...name(a, "Click a flat face"));
    this.hingeSel.set(
      this.hinge !== null ? "Edge picked" : a === undefined ? "Pick the face first" : this.edges.length === 0 ? "No straight edge" : "Click an edge of the face",
      this.hinge !== null,
    );
    this.oneFaceSel.set(...name(a, t === "tangent" ? "Click a round face" : "Click a flat face"));
    this.face1Sel.set(...name(a, "Click a flat face"));
    this.face2Sel.set(...name(b, a === undefined ? "Pick face 1 first" : "Click the parallel face"));
    this.pointsSel.set(`${this.points.length} of 3 picked`, this.points.length === 3);
    this.drawEdges();

    const off = evalExpression(this.offset, this.ctx.params());
    const ang = evalExpression(this.angle, this.ctx.params());
    let error = off === null ? "Offset must be a number" : ang === null ? "Angle must be a number" : null;
    let plane: ReturnType<typeof modelPlane> | null = null;
    if (t !== "origin") {
      const on = this.on();
      if (typeof on === "string") error = on;
      else if (error === null) {
        plane = modelPlane(on, this.ctx.result()?.bodies ?? [], ang!, off!);
        if (typeof plane === "string") error = plane;
      }
    }
    this.dialog.setError(error);
    if (error !== null || off === null || ang === null) this.ctx.view.setPlanePreview(null);
    else if (plane !== null && typeof plane !== "string") this.ctx.view.setPlanePreview(plane.frame, plane.hingeAt, plane.centerAt);
    else this.ctx.view.setPlanePreview(workPlaneFrame({ base: this.base, axis: this.axis }, off, ang));
    this.axisChoice.set(this.axis);
  }

  ok(): void {
    const off = evalExpression(this.offset, this.ctx.params());
    const ang = evalExpression(this.angle, this.ctx.params());
    if (off === null || ang === null) return;
    const on = this.type === "origin" ? null : this.on();
    if (typeof on === "string") return;
    if (on !== null && typeof modelPlane(on, this.ctx.result()?.bodies ?? [], ang, off) === "string") return;
    const data = { base: this.base, axis: this.axis, offset: this.offset, angle: this.angle };
    this.close();
    this.ctx.commit((part) => {
      const existing = this.editing === null ? undefined : part.planes.find((p) => p.id === this.editing!.id);
      const plane = existing ?? { id: nextId(part, "WorkPlane"), ...data };
      Object.assign(plane, data);
      if (on !== null) plane.on = on;
      else delete plane.on;
      if (existing === undefined) part.planes.push(plane);
    });
    this.ctx.done();
  }

  cancel(): void {
    this.close();
    this.ctx.done();
  }

  private close(): void {
    this.dialog.close();
    this.ctx.view.onEdgeHover = null;
    this.ctx.view.setEdgeHighlights([], []);
    this.ctx.view.setMarkers(null, [], null);
    this.ctx.view.setPickMode("none");
    this.ctx.view.setPlanePreview(null);
  }
}

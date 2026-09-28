/**
 * MinimalCAD Web
 * view3d/commands/workPlaneCommand.ts
 *
 * Work Plane (a saved, parametric UCS), driven by a dialog: Base plane
 * (XY / XZ / YZ -- or click one in the view), Offset, Rotate about (the
 * plane's own horizontal or vertical axis), Angle -- live plane preview.
 */

import type { BasePlane, WorkPlane } from "../../part/types";
import { isBasePlane, nextId } from "../../part/types";
import { workPlaneFrame } from "../../part/plane";
import { evalExpression } from "../../part/params";
import type { Hit } from "../modelView";
import { FeatureDialog, ICONS } from "../featureDialog";
import type { ChoiceHandle } from "../featureDialog";
import type { ModelCommand, ModelContext } from "./context";

/** Human axis names of a base plane's (u, v) directions. */
export function planeAxes(base: string): [string, string] {
  const axes: Record<string, [string, string]> = { XY: ["X", "Y"], XZ: ["X", "Z"], YZ: ["Y", "Z"] };
  return axes[base] ?? ["u", "v"];
}

export class WorkPlaneCommand implements ModelCommand {
  private dialog: FeatureDialog;
  private base: BasePlane;
  private axis: "u" | "v";
  private offset: string;
  private angle: string;
  private baseChoice: ChoiceHandle<BasePlane>;
  private axisChoice!: ChoiceHandle<"u" | "v">;

  constructor(
    private ctx: ModelContext,
    private editing: WorkPlane | null,
  ) {
    this.base = editing?.base ?? "XY";
    this.axis = editing?.axis ?? "u";
    this.offset = editing?.offset ?? "0";
    this.angle = editing?.angle ?? "0";

    const d = (this.dialog = new FeatureDialog(ctx.dialogParent, editing === null ? "Work Plane" : `Edit ${editing.id}`, {
      onOk: () => this.ok(),
      onCancel: () => this.cancel(),
    }));
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
    d.number("Offset", "mm", this.offset, (t) => {
      this.offset = t;
      this.update();
    });
    this.buildAxisChoice();
    d.number("Angle", "°", this.angle, (t) => {
      this.angle = t;
      this.update();
    });
    d.hint("Like a saved UCS: move it (offset) and tilt it (angle). Sketches on it follow later edits.");

    ctx.view.setOriginPlanesVisible(true);
    ctx.view.setPickMode("plane");
    ctx.status("WORK PLANE", "Choose or click the plane to start from, set offset / angle, then OK");
    this.update();
    d.focusFirst();
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
    // The tilt choice is the second choice group: its two labels follow the base's.
    const tilt = [...labels].filter((s) => /axis$/.test(s.textContent ?? ""));
    if (tilt.length === 2) {
      tilt[0]!.textContent = `${u} axis`;
      tilt[1]!.textContent = `${v} axis`;
    }
  }

  onPick(hit: Hit): void {
    if (hit.kind === "plane" && isBasePlane(hit.key)) {
      this.base = hit.key;
      this.baseChoice.set(hit.key);
      this.relabelAxes();
      this.update();
    }
  }

  private update(): void {
    const off = evalExpression(this.offset, this.ctx.params());
    const ang = evalExpression(this.angle, this.ctx.params());
    const error = off === null ? "Offset must be a number" : ang === null ? "Angle must be a number" : null;
    this.dialog.setError(error);
    this.ctx.view.setPlanePreview(off === null || ang === null ? null : workPlaneFrame({ base: this.base, axis: this.axis }, off, ang));
    this.axisChoice.set(this.axis);
  }

  ok(): void {
    if (evalExpression(this.offset, this.ctx.params()) === null || evalExpression(this.angle, this.ctx.params()) === null) return;
    const data = { base: this.base, axis: this.axis, offset: this.offset, angle: this.angle };
    this.close();
    this.ctx.commit((part) => {
      const existing = this.editing === null ? undefined : part.planes.find((p) => p.id === this.editing!.id);
      if (existing !== undefined) Object.assign(existing, data);
      else part.planes.push({ id: nextId(part, "WorkPlane"), ...data });
    });
    this.ctx.done();
  }

  cancel(): void {
    this.close();
    this.ctx.done();
  }

  private close(): void {
    this.dialog.close();
    this.ctx.view.setPickMode("none");
    this.ctx.view.setPlanePreview(null);
  }
}

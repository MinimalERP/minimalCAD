/**
 * MinimalCAD Web
 * view3d/commands/sheetMetalCommand.ts
 *
 * Sheet Metal: click inside a sketch's blank (the flat pattern), pick the
 * material and thickness, then click the sketch's straight lines that are
 * bends. Each bend row: Up / Down, Flip (which side folds), angle. Inner
 * radius and K-factor come from the material (radius can be typed). Live
 * preview of the folded part; "Flat pattern" shows it unfolded.
 */

import type { Point } from "../../core/types";
import type { SheetBendData, SheetFeature } from "../../part/types";
import { DRAWING_SKETCH, nextId } from "../../part/types";
import { fromLocal, localTo3d, toLocal } from "../../part/plane";
import { SHEET_MATERIALS, sheetWeightKg } from "../../part/sheetMetal";
import { sheetFeatureBody, sheetValues } from "../../part/rebuild";
import { meshVolume } from "../../part/kernel/extrude";
import type { Vec3 } from "../../part/vec3";
import type { Hit, PickableRegion } from "../modelView";
import { FeatureDialog } from "../featureDialog";
import type { ChoiceHandle, FieldHandle, SelectionHandle } from "../featureDialog";
import type { ModelCommand, ModelContext } from "./context";
import { showToast } from "../../ui/toast";

const NAME = "SHEET METAL";
const fmt = (v: number, d = 2): string => `${+v.toFixed(d)}`;

export class SheetMetalCommand implements ModelCommand {
  private dialog: FeatureDialog;
  private sketchId: string | null = null;
  private material = "crca";
  private thickness = "1.5";
  private radius = "";
  private bends: SheetBendData[] = [];
  private flat = false;
  private stage: "sketch" | "bends" = "sketch";
  /** The chosen sketch's straight lines (plane-local) offered as bends. */
  private lines: [Point, Point][] = [];
  private sketchSel: SelectionHandle;
  private bendSel: SelectionHandle;
  private bendList: HTMLDivElement;
  private info: HTMLDivElement;
  private flatToggle: { set(on: boolean): void };
  private materialChoice: ChoiceHandle<string>;
  private thicknessField: FieldHandle;
  private radiusField: FieldHandle;

  static start(ctx: ModelContext, editing: SheetFeature | null): SheetMetalCommand | null {
    const r = ctx.result();
    const any = [...(r?.sketches.values() ?? [])].some((g) => g.profiles.regions.length > 0);
    if (editing === null && !any) {
      showToast("Draw the flat blank first (a closed shape, plus a line across it for each bend).");
      return null;
    }
    return new SheetMetalCommand(ctx, editing);
  }

  private constructor(
    private ctx: ModelContext,
    private editing: SheetFeature | null,
  ) {
    if (editing !== null) this.load(editing);
    const d = (this.dialog = new FeatureDialog(ctx.dialogParent, editing === null ? "Sheet Metal" : `Edit ${editing.id}`, {
      onOk: () => this.ok(),
      onCancel: () => this.cancel(),
    }));
    this.sketchSel = d.selection("Blank", "", false, () => this.setStage("sketch"));
    this.materialChoice = d.choice(
      "Material",
      SHEET_MATERIALS.map((m) => ({ value: m.key, label: m.key === "crca" ? "CRCA" : m.key === "gi" ? "GI" : m.key === "ss304" ? "SS304" : "Al", title: m.name })),
      this.material,
      (m) => {
        this.material = m;
        this.update();
      },
    );
    this.thicknessField = d.number("Thickness", "mm", this.thickness, (t) => {
      this.thickness = t;
      this.update();
    });
    this.radiusField = d.number("Inner radius", "mm", this.radius, (t) => {
      this.radius = t;
      this.update();
    });
    this.bendSel = d.selection("Bends", "", false, () => this.setStage("bends"));
    this.bendList = d.custom("sheet-bends");
    this.flatToggle = d.toggle("Flat pattern", "Show the part unfolded (the blank as cut, bend lines included)", (on) => {
      this.flat = on;
      this.update();
    });
    this.flatToggle.set(this.flat);
    this.info = d.custom("sheet-info");
    d.hint("Inner radius empty = the material's own. K-factor from DIN 6935. Click a bend line again to remove it.");
    ctx.view.setOriginPlanesVisible(false);
    ctx.view.onEdgeHover = (hit) => this.drawLines(hit?.kind === "edge" ? hit.index : null);
    this.setStage(this.sketchId === null ? "sketch" : "bends");
  }

  private load(f: SheetFeature): void {
    this.sketchId = f.sketch;
    this.material = f.material;
    this.thickness = f.thickness;
    this.radius = f.radius ?? "";
    this.bends = f.bends.map((b) => ({ ...b, line: [{ ...b.line[0] }, { ...b.line[1] }] }));
    this.flat = f.flat === true;
  }

  /** A blank that is already a sheet: edit that sheet (add its bends) rather than make a second part from it. */
  private adopt(f: SheetFeature): void {
    this.editing = f;
    this.load(f);
    this.flat = false; // here to bend it: show it folded
    this.materialChoice.set(this.material);
    this.thicknessField.set(this.thickness);
    this.radiusField.set(this.radius);
    this.flatToggle.set(this.flat);
    const title = this.dialog.el.querySelector(".fd-title");
    if (title !== null) title.textContent = `Edit ${f.id}`;
    showToast(`${f.id} is already made from this blank - adding to it (new bends go on the same part).`);
  }

  private geo() {
    return this.sketchId === null ? undefined : this.ctx.result()?.sketches.get(this.sketchId);
  }

  private setStage(stage: "sketch" | "bends"): void {
    this.stage = stage;
    const view = this.ctx.view;
    if (stage === "sketch" || this.geo() === undefined) {
      this.stage = "sketch";
      const r = this.ctx.result();
      const regions: PickableRegion[] = [];
      for (const [sketchId, g] of r?.sketches ?? []) g.profiles.regions.forEach((region, index) => regions.push({ sketchId, index, region, frame: g.frame }));
      this.ctx.showWireframes(new Set(regions.map((x) => x.sketchId)));
      view.setPickMode("region", regions);
      this.ctx.status(NAME, "Click inside the flat blank (the sketch with the bend lines)");
    } else {
      const g = this.geo()!;
      this.lines = g.lines;
      this.ctx.showWireframes(new Set([g.sketch.id]));
      // X-ray: the bend lines lie on the blank, under the part once it's made.
      view.setEdgePickMode(this.lines.map(([a, b]) => [localTo3d(g.frame, a), localTo3d(g.frame, b)]), { xray: true });
      this.ctx.status(NAME, "Click each bend line (a straight line across the blank) - set Up / Down, side and angle in the panel");
    }
    this.sketchSel.setActive(this.stage === "sketch");
    this.bendSel.setActive(this.stage === "bends");
    this.update();
  }

  onPick(hit: Hit): void {
    if (this.stage === "sketch") {
      if (hit.kind !== "region") return;
      const id = hit.region.sketchId;
      const existing = this.ctx.part().features.filter((f): f is SheetFeature => f.type === "sheet" && f.sketch === id && f.id !== this.editing?.id).pop();
      if (existing !== undefined && this.editing === null) this.adopt(existing);
      else {
        if (id !== this.sketchId) this.bends = [];
        this.sketchId = id;
      }
      this.setStage("bends");
      return;
    }
    if (hit.kind !== "edge") return;
    const line = this.lines[hit.index];
    if (line === undefined) return;
    const [a, b] = line;
    const same = (x: SheetBendData): boolean => {
      const p = toLocal(x.line[0]);
      const q = toLocal(x.line[1]);
      const near = (u: Point, v: Point): boolean => Math.hypot(u.x - v.x, u.y - v.y) < 1e-6;
      return (near(p, a) && near(q, b)) || (near(p, b) && near(q, a));
    };
    if (this.bends.some(same)) this.bends = this.bends.filter((x) => !same(x));
    else this.bends.push({ line: [fromLocal(a), fromLocal(b)], side: this.smallerSide(a, b), dir: "up", angle: "90" });
    this.update();
  }

  /** Fold the smaller side by default: the side away from the blank's centre. */
  private smallerSide(a: Point, b: Point): 1 | -1 {
    const g = this.geo();
    let cx = 0;
    let cy = 0;
    let n = 0;
    for (const r of g?.profiles.regions ?? []) for (const p of r.outer.polygon) [cx, cy, n] = [cx + p.x, cy + p.y, n + 1];
    if (n === 0) return 1;
    const left = (b.x - a.x) * (cy / n - a.y) - (b.y - a.y) * (cx / n - a.x) > 0;
    return left ? -1 : 1;
  }

  private drawLines(hover: number | null): void {
    const g = this.geo();
    if (g === undefined || this.stage !== "bends") {
      this.ctx.view.setEdgeHighlights([], []);
      return;
    }
    const to3 = (p: Point): Vec3 => localTo3d(g.frame, p);
    this.ctx.view.setEdgeHighlights(
      this.bends.map((b) => [to3(toLocal(b.line[0])), to3(toLocal(b.line[1]))]),
      hover === null || this.lines[hover] === undefined ? [] : [this.lines[hover]!.map(to3)],
    );
  }

  private feature(): SheetFeature | null {
    if (this.sketchId === null) return null;
    const f: SheetFeature = {
      id: this.editing?.id ?? "SheetPreview",
      type: "sheet",
      sketch: this.sketchId,
      profiles: "all",
      material: this.material,
      thickness: this.thickness,
      bends: this.bends.map((b) => ({ ...b })),
    };
    if (this.radius.trim() !== "") f.radius = this.radius;
    if (this.flat) f.flat = true;
    return f;
  }

  private renderBends(): void {
    this.bendList.replaceChildren();
    this.bends.forEach((b, i) => {
      const row = document.createElement("div");
      row.className = "sheet-bend-row";
      const name = document.createElement("span");
      name.textContent = `Bend ${i + 1}`;
      const btn = (label: string, title: string, active: boolean, on: () => void): HTMLButtonElement => {
        const x = document.createElement("button");
        x.className = "fd-small-btn" + (active ? " active" : "");
        x.textContent = label;
        x.title = title;
        x.addEventListener("mousedown", (e) => e.preventDefault());
        x.addEventListener("click", () => {
          on();
          this.update();
        });
        return x;
      };
      const angle = document.createElement("input");
      angle.className = "sheet-angle";
      angle.value = b.angle;
      angle.title = "Bend angle (degrees; 90 = square)";
      angle.addEventListener("input", () => {
        b.angle = angle.value.trim() === "" ? "90" : angle.value.trim();
        this.update(false);
      });
      angle.addEventListener("keydown", (e) => e.stopPropagation());
      const deg = document.createElement("span");
      deg.textContent = "°";
      row.append(
        name,
        btn("Up", "Fold toward the sketch's front", b.dir === "up", () => (b.dir = "up")),
        btn("Down", "Fold toward the sketch's back", b.dir === "down", () => (b.dir = "down")),
        btn("Flip", "Swap which side folds (the other stays as the base)", false, () => (b.side = b.side === 1 ? -1 : 1)),
        angle,
        deg,
        btn("✕", "Remove this bend", false, () => this.bends.splice(i, 1)),
      );
      this.bendList.appendChild(row);
    });
  }

  /** Recompute the preview; `rows` false keeps the bend rows (typing an angle). */
  private update(rows = true): void {
    const n = this.bends.length;
    this.sketchSel.set(this.sketchId === null ? "Click inside the blank" : this.sketchId === DRAWING_SKETCH ? "2D Drawing" : this.sketchId, this.sketchId !== null);
    this.bendSel.set(n === 0 ? "Click bend lines" : `${n} bend${n === 1 ? "" : "s"}`, n > 0);
    if (rows) this.renderBends();
    this.drawLines(null);
    const f = this.feature();
    const g = this.geo();
    let error: string | null = null;
    let info = "";
    if (f === null || g === undefined) error = "Click inside the flat blank";
    else {
      const v = sheetValues(f, this.ctx.params());
      const made = sheetFeatureBody(f, g, this.ctx.params());
      if (typeof made === "string") {
        error = made;
        this.ctx.view.setPreview(null);
      } else {
        this.ctx.view.setPreview(made.body);
        const kg = sheetWeightKg(meshVolume(made.body.mesh.positions, made.body.mesh.indices), made.values.density);
        info = `Inner R ${fmt(made.values.radius)} mm · K ${fmt(made.values.k, 3)} · ${kg < 1 ? `${fmt(kg * 1000, 0)} g` : `${fmt(kg, 2)} kg`}`;
      }
      if (typeof v === "string") error = v;
    }
    if (error !== null) this.ctx.view.setPreview(null);
    this.info.textContent = info;
    this.dialog.setError(error);
  }

  ok(): void {
    this.update();
    const f = this.feature();
    const g = this.geo();
    if (f === null || g === undefined || typeof sheetFeatureBody(f, g, this.ctx.params()) === "string") return;
    this.close();
    this.ctx.commit((part) => {
      if (this.editing !== null) {
        const i = part.features.findIndex((x) => x.id === this.editing!.id);
        if (i >= 0) part.features[i] = { ...f, id: this.editing.id };
        return;
      }
      part.features.push({ ...f, id: nextId(part, "Sheet") });
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
    this.ctx.view.setPickMode("none");
    this.ctx.view.setPreview(null);
  }
}

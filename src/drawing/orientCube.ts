/**
 * MinimalCAD Web
 * drawing/orientCube.ts
 *
 * A small view cube for the Base View / Edit View dialogs: shows the part's
 * orientation as a labelled cube (seen from the chosen side, tilted a little
 * so its neighbours show), and changes it:
 *
 *  - click a face            look at that side
 *  - arrows (up/down/l/r)    tumble 90 deg to the next side
 *  - roll buttons            turn the view 90 deg on the paper
 *  - Iso                     iso from the upper-right corner (again = back)
 *
 * Every square-on orientation (6 sides x 4 turns) is reachable. The chosen
 * one becomes the drawing's FRONT (main) view.
 */

import type { Vec3 } from "../part/vec3";
import { add, cross, dot, normalize, scale } from "../part/vec3";
import { axesOf } from "./sheet";

export interface Orient {
  dir: Vec3;
  up: Vec3;
}

const FACES: { n: Vec3; label: string }[] = [
  { n: { x: 0, y: -1, z: 0 }, label: "FRONT" },
  { n: { x: 0, y: 1, z: 0 }, label: "BACK" },
  { n: { x: 0, y: 0, z: 1 }, label: "TOP" },
  { n: { x: 0, y: 0, z: -1 }, label: "BOTTOM" },
  { n: { x: 1, y: 0, z: 0 }, label: "RIGHT" },
  { n: { x: -1, y: 0, z: 0 }, label: "LEFT" },
];

const snap = (v: Vec3): Vec3 => ({ x: Math.round(v.x * 1e9) / 1e9, y: Math.round(v.y * 1e9) / 1e9, z: Math.round(v.z * 1e9) / 1e9 });

/** Tumbles / rolls an orientation (see the header). */
export function turn(o: Orient, how: "left" | "right" | "up" | "down" | "cw" | "ccw"): Orient {
  const a = axesOf(o);
  if (how === "right") return { dir: snap(a.right), up: snap(a.up) };
  if (how === "left") return { dir: snap(scale(a.right, -1)), up: snap(a.up) };
  if (how === "up") return { dir: snap(a.up), up: snap(scale(a.dir, -1)) };
  if (how === "down") return { dir: snap(scale(a.up, -1)), up: snap(a.dir) };
  // Image turned clockwise: what was on the left is now on top.
  if (how === "cw") return { dir: snap(a.dir), up: snap(scale(a.right, -1)) };
  return { dir: snap(a.dir), up: snap(a.right) };
}

/** Looks straight at a cube face, keeping "up" if it still can. */
export function faceOn(o: Orient, n: Vec3): Orient {
  const a = axesOf(o);
  let up = a.up;
  if (Math.abs(dot(up, n)) > 0.9) up = Math.abs(dot(a.dir, n)) > 0.9 ? a.up : dot(up, n) > 0 ? scale(a.dir, -1) : a.dir;
  // Square the up direction to the face's plane (orientations stay exact).
  const u = normalize(add(up, scale(n, -dot(up, n))));
  return { dir: snap(n), up: snap(u) };
}

export function isIso(o: Orient): boolean {
  const d = normalize(o.dir);
  return Math.abs(d.x) > 1e-6 && Math.abs(d.y) > 1e-6 && Math.abs(d.z) > 1e-6;
}

/** Builds the cube into `host`; returns a setter for outside changes. */
export function orientationCube(host: HTMLElement, initial: Orient, onChange: (o: Orient) => void): { set(o: Orient): void } {
  let cur = initial;
  // The last square-on orientation, for toggling Iso back off.
  let square = isIso(initial) ? { dir: { x: 0, y: -1, z: 0 }, up: { x: 0, y: 0, z: 1 } } : initial;
  host.classList.add("orient-cube");

  const grid = document.createElement("div");
  grid.className = "oc-grid";
  const btn = (text: string, title: string, cls: string, fn: () => void): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.title = title;
    b.className = `oc-btn ${cls}`;
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", fn);
    grid.appendChild(b);
    return b;
  };
  const canvas = document.createElement("canvas");
  const SIZE = 112;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = SIZE * dpr;
  canvas.height = SIZE * dpr;
  canvas.style.width = `${SIZE}px`;
  canvas.style.height = `${SIZE}px`;
  canvas.className = "oc-canvas";
  canvas.title = "Click a face to look at it";

  const set = (o: Orient, fire = true): void => {
    cur = o;
    if (!isIso(o)) square = o;
    draw();
    if (fire) onChange(o);
  };
  const tumble = (how: Parameters<typeof turn>[1]): void => set(turn(isIso(cur) ? square : cur, how));

  btn("⟲", "Turn the view 90° anticlockwise on the paper", "oc-ccw", () => tumble("ccw"));
  btn("▲", "Tumble: show the side above", "oc-up", () => tumble("up"));
  btn("⟳", "Turn the view 90° clockwise on the paper", "oc-cw", () => tumble("cw"));
  btn("◀", "Tumble: show the side on the left", "oc-left", () => tumble("left"));
  grid.appendChild(canvas);
  btn("▶", "Tumble: show the side on the right", "oc-right", () => tumble("right"));
  const isoBtn = btn("Iso", "Iso from the upper-right corner (click again: back to square-on)", "oc-iso", () => {
    if (isIso(cur)) set(square);
    else {
      const a = axesOf(cur);
      set({ dir: normalize(add(add(a.dir, a.right), a.up)), up: a.up });
    }
  });
  btn("▼", "Tumble: show the side below", "oc-down", () => tumble("down"));
  host.appendChild(grid);

  // --- drawing the cube (and picking its faces) ---
  type Drawn = { pts: [number, number][]; face: (typeof FACES)[number] };
  let drawn: Drawn[] = [];
  function draw(): void {
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, SIZE, SIZE);
    // Seen from the chosen side, tilted a little towards upper right so the
    // neighbouring sides show (the view itself is square-on).
    const a = axesOf(cur);
    const tilt = isIso(cur) ? a : axesOf({ dir: normalize(add(add(a.dir, scale(a.right, 0.32)), scale(a.up, 0.26))), up: a.up });
    const k = SIZE * 0.25;
    const P = (v: Vec3): [number, number] => [SIZE / 2 + dot(v, tilt.right) * k, SIZE / 2 - dot(v, tilt.up) * k];
    drawn = [];
    const faces = FACES.map((f) => ({ f, facing: dot(f.n, tilt.dir) })).filter((x) => x.facing > 1e-6);
    faces.sort((p, q) => p.facing - q.facing);
    for (const { f, facing } of faces) {
      // Face square: n + two in-plane axes.
      const e1 = Math.abs(f.n.z) > 0.5 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 0, z: 1 };
      const e2 = cross(f.n, e1);
      const c = f.n;
      const corners = [
        add(c, add(e1, e2)),
        add(c, add(e1, scale(e2, -1))),
        add(c, add(scale(e1, -1), scale(e2, -1))),
        add(c, add(scale(e1, -1), e2)),
      ].map(P);
      const main = dot(f.n, a.dir) > 1 - 1e-9;
      ctx.beginPath();
      corners.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      ctx.closePath();
      const l = Math.round(60 + 70 * facing);
      ctx.fillStyle = main ? "#2f6db3" : `rgb(${l}, ${l + 4}, ${l + 10})`;
      ctx.fill();
      ctx.strokeStyle = "#c8c8c8";
      ctx.lineWidth = 1;
      ctx.stroke();
      // Label, turned with the face's own "up" so a rolled view reads rolled.
      const mid = P(c);
      const upOnFace = Math.abs(dot(a.up, f.n)) < 0.9 ? normalize(add(a.up, scale(f.n, -dot(a.up, f.n)))) : e2;
      const tip = P(add(c, scale(upOnFace, 0.5)));
      const ang = Math.atan2(tip[0] - mid[0], -(tip[1] - mid[1]));
      ctx.save();
      ctx.translate(mid[0], mid[1]);
      ctx.rotate(ang);
      ctx.fillStyle = "#ffffff";
      ctx.font = `bold ${facing > 0.6 ? 10 : 8}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      // Narrow side faces are too thin for a word: only the main face and
      // faces seen fairly square get their name.
      if (main || facing > 0.5) ctx.fillText(f.label, 0, 0);
      ctx.restore();
      drawn.push({ pts: corners as [number, number][], face: f });
    }
    isoBtn.classList.toggle("active", isIso(cur));
  }
  canvas.addEventListener("mousedown", (e) => e.preventDefault());
  canvas.addEventListener("click", (e) => {
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    // Front-most face under the pointer (drawn last = nearest).
    for (let i = drawn.length - 1; i >= 0; i--) {
      if (inside(drawn[i]!.pts, x, y)) {
        set(faceOn(isIso(cur) ? square : cur, drawn[i]!.face.n));
        return;
      }
    }
  });
  draw();
  return { set: (o) => set(o, false) };
}

function inside(poly: [number, number][], x: number, y: number): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/**
 * MinimalCAD Web
 * view3d/modelView.ts
 *
 * Render layer for the 3D workspace (three.js, loaded lazily with the rest
 * of view3d/ on the first switch to 3D -- the 2D app never downloads it).
 *
 * Pure display + picking: it is handed kernel Bodies and sketch geometry
 * and draws them; it never owns or mutates the parametric model. The
 * camera is orthographic (CAD-style: no perspective distortion, sizes read
 * true in the standard views).
 */

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { triangulate } from "../part/kernel/triangulate";
import { ViewCube } from "./viewCube";
import type { Body, Edge, TopoRef } from "../part/kernel/types";
import { planeRef } from "../part/kernel/types";
import type { Frame } from "../part/plane";
import { faceFrame, localTo3d, planeFrame } from "../part/plane";
import { edgesOnFace } from "../part/faceTopology";
import type { FaceSnap } from "../part/faceTopology";
import { dot, sub } from "../part/vec3";
import type { Vec3 } from "../part/vec3";
import type { Surface } from "../part/cylFrame";
import { cylFromWorld, roundFrame, surfaceSegment, surfaceTo3d } from "../part/cylFrame";
import type { Region } from "../part/profile";
import type { Point } from "../core/types";

export type StandardView = "front" | "top" | "right" | "iso";

const VIEW_NAMES: Record<StandardView, string> = {
  front: "Front",
  top: "Top",
  right: "Right",
  iso: "SE Isometric",
};

const BG = 0x1e1e1e; // same as the 2D canvas, so 2D <-> 3D feels like one space
const GRID_MINOR = 0x2a2a2a;
const GRID_MAJOR = 0x363636;
const AXIS_X = 0xb03a3a;
const AXIS_Y = 0x3a9a3a;
const BODY_COLOR = 0xc3cad4;
const EDGE_COLOR = 0x0b0b0b;
const SKETCH_COLOR = 0xf0f0f0;
const PLANE_COLOR = 0xe8b04a;
const WORKPLANE_COLOR = 0x6fcf97;
const REGION_COLOR = 0x3d8bfd;
const PREVIEW_COLOR = 0x5fa8ff;
const CUT_PREVIEW_COLOR = 0xff5a5a;

export interface PickableRegion {
  sketchId: string;
  index: number;
  region: Region;
  frame: Frame;
}

/** A pickable plane: origin XY/XZ/YZ, or a work plane (by id). */
export interface PlaneDisplay {
  key: string;
  frame: Frame;
  /** A plane hinged on a model edge: the middle of the edge. The square is
   *  then drawn rising from the hinge instead of round the frame's origin. */
  hingeAt?: Vec3;
  /** A plane tangent to a round face: the square is centred here. */
  centerAt?: Vec3;
}

export type Hit =
  | { kind: "plane"; key: string }
  /** A flat face of a solid (sketch-on-face). */
  | { kind: "face"; ref: TopoRef; body: Body; faceId: number; /** Where it was clicked (edge-pick mode). */ at?: Vec3 }
  | { kind: "region"; region: PickableRegion }
  /** A point on the active face (plane-local coords), possibly osnapped. */
  | { kind: "facePoint"; point: Point; snap: string | null }
  /** A point ON a flat face of a solid (whichever face is under the cursor),
   *  in that face's coords, osnapped to the face's own edges/centres -- or
   *  on the OUTSIDE of a round face, in its (along axis, angle) coords. */
  | { kind: "surfacePoint"; ref: TopoRef; body: Body; faceId: number; frame: Surface; point: Point; raw: Point; snap: string | null }
  /** Edge picking (Fillet / Chamfer): candidate edge `index` (visible, near
   *  the cursor on screen). */
  | { kind: "edge"; index: number }
  /** 3D Line: the cursor ray, the osnap point under it (if any), and where
   *  the ray first meets the solid (if it does). */
  | { kind: "point3d"; ray: { o: Vec3; d: Vec3 }; snap: { p: Vec3; kind: string } | null; at: Vec3 | null };

/** An osnap candidate on the active face, in its plane-local coords. */
export interface SnapCandidate {
  point: Point;
  kind: string;
}

const SNAP_PX = 12;

/** Stand-in for "no solid": a click that landed on a work plane. */
const NO_BODY: Body = {
  id: "",
  feature: "",
  mesh: { positions: new Float64Array(0), normals: new Float64Array(0), indices: new Uint32Array(0), faceIds: new Uint32Array(0) },
  faces: [],
  edges: [],
};

function v3(p: { x: number; y: number; z: number }): THREE.Vector3 {
  return new THREE.Vector3(p.x, p.y, p.z);
}

/** Analytic edge -> polyline points (arcs sampled finely: display only). */
/** A face's own triangles as a translucent overlay mesh. */
function faceMesh(body: Body, faceId: number, color: number, opacity: number): THREE.Mesh {
  const { positions, indices, faceIds } = body.mesh;
  const tri: number[] = [];
  for (let t = 0; t < faceIds.length; t++) {
    if (faceIds[t] !== faceId) continue;
    for (let k = 0; k < 3; k++) {
      const i = indices[t * 3 + k]!;
      tri.push(positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(tri, 3));
  return new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
  );
}

/** An edge as world points along it (display, picking). */
export function edgePolyline(edge: Edge): Vec3[] {
  return edgePoints(edge).map((p) => ({ x: p.x, y: p.y, z: p.z }));
}

function edgePoints(edge: Edge): THREE.Vector3[] {
  const g = edge.geom;
  if (g.kind === "line") return [v3(g.a), v3(g.b)];
  if (g.kind === "polyline") return g.pts.map(v3);
  const center = v3(g.center);
  const e1 = v3(g.start).sub(center).normalize();
  const n = v3(g.normal).normalize();
  const e2 = new THREE.Vector3().crossVectors(n, e1);
  const steps = Math.max(8, Math.ceil((Math.abs(g.sweep) / (2 * Math.PI)) * 96));
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = (g.sweep * i) / steps;
    pts.push(
      center
        .clone()
        .addScaledVector(e1, Math.cos(t) * g.radius)
        .addScaledVector(e2, Math.sin(t) * g.radius),
    );
  }
  return pts;
}

function segmentsGeometry(polylines: THREE.Vector3[][]): THREE.BufferGeometry {
  const arr: number[] = [];
  for (const pts of polylines) {
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      arr.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3));
  return geo;
}

function bodyGeometry(body: Body): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  // GPU wants float32; the kernel keeps float64.
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(body.mesh.positions), 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(body.mesh.normals), 3));
  geo.setIndex(new THREE.BufferAttribute(body.mesh.indices, 1));
  geo.computeBoundingSphere();
  return geo;
}

function regionGeometry(region: Region, frame: Frame): THREE.BufferGeometry {
  const flat: number[] = [];
  const holes: number[] = [];
  const pts: Point[] = [];
  [region.outer, ...region.holes].forEach((loop, i) => {
    if (i > 0) holes.push(pts.length);
    for (const p of loop.polygon) {
      flat.push(p.x, p.y);
      pts.push(p);
    }
  });
  const tris = triangulate(flat, holes);
  const pos: number[] = [];
  for (const p of pts) {
    const w = localTo3d(frame, p, 0);
    pos.push(w.x, w.y, w.z);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(tris);
  geo.computeVertexNormals();
  return geo;
}

export class ModelView {
  readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.OrthographicCamera;
  private controls: OrbitControls;
  private raycaster = new THREE.Raycaster();

  private contentGroup = new THREE.Group(); // bodies + edges
  private sketchGroup = new THREE.Group(); // wireframes
  private regionGroup = new THREE.Group(); // pickable profile fills
  private previewGroup = new THREE.Group();
  private originGroup = new THREE.Group();
  private gridGroup = new THREE.Group();
  private ucsIcon = new THREE.Group();
  private viewCube: ViewCube;
  private viewLabel: HTMLDivElement;
  private workPlaneGroup = new THREE.Group();
  private planeMeshes = new Map<string, THREE.Mesh>();
  private originPlanesVisible = true;
  private workPlanes: PlaneDisplay[] = [];
  private regionMeshes: { mesh: THREE.Mesh; region: PickableRegion }[] = [];
  private bodyMeshes: THREE.Mesh[] = [];
  private faceHighlight = new THREE.Group();
  /** Faces kept lit while a command runs (Measure's picked faces). */
  private pinnedFaces = new THREE.Group();
  private highlightedFaceKey: string | null = null;

  private pickMode: "none" | "plane" | "region" | "facePoint" | "surfacePoint" | "edge" | "point3d" = "none";
  /** point3d mode: osnap candidates (world points). */
  private snap3d: { p: Vec3; kind: string }[] = [];
  /** Edge-pick candidates (world polylines). */
  private edgeCandidates: Vec3[][] = [];
  private edgeGroup = new THREE.Group();
  private faceFrame: Frame | null = null;
  private snapCandidates: SnapCandidate[] = [];
  private markerGroup = new THREE.Group();
  /** On-model dimensions (e.g. hole positions): lines here, values as HTML labels. */
  private dimGroup = new THREE.Group();
  private dimLayer: HTMLDivElement;
  private dimFrame: Surface | null = null;
  private dimLabels: { id: string; at: Point; el: HTMLDivElement }[] = [];
  /** The value box currently open on a dimension (survives re-draws). */
  private dimEdit: { id: string; input: HTMLInputElement; finish: (ok: boolean) => void } | null = null;
  /** A dimension's value was clicked (to edit it / select it). */
  onDimClick: ((id: string) => void) | null = null;
  private hovered: Hit | null = null;
  private selectedRegions = new Set<PickableRegion>();
  private planeSize = 60;
  private renderScheduled = false;
  private downPos: { x: number; y: number } | null = null;
  private orbiting = false;
  private lastPolar = 0;
  private lastAzimuth = 0;

  /** Called on a click (not an orbit drag) that hit something pickable. */
  onPick: ((hit: Hit) => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    // High-DPI displays can otherwise multiply the first WebGL frame by 4x
    // or more. 1.5x keeps the CAD edges crisp while reducing startup/GPU cost.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.scene.background = new THREE.Color(BG);

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100000);
    // Z-up world, like AutoCAD (the 2D drawing is the XY ground plane). Must
    // be set before OrbitControls is created -- it captures `up` once.
    this.camera.up.set(0, 0, 1);
    this.scene.add(this.camera);
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(0.5, 0.8, 1);
    this.camera.add(key); // headlight: lighting follows the view
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x404048, 1.4));

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = false;
    this.controls.zoomToCursor = true;
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    this.controls.addEventListener("change", () => this.requestRender());
    // Any manual orbit turns the named view into a custom one, as in AutoCAD.
    this.controls.addEventListener("start", () => {
      this.orbiting = true;
    });
    this.controls.addEventListener("end", () => {
      this.orbiting = false;
    });
    this.controls.addEventListener("change", () => {
      const polar = this.controls.getPolarAngle();
      const azimuth = this.controls.getAzimuthalAngle();
      // Zoom/pan keep the named view; only a real rotation makes it custom.
      if (this.orbiting && (Math.abs(polar - this.lastPolar) > 1e-4 || Math.abs(azimuth - this.lastAzimuth) > 1e-4)) {
        this.setViewName("Custom View");
      }
      this.lastPolar = polar;
      this.lastAzimuth = azimuth;
    });

    const parent = canvas.parentElement!;
    this.viewLabel = document.createElement("div");
    this.viewLabel.className = "v3d-overlay view-label";
    parent.appendChild(this.viewLabel);
    this.dimLayer = document.createElement("div");
    this.dimLayer.className = "v3d-overlay dim-layer";
    parent.appendChild(this.dimLayer);
    this.viewCube = new ViewCube(parent);
    this.viewCube.onPick = (dir) => {
      this.frame(dir);
      this.setViewName(namedDirection(dir));
    };
    this.viewCube.onHome = () => this.setView("iso");
    this.viewCube.onOrbit = (az, el) => this.orbitBy(az, el);

    this.scene.add(
      this.edgeGroup,
      this.markerGroup,
      this.dimGroup,
      this.faceHighlight,
      this.pinnedFaces,
      this.gridGroup,
      this.ucsIcon,
      this.originGroup,
      this.workPlaneGroup,
      this.contentGroup,
      this.sketchGroup,
      this.regionGroup,
      this.previewGroup,
    );
    this.buildOrigin();

    new ResizeObserver(() => this.resize()).observe(canvas);
    canvas.addEventListener("pointerdown", (e) => {
      this.downPos = { x: e.clientX, y: e.clientY };
    });
    canvas.addEventListener("pointermove", (e) => this.onHover(e));
    canvas.addEventListener("pointerup", (e) => {
      const down = this.downPos;
      this.downPos = null;
      if (down === null || e.button !== 0) return;
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return; // was an orbit drag
      const hit = this.pick(e);
      if (hit !== null) this.onPick?.(hit);
    });

    // Double-clicking a work plane sketches on it directly (no command needed).
    canvas.addEventListener("dblclick", (e) => {
      const rect = this.canvas.getBoundingClientRect();
      this.raycaster.setFromCamera(
        new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1),
        this.camera,
      );
      const hit = this.raycaster.intersectObjects(this.workPlaneGroup.children, false)[0];
      if (hit !== undefined) this.onPlaneDoubleClick?.(hit.object.userData.key as string);
    });

    this.resize();
    this.setView("iso");
    // Dev-only handle for poking at the live view from the browser console.
    if (import.meta.env.DEV) (window as unknown as { __modelView?: ModelView }).__modelView = this;
  }

  onPlaneDoubleClick: ((key: string) => void) | null = null;

  // --- origin planes & axes ---

  /** Translucent square for a plane frame: centered on its origin, or --
   *  `corner` -- spanning its positive quadrant, so the three origin planes
   *  meet at the UCS like the corner of a room. */
  private planeMesh(key: string, frame: Frame, color: number, corner = false, size = this.planeSize, hingeAt?: Vec3, centerAt?: Vec3): THREE.Mesh {
    const [a, b] = corner ? [0, size] : [-size / 2, size / 2];
    // Hinged: centred on the hinge's middle sideways, rising from it.
    // Tangent: centred on its own point.
    const h = hingeAt === undefined ? null : sub(hingeAt, frame.origin);
    const c = centerAt === undefined ? null : sub(centerAt, frame.origin);
    const [cx, y0] = h !== null ? [dot(h, frame.u), dot(h, frame.v)] : c !== null ? [dot(c, frame.u), dot(c, frame.v) + a] : [0, a];
    const corners = [
      { x: cx + a, y: y0 },
      { x: cx + b, y: y0 },
      { x: cx + b, y: y0 + (b - a) },
      { x: cx + a, y: y0 + (b - a) },
    ].map((p) => v3(localTo3d(frame, p)));
    const geo = new THREE.BufferGeometry().setFromPoints(corners);
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.06, side: THREE.DoubleSide, depthWrite: false }),
    );
    mesh.userData.key = key;
    mesh.add(
      new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(corners),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.45 }),
      ),
    );
    return mesh;
  }

  private buildOrigin(): void {
    disposeChildren(this.originGroup);
    for (const key of [...this.planeMeshes.keys()]) if (!key.startsWith("wp:")) this.planeMeshes.delete(key);
    for (const base of ["XY", "XZ", "YZ"] as const) {
      // Unit size: originGroup is rescaled every frame to a constant on-screen size.
      const mesh = this.planeMesh(base, planeFrame({ base, offset: 0 }), PLANE_COLOR, true, 1);
      mesh.visible = this.originPlanesVisible;
      this.planeMeshes.set(base, mesh);
      this.originGroup.add(mesh);
    }
    this.buildGrid();
    this.styleHover();
  }

  /** AutoCAD-style ground grid on XY, with red X / green Y axis lines
   *  running through the origin across the whole grid. */
  private buildGrid(): void {
    disposeChildren(this.gridGroup);
    const extent = Math.max(200, this.planeSize * 8);
    const step = extent > 2000 ? 100 : extent > 400 ? 10 : 5;
    const half = Math.ceil(extent / 2 / (step * 10)) * step * 10;
    const minor: number[] = [];
    const major: number[] = [];
    for (let v = -half; v <= half + 1e-9; v += step) {
      if (Math.abs(v) < 1e-9) continue; // axis lines drawn separately
      const target = Math.round(v / step) % 10 === 0 ? major : minor;
      target.push(v, -half, 0, v, half, 0, -half, v, 0, half, v, 0);
    }
    const lines = (arr: number[], color: number): THREE.LineSegments => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3));
      return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color }));
    };
    this.gridGroup.add(lines(minor, GRID_MINOR), lines(major, GRID_MAJOR));
    this.gridGroup.add(lines([-half, 0, 0, half, 0, 0], AXIS_X), lines([0, -half, 0, 0, half, 0], AXIS_Y));
    // Grid sits a hair below Z=0 so 2D geometry on the ground always wins.
    this.gridGroup.position.z = -0.01;
    this.buildUcsIcon();
  }

  /** X/Y/Z tripod at the origin, kept a constant size on screen (render()). */
  private buildUcsIcon(): void {
    disposeChildren(this.ucsIcon);
    const axes: [THREE.Vector3, string][] = [
      [new THREE.Vector3(1, 0, 0), "X"],
      [new THREE.Vector3(0, 1, 0), "Y"],
      [new THREE.Vector3(0, 0, 1), "Z"],
    ];
    const mat = new THREE.LineBasicMaterial({ color: 0xe0e0e0, depthTest: false });
    for (const [dir, label] of axes) {
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), dir]), mat);
      line.renderOrder = 10;
      this.ucsIcon.add(line);
      this.ucsIcon.add(textSprite(label, dir.clone().multiplyScalar(1.22)));
    }
    const box = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-0.06, -0.06, 0),
        new THREE.Vector3(0.06, -0.06, 0),
        new THREE.Vector3(0.06, 0.06, 0),
        new THREE.Vector3(-0.06, 0.06, 0),
      ]),
      mat,
    );
    this.ucsIcon.add(box);
  }

  private setViewName(name: string): void {

    this.viewLabel.textContent = `[-][${name}][Shaded with Edges]`;
  }

  setOriginPlanesVisible(visible: boolean): void {
    this.originPlanesVisible = visible;
    for (const base of ["XY", "XZ", "YZ"]) {
      const mesh = this.planeMeshes.get(base);
      if (mesh !== undefined) mesh.visible = visible;
    }
    this.requestRender();
  }

  /** Work planes are always shown (and pickable for New Sketch), keyed by id. */
  setWorkPlanes(planes: readonly PlaneDisplay[]): void {
    this.workPlanes = planes.slice();
    disposeChildren(this.workPlaneGroup);
    for (const key of [...this.planeMeshes.keys()]) if (key.startsWith("wp:")) this.planeMeshes.delete(key);
    for (const p of planes) {
      const mesh = this.planeMesh(p.key, p.frame, WORKPLANE_COLOR, false, this.planeSize, p.hingeAt, p.centerAt);
      this.planeMeshes.set(`wp:${p.key}`, mesh);
      this.workPlaneGroup.add(mesh);
    }
    this.styleHover();
  }

  /** Live preview of a work plane being defined (null clears). */
  setPlanePreview(frame: Frame | null, hingeAt?: Vec3, centerAt?: Vec3): void {
    const old = this.previewGroup.children.find((c) => c.userData.key === "__planePreview");
    if (old !== undefined) {
      disposeChildren(old);
      this.previewGroup.remove(old);
    }
    if (frame !== null) {
      const mesh = this.planeMesh("__planePreview", frame, WORKPLANE_COLOR, false, this.planeSize, hingeAt, centerAt);
      (mesh.material as THREE.MeshBasicMaterial).opacity = 0.3;
      this.previewGroup.add(mesh);
    }
    this.requestRender();
  }

  // --- content ---

  setBodies(bodies: readonly Body[]): void {
    this.highlightedFaceKey = null;
    disposeChildren(this.faceHighlight);
    disposeChildren(this.contentGroup);
    this.snapCache.clear();
    this.bodyMeshes = [];
    for (const body of bodies) {
      const mesh = new THREE.Mesh(
        bodyGeometry(body),
        new THREE.MeshStandardMaterial({
          color: BODY_COLOR,
          metalness: 0.15,
          roughness: 0.55,
          polygonOffset: true,
          polygonOffsetFactor: 1,
          polygonOffsetUnits: 1,
        }),
      );
      mesh.userData.body = body;
      this.bodyMeshes.push(mesh);
      this.contentGroup.add(mesh);
      this.contentGroup.add(
        new THREE.LineSegments(
          segmentsGeometry(body.edges.map(edgePoints)),
          new THREE.LineBasicMaterial({ color: EDGE_COLOR }),
        ),
      );
    }
    this.requestRender();
  }

  /** Visible sketch wireframes, in plane-local polylines + their frame. */
  setSketches(sketches: readonly { frame: Frame; polylines: Point[][] }[]): void {
    disposeChildren(this.sketchGroup);
    for (const { frame, polylines } of sketches) {
      this.sketchGroup.add(
        new THREE.LineSegments(
          segmentsGeometry(polylines.map((pl) => pl.map((p) => v3(localTo3d(frame, p))))),
          new THREE.LineBasicMaterial({ color: SKETCH_COLOR }),
        ),
      );
    }
    this.requestRender();
  }

  /** Tool preview: blue for new/join, red for a cut. */
  setPreview(bodyOrBodies: Body | readonly Body[] | null, cut = false): void {
    disposeChildren(this.previewGroup);
    const list = bodyOrBodies === null ? [] : Array.isArray(bodyOrBodies) ? bodyOrBodies : [bodyOrBodies as Body];
    for (const body of list) {
      this.previewGroup.add(
        new THREE.Mesh(
          bodyGeometry(body),
          new THREE.MeshStandardMaterial({
            color: cut ? CUT_PREVIEW_COLOR : PREVIEW_COLOR,
            transparent: true,
            opacity: 0.55,
            depthWrite: false,
          }),
        ),
      );
      this.previewGroup.add(
        new THREE.LineSegments(
          segmentsGeometry(body.edges.map(edgePoints)),
          new THREE.LineBasicMaterial({ color: 0x9cc8ff }),
        ),
      );
    }
    this.requestRender();
  }

  // --- picking ---

  /** Face-point picking (Hole centres): clicks on `frame`'s face, snapping
   *  to `candidates` within SNAP_PX on screen (AutoCAD-style osnap). */
  setFacePointMode(frame: Frame, candidates: readonly SnapCandidate[]): void {
    this.setPickMode("none");
    this.pickMode = "facePoint";
    this.faceFrame = frame;
    this.snapCandidates = candidates.slice();
  }

  /** World units per screen pixel (ortho camera). */
  pixelSize(): number {
    return 1 / this.camera.zoom;
  }

  /** Screen pixels per face unit along x and along y at face point `p` --
   *  small on a face seen at a slant, so pick distances can be measured
   *  on screen, where the user sees them. */
  pxPerUnit(s: Surface, p: Point): Point {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const at = (q: Point): Point => {
      const v = v3(surfaceTo3d(s, q)).project(this.camera);
      return { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h };
    };
    const o = at(p);
    const step = 1e-3;
    const ax = at({ x: p.x + step, y: p.y });
    const ay = at({ x: p.x, y: p.y + step });
    const dxx = ax.x - o.x;
    const dxy = ax.y - o.y;
    const dyx = ay.x - o.x;
    const dyy = ay.y - o.y;
    return { x: Math.sqrt(dxx * dxx + dxy * dxy) / step, y: Math.sqrt(dyx * dyx + dyy * dyy) / step };
  }

  /** Highlighted segments on a face (picked / hovered edges), in yellow. */
  /**
   * On-model dimensions on a face: `segs` are the extension/dimension lines
   * and arrowheads (face coords), each with a clickable value label.
   * Pass an empty list (or null frame) to clear.
   */
  setDimensions(
    frame: Surface | null,
    dims: readonly { id: string; segs: [Point, Point][]; labelAt: Point; text: string; selected: boolean }[],
  ): void {
    disposeChildren(this.dimGroup);
    this.dimLayer.innerHTML = "";
    this.dimLabels = [];
    this.dimFrame = frame;
    if (frame === null) {
      this.requestRender();
      return;
    }
    const hadFocus = this.dimEdit !== null && document.activeElement === this.dimEdit.input;
    for (const d of dims) {
      const lines = new THREE.LineSegments(
        segmentsGeometry(d.segs.map(([a, b]) => surfaceSegment(frame, a, b).map(v3))),
        new THREE.LineBasicMaterial({ color: d.selected ? 0x4fc3ff : 0xffd400, depthTest: false }),
      );
      lines.renderOrder = 21;
      this.dimGroup.add(lines);
      const el = document.createElement("div");
      el.className = "dim-label" + (d.selected ? " selected" : "");
      el.textContent = d.text;
      el.title = "Click to change this distance (Delete removes it)";
      el.addEventListener("pointerdown", (e) => e.stopPropagation());
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        this.onDimClick?.(d.id);
      });
      // An open value box moves into the re-drawn label, keeping focus and text.
      if (this.dimEdit?.id === d.id) {
        el.textContent = "";
        el.appendChild(this.dimEdit.input);
      }
      this.dimLayer.appendChild(el);
      this.dimLabels.push({ id: d.id, at: d.labelAt, el });
    }
    if (this.dimEdit !== null && !dims.some((d) => d.id === this.dimEdit!.id)) this.dimEdit = null; // its dimension is gone
    if (hadFocus) this.dimEdit?.input.focus();
    this.requestRender();
  }

  /** True while a dimension value box is open. */
  hasDimEdit(): boolean {
    return this.dimEdit !== null;
  }

  /** Puts the caret back in the open value box (keys typed on the view go there). */
  focusDimEdit(): boolean {
    if (this.dimEdit === null) return false;
    this.dimEdit.input.focus();
    return true;
  }

  /** Confirms the open value box, as Enter in it would. */
  commitDimEdit(): void {
    this.dimEdit?.finish(true);
  }

  /** Opens an inline number box on a dimension label. */
  editDimLabel(id: string, value: string, commit: (text: string) => void): void {
    const label = this.dimLabels.find((l) => l.id === id);
    if (label === undefined) return;
    this.dimEdit?.finish(true); // only one box at a time
    const input = document.createElement("input");
    input.className = "dim-input";
    input.value = value;
    input.spellcheck = false;
    label.el.textContent = "";
    label.el.appendChild(input);
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      if (this.dimEdit?.input === input) this.dimEdit = null;
      if (ok) commit(input.value.trim());
      else commit(value);
      this.canvas.focus();
    };
    this.dimEdit = { id, input, finish };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
    });
    // Blur commits only when the user really moved on (not when a re-draw
    // briefly detached the box and put the focus straight back).
    input.addEventListener("blur", () => {
      setTimeout(() => {
        if (!done && document.activeElement !== input && this.dimEdit?.input === input) {
          // Focus went to the 3D view itself: keep the box open (typing is redirected to it).
          if (document.activeElement === this.canvas) return;
          finish(true);
        }
      }, 0);
    });
    input.focus();
    input.select();
  }

  private placeDimLabels(): void {
    const frame = this.dimFrame;
    if (frame === null || this.dimLabels.length === 0) return;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    for (const l of this.dimLabels) {
      const s = v3(surfaceTo3d(frame, l.at)).project(this.camera);
      l.el.style.left = `${((s.x + 1) / 2) * w}px`;
      l.el.style.top = `${((1 - s.y) / 2) * h}px`;
    }
  }

  setHighlightLines(frame: Surface | null, segments: readonly [Point, Point][], kind: "hl" | "guide" = "hl"): void {
    const old = this.markerGroup.children.filter((c) => c.userData.kind === kind);
    for (const o of old) {
      disposeChildren(o);
      this.markerGroup.remove(o);
      (o as THREE.LineSegments).geometry?.dispose();
    }
    if (frame !== null && segments.length > 0) {
      const lines = new THREE.LineSegments(
        segmentsGeometry(segments.map(([a, b]) => surfaceSegment(frame, a, b).map(v3))),
        // "guide": faint reference lines to measure from (e.g. plane traces on a round face).
        new THREE.LineBasicMaterial(
          kind === "hl" ? { color: 0xffd400, depthTest: false } : { color: 0x9fd3ff, depthTest: false, transparent: true, opacity: 0.55 },
        ),
      );
      lines.userData.kind = kind;
      lines.userData.screenPx = 1; // not rescaled meaningfully; lines have no size
      lines.renderOrder = 19;
      this.markerGroup.add(lines);
    }
    this.requestRender();
  }

  /** Edge picking (Fillet / Chamfer): the visible candidate edge nearest
   *  the cursor on screen; elsewhere, the face under it (any kind). */
  setEdgePickMode(edges: readonly Vec3[][], opts: { xray?: boolean } = {}): void {
    this.setPickMode("none");
    this.pickMode = "edge";
    this.edgeCandidates = edges.map((e) => e.slice());
    this.edgeXray = opts.xray === true;
  }

  /** Edge mode: candidates are clickable even behind the solid (sketch lines under a part). */
  private edgeXray = false;

  /** 3D Line: click points anywhere, osnapping to `candidates` (world points). */
  setPoint3dMode(candidates: readonly { p: Vec3; kind: string }[]): void {
    this.setPickMode("none");
    this.pickMode = "point3d";
    this.snap3d = candidates.slice();
  }

  /** New osnap candidates without leaving point3d mode (keeps the preview). */
  setPoint3dCandidates(candidates: readonly { p: Vec3; kind: string }[]): void {
    this.snap3d = candidates.slice();
  }

  /** 3D Line preview: the chain so far (blue), the rubber band (yellow),
   *  and the cursor marker (yellow box = osnap, white cross = free). */
  setChainPreview(chain: readonly Vec3[], rubber: readonly [Vec3, Vec3] | null, cursor: { p: Vec3; snapped: boolean } | null): void {
    const segs = (pts: readonly Vec3[]): Vec3[][] => pts.slice(1).map((p, i) => [pts[i]!, p]);
    this.setEdgeHighlights(segs(chain), rubber === null ? [] : [rubber.slice()]);
    disposeChildren(this.markerGroup);
    for (const p of chain) this.markerGroup.add(markerSprite(v3(p), "#4fc3ff", "box"));
    if (cursor !== null) this.markerGroup.add(markerSprite(v3(cursor.p), cursor.snapped ? "#ffd400" : "#ffffff", cursor.snapped ? "box" : "x"));
    this.requestRender();
  }

  /** Picked edges (blue) and hovered ones (yellow), drawn over the model. */
  setEdgeHighlights(selected: readonly (readonly Vec3[])[], hover: readonly (readonly Vec3[])[]): void {
    disposeChildren(this.edgeGroup);
    const add = (lines: readonly (readonly Vec3[])[], color: number, order: number): void => {
      if (lines.length === 0) return;
      const seg = new THREE.LineSegments(segmentsGeometry(lines.map((l) => l.map(v3))), new THREE.LineBasicMaterial({ color, depthTest: false }));
      seg.renderOrder = order;
      this.edgeGroup.add(seg);
    };
    add(selected, 0x4fc3ff, 22);
    add(hover, 0xffd400, 23);
    this.requestRender();
  }

  /** Live hover feedback in edge mode. */
  onEdgeHover: ((hit: Hit | null) => void) | null = null;

  /** Nearest visible candidate edge within SNAP_PX of the cursor, or null. */
  private pickEdge(e: PointerEvent, rect: DOMRect): number | null {
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const screen = (p: Vec3): { x: number; y: number; w: THREE.Vector3 } => {
      const w = v3(p);
      const s = w.clone().project(this.camera);
      return { x: ((s.x + 1) / 2) * rect.width, y: ((1 - s.y) / 2) * rect.height, w };
    };
    const found: { i: number; d: number; at: THREE.Vector3 }[] = [];
    this.edgeCandidates.forEach((line, i) => {
      let best = Infinity;
      let at: THREE.Vector3 | null = null;
      const screenLine = line.map(screen);
      for (let k = 0; k + 1 < screenLine.length; k++) {
        const a = screenLine[k]!;
        const b = screenLine[k + 1]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len2 = dx * dx + dy * dy;
        const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((mx - a.x) * dx + (my - a.y) * dy) / len2));
        const ex = mx - (a.x + t * dx);
        const ey = my - (a.y + t * dy);
        const d = Math.sqrt(ex * ex + ey * ey);
        if (d < best) {
          best = d;
          if (d <= SNAP_PX) {
            at = a.w.clone().lerp(b.w, t);
          }
        }
      }
      if (best <= SNAP_PX && at !== null) found.push({ i, d: best, at });
    });
    found.sort((p, q) => p.d - q.d);
    if (this.edgeXray) return found[0]?.i ?? null;
    // Visible only: nothing of the model in front of the edge there.
    const size = this.pixelSize();
    for (const f of found) {
      const s = f.at.clone().project(this.camera);
      this.raycaster.setFromCamera(new THREE.Vector2(s.x, s.y), this.camera);
      const first = this.raycaster.intersectObjects(this.bodyMeshes, false)[0];
      const edgeDist = this.raycaster.ray.origin.distanceTo(f.at);
      if (first === undefined || first.distance >= edgeDist - size * 3) return f.i;
    }
    return null;
  }

  /** Click-on-any-flat-face picking (Hole): the face under the cursor and
   *  the point on it, snapped to that face's own edge ends / midpoints /
   *  circle centres. */
  setSurfacePointMode(): void {
    this.setPickMode("none");
    this.pickMode = "surfacePoint";
  }

  /** Placed points (e.g. hole centres) + the live hover marker. */
  /** `colors[i]` overrides placed marker i's colour (e.g. green = locked hole). */
  setMarkers(
    frame: Surface | null,
    placed: readonly Point[],
    hover: { point: Point; snap: string | null } | null,
    colors: readonly string[] = [],
  ): void {
    for (const c of this.markerGroup.children.filter((o) => o.userData.kind !== "hl" && o.userData.kind !== "guide")) {
      disposeChildren(c);
      this.markerGroup.remove(c);
    }
    if (frame !== null) {
      placed.forEach((p, i) => this.markerGroup.add(markerSprite(v3(surfaceTo3d(frame, p)), colors[i] ?? "#ff5a5a", "x")));
      if (hover !== null) {
        this.markerGroup.add(markerSprite(v3(surfaceTo3d(frame, hover.point)), hover.snap !== null ? "#ffd400" : "#ffffff", hover.snap !== null ? "box" : "x"));
      }
    }
    this.requestRender();
  }

  setPickMode(mode: "none" | "plane" | "region", regions: readonly PickableRegion[] = []): void {
    this.highlightedFaceKey = null;
    disposeChildren(this.faceHighlight);
    this.faceFrame = null;
    this.edgeCandidates = [];
    disposeChildren(this.edgeGroup);
    this.snapCandidates = [];
    this.snap3d = [];
    disposeChildren(this.markerGroup);
    this.pickMode = mode;
    this.hovered = null;
    this.selectedRegions.clear();
    disposeChildren(this.regionGroup);
    this.regionMeshes = [];
    if (mode === "region") {
      for (const region of regions) {
        const mesh = new THREE.Mesh(
          regionGeometry(region.region, region.frame),
          new THREE.MeshBasicMaterial({
            color: REGION_COLOR,
            transparent: true,
            opacity: 0.18,
            side: THREE.DoubleSide,
            depthWrite: false,
          }),
        );
        this.regionGroup.add(mesh);
        this.regionMeshes.push({ mesh, region });
      }
    }
    this.styleHover();
  }

  setSelectedRegions(regions: Iterable<PickableRegion>): void {
    this.selectedRegions = new Set(regions);
    this.styleHover();
  }

  private pick(e: PointerEvent): Hit | null {
    if (this.pickMode === "none") return null;
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    if (this.pickMode === "facePoint" && this.faceFrame !== null) {
      const frame = this.faceFrame;
      // Osnap first: nearest candidate within SNAP_PX on screen.
      let best: SnapCandidate | null = null;
      let bestD = SNAP_PX;
      for (const c of this.snapCandidates) {
        const s = v3(localTo3d(frame, c.point)).project(this.camera);
        const px = ((s.x + 1) / 2) * rect.width - (e.clientX - rect.left);
        const py = ((1 - s.y) / 2) * rect.height - (e.clientY - rect.top);
        const d = Math.sqrt(px * px + py * py);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (best !== null) return { kind: "facePoint", point: best.point, snap: best.kind };
      // Otherwise where the ray meets the face's plane.
      const ray = this.raycaster.ray;
      const n = new THREE.Vector3(frame.n.x, frame.n.y, frame.n.z);
      const denom = n.dot(ray.direction);
      if (Math.abs(denom) < 1e-9) return null;
      const t = n.clone().dot(v3(frame.origin).sub(ray.origin)) / denom;
      const hit = ray.origin.clone().addScaledVector(ray.direction, t);
      const d = sub({ x: hit.x, y: hit.y, z: hit.z }, frame.origin);
      return { kind: "facePoint", point: { x: dot(d, frame.u), y: dot(d, frame.v) }, snap: null };
    }
    if (this.pickMode === "point3d") {
      const ray = this.raycaster.ray;
      const first = this.raycaster.intersectObjects(this.bodyMeshes, false)[0];
      const at = first === undefined ? null : { x: first.point.x, y: first.point.y, z: first.point.z };
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const size = this.pixelSize();
      let best: { p: Vec3; kind: string; d: number } | null = null;
      for (const c of this.snap3d) {
        const w = v3(c.p);
        const s = w.clone().project(this.camera);
        const d = Math.hypot(((s.x + 1) / 2) * rect.width - mx, ((1 - s.y) / 2) * rect.height - my);
        if (d > SNAP_PX || (best !== null && d >= best.d)) continue;
        // Visible only: nothing of the model in front of it.
        this.raycaster.setFromCamera(new THREE.Vector2(s.x, s.y), this.camera);
        const hit = this.raycaster.intersectObjects(this.bodyMeshes, false)[0];
        const dist = this.raycaster.ray.origin.distanceTo(w);
        if (hit === undefined || hit.distance >= dist - size * 3) best = { ...c, d };
      }
      this.raycaster.setFromCamera(ndc, this.camera);
      return {
        kind: "point3d",
        ray: { o: { x: ray.origin.x, y: ray.origin.y, z: ray.origin.z }, d: { x: ray.direction.x, y: ray.direction.y, z: ray.direction.z } },
        snap: best === null ? null : { p: best.p, kind: best.kind },
        at,
      };
    }
    if (this.pickMode === "edge") {
      const edge = this.pickEdge(e, rect);
      if (edge !== null) return { kind: "edge", index: edge };
      this.raycaster.setFromCamera(ndc, this.camera);
      const h = this.raycaster.intersectObjects(this.bodyMeshes, false)[0];
      const body = h?.object.userData.body as Body | undefined;
      const faceId = h?.faceIndex == null || body === undefined ? undefined : body.mesh.faceIds[h.faceIndex];
      const face = faceId === undefined ? undefined : body!.faces[faceId];
      return face === undefined || h === undefined ? null : { kind: "face", ref: face.ref, body: body!, faceId: face.id, at: { x: h.point.x, y: h.point.y, z: h.point.z } };
    }
    if (this.pickMode === "surfacePoint") {
      // A work plane in front of the solid there can be clicked too (a hole on a plane).
      const planes = [...this.planeMeshes].filter(([k, m]) => k.startsWith("wp:") && m.visible).map(([, m]) => m);
      const h = this.raycaster.intersectObjects([...planes, ...this.bodyMeshes], false)[0];
      const planeKey = h !== undefined && h.object.userData.body === undefined ? (h.object.userData.key as string | undefined) : undefined;
      const onPlane = planeKey === undefined ? undefined : this.workPlanes.find((p) => p.key === planeKey);
      if (h !== undefined && onPlane !== undefined) {
        const d = sub({ x: h.point.x, y: h.point.y, z: h.point.z }, onPlane.frame.origin);
        const raw = { x: dot(d, onPlane.frame.u), y: dot(d, onPlane.frame.v) };
        return { kind: "surfacePoint", ref: planeRef(onPlane.key), body: NO_BODY, faceId: -1, frame: onPlane.frame, point: raw, raw, snap: null };
      }
      const body = h?.object.userData.body as Body | undefined;
      const faceId = h?.faceIndex == null || body === undefined ? undefined : body.mesh.faceIds[h.faceIndex];
      const face = faceId === undefined ? undefined : body!.faces[faceId];
      if (h === undefined || body === undefined || face === undefined) return null;
      const cyl = roundFrame(face.geom);
      if (cyl !== null) {
        // Round face (cylinder or cone): only its outside (radial holes), no osnaps.
        const p = { x: h.point.x, y: h.point.y, z: h.point.z };
        const d = sub(p, cyl.origin);
        const radial = sub(d, { x: cyl.axis.x * dot(d, cyl.axis), y: cyl.axis.y * dot(d, cyl.axis), z: cyl.axis.z * dot(d, cyl.axis) });
        const n = h.face?.normal;
        if (n === undefined || n.x * radial.x + n.y * radial.y + n.z * radial.z <= 0) return null; // inside of a bore
        const raw = cylFromWorld(cyl, p);
        return { kind: "surfacePoint", ref: face.ref, body, faceId: face.id, frame: cyl, point: raw, raw, snap: null };
      }
      if (face.geom.kind !== "plane") return null;
      const frame = faceFrame(face.geom.origin, face.geom.normal);
      // Osnap to this face's own edges, within SNAP_PX on screen.
      let best: { point: Point; kind: string } | null = null;
      let bestD = SNAP_PX;
      for (const c of this.faceSnaps(body, face.id, frame)) {
        const s = v3(localTo3d(frame, c.point)).project(this.camera);
        const px = ((s.x + 1) / 2) * rect.width - (e.clientX - rect.left);
        const py = ((1 - s.y) / 2) * rect.height - (e.clientY - rect.top);
        const d = Math.sqrt(px * px + py * py);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      const d = sub({ x: h.point.x, y: h.point.y, z: h.point.z }, frame.origin);
      const raw = { x: dot(d, frame.u), y: dot(d, frame.v) };
      return { kind: "surfacePoint", ref: face.ref, body, faceId: face.id, frame, point: best?.point ?? raw, raw, snap: best?.kind ?? null };
    }
    if (this.pickMode === "plane") {
      // Nearest of: origin/work planes, or a FLAT face of a solid.
      const hits = this.raycaster.intersectObjects(
        [...[...this.planeMeshes.values()].filter((m) => m.visible), ...this.bodyMeshes],
        false,
      );
      for (const h of hits) {
        const body = h.object.userData.body as Body | undefined;
        if (body === undefined) return { kind: "plane", key: h.object.userData.key as string };
        const faceId = h.faceIndex == null ? undefined : body.mesh.faceIds[h.faceIndex];
        const face = faceId === undefined ? undefined : body.faces[faceId];
        if (face?.geom.kind === "plane") return { kind: "face", ref: face.ref, body, faceId: face.id };
        return null; // a curved face is in front: nothing sketchable here
      }
      return null;
    }
    const hits = this.raycaster.intersectObjects(
      this.regionMeshes.map((r) => r.mesh),
      false,
    );
    // Smallest region under the cursor wins (a region inside another's hole).
    const candidates = hits
      .map((h) => this.regionMeshes.find((r) => r.mesh === h.object)!.region)
      .sort((a, b) => a.region.area - b.region.area);
    const first = candidates[0];
    return first === undefined ? null : { kind: "region", region: first };
  }

  /** Snap points of one face, cached per (body, face) until bodies change. */
  private snapCache = new Map<Body, Map<number, FaceSnap[]>>();

  private faceSnaps(body: Body, faceId: number, frame: Frame): FaceSnap[] {
    let perBody = this.snapCache.get(body);
    if (perBody === undefined) {
      perBody = new Map();
      this.snapCache.set(body, perBody);
    }
    let snaps = perBody.get(faceId);
    if (snaps === undefined) {
      snaps = edgesOnFace(body, frame).snaps;
      perBody.set(faceId, snaps);
    }
    return snaps;
  }

  /** Live hover feedback in point3d mode (3D Line). */
  onPoint3dHover: ((hit: Extract<Hit, { kind: "point3d" }> | null) => void) | null = null;

  /** Live hover feedback in face-point mode (the controller draws markers). */
  onFacePointHover: ((hit: { point: Point; snap: string | null } | null) => void) | null = null;
  /** Live hover feedback in surface-point mode (null = not over a flat face). */
  onSurfaceHover: ((hit: Extract<Hit, { kind: "surfacePoint" }> | null) => void) | null = null;

  private onHover(e: PointerEvent): void {
    if (this.pickMode === "none" || this.downPos !== null) return;
    if (this.pickMode === "point3d") {
      const hit = this.pick(e);
      this.canvas.style.cursor = "crosshair";
      this.onPoint3dHover?.(hit?.kind === "point3d" ? hit : null);
      return;
    }
    if (this.pickMode === "edge") {
      const hit = this.pick(e);
      this.highlightFace(hit?.kind === "face" ? hit : null);
      this.canvas.style.cursor = hit === null ? "" : "pointer";
      this.onEdgeHover?.(hit);
      this.requestRender();
      return;
    }
    if (this.pickMode === "surfacePoint") {
      const hit = this.pick(e);
      const s = hit?.kind === "surfacePoint" ? hit : null;
      this.highlightFace(s === null ? null : { kind: "face", ref: s.ref, body: s.body, faceId: s.faceId });
      this.canvas.style.cursor = s === null ? "" : "crosshair";
      this.onSurfaceHover?.(s);
      this.requestRender();
      return;
    }
    if (this.pickMode === "facePoint") {
      const hit = this.pick(e);
      this.onFacePointHover?.(hit?.kind === "facePoint" ? hit : null);
      return;
    }
    const hit = this.pick(e);
    const same =
      (hit === null && this.hovered === null) ||
      (hit?.kind === "plane" && this.hovered?.kind === "plane" && hit.key === this.hovered.key) ||
      (hit?.kind === "face" && this.hovered?.kind === "face" && hit.body === this.hovered.body && hit.faceId === this.hovered.faceId) ||
      (hit?.kind === "region" && this.hovered?.kind === "region" && hit.region === this.hovered.region);
    if (same) return;
    this.hovered = hit;
    this.canvas.style.cursor = hit === null ? "" : "pointer";
    this.styleHover();
  }

  /** Tints the hovered solid face (sketch-on-face picking). */
  private highlightFace(hit: Hit | null): void {
    const key = hit?.kind === "face" ? `${hit.body.id}:${hit.faceId}` : null;
    if (key === this.highlightedFaceKey) return;
    this.highlightedFaceKey = key;
    disposeChildren(this.faceHighlight);
    if (hit?.kind !== "face") return;
    this.faceHighlight.add(faceMesh(hit.body, hit.faceId, WORKPLANE_COLOR, 0.45));
  }

  /** Faces kept lit (orange) until cleared -- e.g. the two faces an angle is measured between. */
  setPinnedFaces(list: readonly { body: Body; faceId: number }[]): void {
    disposeChildren(this.pinnedFaces);
    for (const f of list) this.pinnedFaces.add(faceMesh(f.body, f.faceId, 0xffa53a, 0.55));
    this.requestRender();
  }

  private styleHover(): void {
    this.highlightFace(this.pickMode === "plane" ? this.hovered : null);
    for (const mesh of this.planeMeshes.values()) {
      const hot = this.pickMode === "plane" && this.hovered?.kind === "plane" && this.hovered.key === mesh.userData.key;
      (mesh.material as THREE.MeshBasicMaterial).opacity = hot ? 0.4 : this.pickMode === "plane" ? 0.18 : 0.08;
    }
    for (const { mesh, region } of this.regionMeshes) {
      const hot = this.hovered?.kind === "region" && this.hovered.region === region;
      const selected = this.selectedRegions.has(region);
      (mesh.material as THREE.MeshBasicMaterial).opacity = selected ? 0.6 : hot ? 0.4 : 0.18;
    }
    this.requestRender();
  }

  // --- camera ---

  /** World-space bounds of everything worth framing. */
  private contentBox(): THREE.Box3 {
    const box = new THREE.Box3();
    for (const group of [this.contentGroup, this.sketchGroup, this.previewGroup]) box.expandByObject(group);
    if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(60, 60, 60));
    return box;
  }

  /** Resizes the origin planes to suit the model's scale. */
  updateOriginScale(): void {
    const size = this.contentBox().getSize(new THREE.Vector3()).length();
    const next = Math.max(40, Math.ceil((size * 0.5) / 10) * 10);
    if (next !== this.planeSize) {
      this.planeSize = next;
      this.buildOrigin();
      this.setWorkPlanes(this.workPlanes);
    }
  }

  setView(view: StandardView): void {
    const dirs: Record<StandardView, THREE.Vector3> = {
      front: new THREE.Vector3(0, -1, 0),
      // Not exactly +Z: OrbitControls keeps camera.up = +Z, which is
      // degenerate looking straight down. This still reads as a true plan
      // view -- the same view as the 2D workspace (X right, Y up).
      top: new THREE.Vector3(0, -1e-6, 1),
      right: new THREE.Vector3(1, 0, 0),
      iso: new THREE.Vector3(1, -1, 1), // AutoCAD's SE isometric
    };
    this.frame(dirs[view].normalize());
    this.setViewName(VIEW_NAMES[view]);
  }

  /** Zooms to fit (keeping the view direction) only when the model isn't
   *  comfortably in view -- partly off-screen, or too small to read. Used on
   *  every switch into 3D, so what you just drew in 2D is always framed. */
  fitIfNeeded(): void {
    const box = this.contentBox();
    this.camera.updateMatrixWorld();
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const x of [box.min.x, box.max.x]) {
      for (const y of [box.min.y, box.max.y]) {
        for (const z of [box.min.z, box.max.z]) {
          const p = new THREE.Vector3(x, y, z).project(this.camera);
          minX = Math.min(minX, p.x);
          maxX = Math.max(maxX, p.x);
          minY = Math.min(minY, p.y);
          maxY = Math.max(maxY, p.y);
        }
      }
    }
    const outside = minX < -1 || maxX > 1 || minY < -1 || maxY > 1;
    const tiny = Math.max(maxX - minX, maxY - minY) < 0.25;
    if (outside || tiny) this.fit();
  }

  /**
   * Steps the view round the model, keeping what it looks at and the zoom:
   * `azimuth` degrees round the vertical (Z), `elevation` degrees up / down
   * (stopping straight above / below). Lands exactly on the standard views
   * when stepping from one.
   */
  orbitBy(azimuth: number, elevation: number): void {
    const target = this.controls.target;
    const offset = this.camera.position.clone().sub(target);
    const dist = offset.length();
    const dir = offset.normalize();
    const snap = (deg: number): number => (Math.abs(deg - Math.round(deg / 15) * 15) < 0.5 ? Math.round(deg / 15) * 15 : deg);
    const polar = snap((Math.acos(Math.max(-1, Math.min(1, dir.z))) * 180) / Math.PI);
    const az = snap((Math.atan2(dir.y, dir.x) * 180) / Math.PI);
    const p = Math.max(0, Math.min(180, polar - elevation));
    const a = az - azimuth;
    // Straight down / up is degenerate for a Z-up orbit camera: nudge it,
    // keeping the azimuth so the plan view stays turned the way asked.
    const pr = (Math.min(180 - 1e-4, Math.max(1e-4, p)) * Math.PI) / 180;
    const ar = (a * Math.PI) / 180;
    const next = new THREE.Vector3(Math.sin(pr) * Math.cos(ar), Math.sin(pr) * Math.sin(ar), Math.cos(pr));
    this.camera.position.copy(target).addScaledVector(next, dist);
    this.controls.update();
    this.requestRender();
    const pd = (p * Math.PI) / 180;
    this.setViewName(namedDirection(new THREE.Vector3(Math.sin(pd) * Math.cos(ar), Math.sin(pd) * Math.sin(ar), Math.cos(pd))));
  }

  fit(): void {
    this.frame(this.camera.position.clone().sub(this.controls.target).normalize());
  }

  private frame(dir: THREE.Vector3): void {
    // Straight down/up is degenerate for a Z-up orbit camera: nudge it.
    if (Math.abs(dir.z) > 0.99999) dir = new THREE.Vector3(0, -1e-6, Math.sign(dir.z)).normalize();
    const sphere = this.contentBox().getBoundingSphere(new THREE.Sphere());
    const r = Math.max(sphere.radius, 1);
    const dist = r * 4 + 100;
    this.controls.target.copy(sphere.center);
    this.camera.position.copy(sphere.center).addScaledVector(dir, dist);
    this.camera.near = 0.1;
    this.camera.far = dist + r * 4 + 1000;
    const { width, height } = this.size();
    this.camera.zoom = Math.min(width, height) / (2.3 * r);
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.requestRender();
  }

  private size(): { width: number; height: number } {
    return { width: Math.max(1, this.canvas.clientWidth), height: Math.max(1, this.canvas.clientHeight) };
  }

  resize(): void {
    const { width, height } = this.size();
    this.renderer.setSize(width, height, false);
    this.camera.left = -width / 2;
    this.camera.right = width / 2;
    this.camera.top = height / 2;
    this.camera.bottom = -height / 2;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  requestRender(): void {
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    requestAnimationFrame(() => {
      this.renderScheduled = false;
      // Constant on-screen UCS icon size: ortho world units per pixel = 1/zoom.
      this.ucsIcon.scale.setScalar(55 / this.camera.zoom);
      this.originGroup.scale.setScalar(95 / this.camera.zoom);
      for (const m of this.markerGroup.children) {
        if (m.userData.kind !== "hl" && m.userData.kind !== "guide") m.scale.setScalar((m.userData.screenPx as number) / this.camera.zoom);
      }
      this.renderer.render(this.scene, this.camera);
      this.placeDimLabels();
      this.viewCube.sync(this.camera, this.controls.target);
    });
  }
}

/** Name of an axis-aligned view direction (for the view label). */
function namedDirection(d: THREE.Vector3): string {
  const near = (x: number, y: number, z: number): boolean => d.distanceTo(new THREE.Vector3(x, y, z).normalize()) < 1e-6;
  if (near(0, 0, 1)) return "Top";
  if (near(0, 0, -1)) return "Bottom";
  if (near(0, -1, 0)) return "Front";
  if (near(0, 1, 0)) return "Back";
  if (near(1, 0, 0)) return "Right";
  if (near(-1, 0, 0)) return "Left";
  if (near(1, -1, 1)) return "SE Isometric";
  if (near(-1, -1, 1)) return "SW Isometric";
  if (near(1, 1, 1)) return "NE Isometric";
  if (near(-1, 1, 1)) return "NW Isometric";
  return "Custom View";
}

/** Constant-size screen marker: "x" cross or osnap "box". */
function markerSprite(position: THREE.Vector3, color: string, shape: "x" | "box"): THREE.Sprite {
  const c = document.createElement("canvas");
  c.width = 32;
  c.height = 32;
  const ctx = c.getContext("2d")!;
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  if (shape === "box") ctx.strokeRect(6, 6, 20, 20);
  else {
    ctx.beginPath();
    ctx.moveTo(6, 6);
    ctx.lineTo(26, 26);
    ctx.moveTo(26, 6);
    ctx.lineTo(6, 26);
    ctx.stroke();
  }
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, sizeAttenuation: false }),
  );
  sprite.position.copy(position);
  sprite.userData.screenPx = 16; // rescaled per frame (ortho camera: world-unit sizes)
  sprite.renderOrder = 20;
  return sprite;
}

function textSprite(text: string, position: THREE.Vector3): THREE.Sprite {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#e0e0e0";
  ctx.font = "40px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 32, 34);
  const tex = new THREE.CanvasTexture(c);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  sprite.position.copy(position);
  sprite.scale.setScalar(0.32);
  sprite.renderOrder = 10;
  return sprite;
}

function disposeChildren(group: THREE.Object3D): void {
  for (const child of [...group.children]) {
    child.traverse((o) => {
      const obj = o as THREE.Mesh;
      obj.geometry?.dispose();
      const mat = obj.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
    });
    group.remove(child);
  }
}

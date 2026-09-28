/**
 * MinimalCAD Web
 * view3d/viewCube.ts
 *
 * AutoCAD-style ViewCube: a small labelled cube in the corner that always
 * mirrors the main camera's orientation. Clicking a face, edge or corner
 * snaps the main view to look from that direction (Z-up world: TOP = +Z,
 * FRONT = -Y, RIGHT = +X).
 */

import * as THREE from "three";

const FACES: { label: string; normal: THREE.Vector3 }[] = [
  { label: "RIGHT", normal: new THREE.Vector3(1, 0, 0) },
  { label: "LEFT", normal: new THREE.Vector3(-1, 0, 0) },
  { label: "BACK", normal: new THREE.Vector3(0, 1, 0) },
  { label: "FRONT", normal: new THREE.Vector3(0, -1, 0) },
  { label: "TOP", normal: new THREE.Vector3(0, 0, 1) },
  { label: "BOTTOM", normal: new THREE.Vector3(0, 0, -1) },
];

function faceTexture(label: string, hot: boolean): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = hot ? "#5a8fd6" : "#d9dde3";
  ctx.fillRect(0, 0, 128, 128);
  ctx.strokeStyle = "#7d8591";
  ctx.lineWidth = 6;
  ctx.strokeRect(0, 0, 128, 128);
  ctx.fillStyle = hot ? "#ffffff" : "#3a3f47";
  ctx.font = "bold 26px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, 64, 66);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class ViewCube {
  readonly el: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  private cube: THREE.Mesh;
  private materials: THREE.MeshBasicMaterial[];
  private raycaster = new THREE.Raycaster();
  private hotFace = -1;

  /** Called with the direction to look FROM (unit vector, world space). */
  onPick: ((dir: THREE.Vector3) => void) | null = null;
  onHome: (() => void) | null = null;

  constructor(parent: HTMLElement) {
    this.el = document.createElement("canvas");
    this.el.className = "v3d-overlay view-cube";
    this.el.title = "Click a face, edge or corner to view from there";
    parent.appendChild(this.el);
    this.renderer = new THREE.WebGLRenderer({ canvas: this.el, antialias: true, alpha: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(110, 110, false);

    this.materials = FACES.map((f) => new THREE.MeshBasicMaterial({ map: faceTexture(f.label, false) }));
    // BoxGeometry material order: +X, -X, +Y, -Y, +Z, -Z -- same as FACES.
    this.cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.materials);
    this.scene.add(this.cube);
    this.cube.add(
      new THREE.LineSegments(
        new THREE.EdgesGeometry(this.cube.geometry),
        new THREE.LineBasicMaterial({ color: 0x5b626c }),
      ),
    );
    // Compass ring on the ground under the cube, as in AutoCAD.
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.78, 0.9, 48),
      new THREE.MeshBasicMaterial({ color: 0x6b7280, side: THREE.DoubleSide, transparent: true, opacity: 0.8 }),
    );
    ring.position.z = -0.5;
    this.scene.add(ring);
    this.camera.up.set(0, 0, 1);
    const s = 0.95;
    this.camera.left = -s;
    this.camera.right = s;
    this.camera.top = s;
    this.camera.bottom = -s;

    this.el.addEventListener("pointermove", (e) => this.hover(e));
    this.el.addEventListener("pointerleave", () => this.setHot(-1));
    this.el.addEventListener("click", (e) => {
      const dir = this.directionAt(e);
      if (dir !== null) this.onPick?.(dir);
    });
    this.el.addEventListener("dblclick", () => this.onHome?.());
  }

  /** Mirrors the main camera's viewing direction and up. */
  sync(mainCamera: THREE.Camera, target: THREE.Vector3): void {
    const dir = mainCamera.position.clone().sub(target).normalize();
    this.camera.position.copy(dir.multiplyScalar(3));
    this.camera.up.copy(mainCamera.up);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateProjectionMatrix();
    this.renderer.render(this.scene, this.camera);
  }

  private hit(e: PointerEvent | MouseEvent): THREE.Intersection | null {
    const rect = this.el.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster.intersectObject(this.cube, false)[0] ?? null;
  }

  /** Face -> its normal; near an edge/corner -> the diagonal (iso) direction. */
  private directionAt(e: MouseEvent): THREE.Vector3 | null {
    const h = this.hit(e);
    if (h === null) return null;
    const p = h.point;
    const d = new THREE.Vector3(
      Math.abs(p.x) > 0.3 ? Math.sign(p.x) : 0,
      Math.abs(p.y) > 0.3 ? Math.sign(p.y) : 0,
      Math.abs(p.z) > 0.3 ? Math.sign(p.z) : 0,
    );
    return d.lengthSq() === 0 ? null : d.normalize();
  }

  private hover(e: PointerEvent): void {
    const h = this.hit(e);
    this.el.style.cursor = h === null ? "" : "pointer";
    this.setHot(h?.face?.materialIndex ?? -1);
  }

  private setHot(index: number): void {
    if (index === this.hotFace) return;
    if (this.hotFace >= 0) this.swapTexture(this.hotFace, false);
    this.hotFace = index;
    if (index >= 0) this.swapTexture(index, true);
    this.renderer.render(this.scene, this.camera);
  }

  private swapTexture(index: number, hot: boolean): void {
    const mat = this.materials[index]!;
    mat.map?.dispose();
    mat.map = faceTexture(FACES[index]!.label, hot);
    mat.needsUpdate = true;
  }
}

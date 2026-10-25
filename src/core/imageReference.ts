/** A raster tracing reference stored with a drawing, separate from CAD entities. */
export interface ImageReference {
  id: string;
  name: string;
  dataUrl: string;
  /** Unrotated top-left position in drawing coordinates. */
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  /** 0 = invisible, 1 = opaque. */
  opacity: number;
  locked: boolean;
}

export function parseImageReference(value: unknown): ImageReference | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.id !== "string" || typeof v.name !== "string" || typeof v.data_url !== "string" ||
    !v.data_url.startsWith("data:image/") ||
    typeof v.x !== "number" || !Number.isFinite(v.x) || typeof v.y !== "number" || !Number.isFinite(v.y) ||
    typeof v.width !== "number" || !Number.isFinite(v.width) || v.width <= 0 ||
    typeof v.height !== "number" || !Number.isFinite(v.height) || v.height <= 0 ||
    typeof v.rotation !== "number" || !Number.isFinite(v.rotation) ||
    typeof v.opacity !== "number" || !Number.isFinite(v.opacity) ||
    typeof v.locked !== "boolean"
  ) return null;
  return {
    id: v.id,
    name: v.name,
    dataUrl: v.data_url,
    x: v.x,
    y: v.y,
    width: v.width,
    height: v.height,
    rotation: v.rotation,
    opacity: Math.max(0, Math.min(1, v.opacity)),
    locked: v.locked,
  };
}

export function serializeImageReference(reference: ImageReference): Record<string, unknown> {
  return {
    id: reference.id,
    name: reference.name,
    data_url: reference.dataUrl,
    x: reference.x,
    y: reference.y,
    width: reference.width,
    height: reference.height,
    rotation: reference.rotation,
    opacity: reference.opacity,
    locked: reference.locked,
  };
}

/** Canvas-world point-in-image test, including image rotation about its center. */
export function imageReferenceContains(reference: ImageReference, point: { x: number; y: number }): boolean {
  const cx = reference.x + reference.width / 2;
  const cy = reference.y + reference.height / 2;
  const a = (-reference.rotation * Math.PI) / 180;
  const dx = point.x - cx;
  const dy = point.y - cy;
  const localX = cx + dx * Math.cos(a) - dy * Math.sin(a);
  const localY = cy + dx * Math.sin(a) + dy * Math.cos(a);
  return localX >= reference.x && localX <= reference.x + reference.width && localY >= reference.y && localY <= reference.y + reference.height;
}

export function imageReferenceBounds(reference: ImageReference): [number, number, number, number] {
  const cx = reference.x + reference.width / 2;
  const cy = reference.y + reference.height / 2;
  const angle = (reference.rotation * Math.PI) / 180;
  const corners = [
    [reference.x, reference.y],
    [reference.x + reference.width, reference.y],
    [reference.x + reference.width, reference.y + reference.height],
    [reference.x, reference.y + reference.height],
  ].map(([x, y]) => {
    const dx = x! - cx;
    const dy = y! - cy;
    return { x: cx + dx * Math.cos(angle) - dy * Math.sin(angle), y: cy + dx * Math.sin(angle) + dy * Math.cos(angle) };
  });
  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

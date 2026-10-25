import { describe, expect, it } from "vitest";
import { imageReferenceBounds, imageReferenceContains, parseImageReference, serializeImageReference } from "./imageReference";

const reference = {
  id: "ref", name: "trace.png", dataUrl: "data:image/png;base64,aGVsbG8=",
  x: 10, y: 20, width: 100, height: 50, rotation: 0, opacity: 0.45, locked: true,
};

describe("image references", () => {
  it("round-trips the JCAD stored representation", () => {
    expect(parseImageReference(serializeImageReference(reference))).toEqual(reference);
  });

  it("rejects malformed images and clamps opacity", () => {
    expect(parseImageReference({ ...serializeImageReference(reference), width: -1 })).toBeNull();
    expect(parseImageReference({ ...serializeImageReference(reference), opacity: 3 })?.opacity).toBe(1);
  });

  it("hit-tests the rotated image bounds", () => {
    expect(imageReferenceContains(reference, { x: 10, y: 20 })).toBe(true);
    expect(imageReferenceContains(reference, { x: 120, y: 45 })).toBe(false);
    expect(imageReferenceContains({ ...reference, rotation: 90 }, { x: 35, y: -5 })).toBe(true);
  });

  it("calculates bounds that include the rotated corners", () => {
    expect(imageReferenceBounds(reference)).toEqual([10, 20, 110, 70]);
    const rotated = imageReferenceBounds({ ...reference, rotation: 90 });
    expect(rotated[0]).toBeCloseTo(35);
    expect(rotated[1]).toBeCloseTo(-5);
    expect(rotated[2]).toBeCloseTo(85);
    expect(rotated[3]).toBeCloseTo(95);
  });
});

import type { ImageReference } from "../core/imageReference";

export interface ImageReferenceEdit {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  opacity: number;
  locked: boolean;
}

export interface ImageReferenceDialogActions {
  apply(edit: ImageReferenceEdit): void;
  calibrate(edit: ImageReferenceEdit): void;
  remove(): void;
  preview(edit: ImageReferenceEdit): void;
}

/** Double-click properties for an underlay image. Changes preview live and
 *  become one undoable edit when the user chooses Done or Calibrate. */
export function openImageReferenceProperties(reference: ImageReference, actions: ImageReferenceDialogActions): void {
  const original = readEdit(reference);
  const dialog = document.createElement("dialog");
  dialog.className = "image-reference-dialog";
  dialog.setAttribute("aria-label", `Image properties: ${reference.name}`);

  const title = document.createElement("h2");
  title.textContent = "Image Reference";
  const subtitle = document.createElement("p");
  subtitle.className = "image-reference-name";
  subtitle.textContent = reference.name;

  const form = document.createElement("div");
  form.className = "image-reference-form";
  const numeric: Record<"x" | "y" | "width" | "height" | "rotation", HTMLInputElement> = {
    x: numberField(form, "Position X", original.x, 3),
    y: numberField(form, "Position Y", original.y, 3),
    width: numberField(form, "Width", original.width, 3, 0.001),
    height: numberField(form, "Height", original.height, 3, 0.001),
    rotation: numberField(form, "Rotation (°)", original.rotation, 2),
  };
  const opacityRow = document.createElement("label");
  opacityRow.className = "image-reference-opacity";
  const opacityTitle = document.createElement("span");
  opacityTitle.textContent = "Opacity";
  const opacity = document.createElement("input");
  opacity.type = "range";
  opacity.min = "0";
  opacity.max = "100";
  opacity.step = "1";
  opacity.value = String(Math.round(original.opacity * 100));
  const opacityValue = document.createElement("output");
  opacityValue.textContent = `${opacity.value}%`;
  opacityRow.append(opacityTitle, opacity, opacityValue);
  form.appendChild(opacityRow);

  const lockRow = document.createElement("label");
  lockRow.className = "image-reference-lock";
  const locked = document.createElement("input");
  locked.type = "checkbox";
  locked.checked = original.locked;
  const lockText = document.createElement("span");
  lockText.textContent = "Lock image in place (prevents dragging)";
  lockRow.append(locked, lockText);
  form.appendChild(lockRow);

  const keepAspectRow = document.createElement("label");
  keepAspectRow.className = "image-reference-lock";
  const keepAspect = document.createElement("input");
  keepAspect.type = "checkbox";
  keepAspect.checked = true;
  const aspectText = document.createElement("span");
  aspectText.textContent = "Keep aspect ratio when resizing";
  keepAspectRow.append(keepAspect, aspectText);
  form.appendChild(keepAspectRow);

  const hint = document.createElement("p");
  hint.className = "image-reference-hint";
  hint.textContent = "To match a known measurement, choose Calibrate and click the two endpoints on the image.";

  const buttons = document.createElement("div");
  buttons.className = "image-reference-buttons";
  const remove = makeButton("Remove", "danger");
  const calibrate = makeButton("Calibrate…", "secondary");
  const cancel = makeButton("Cancel", "secondary");
  const done = makeButton("Done", "primary");
  buttons.append(remove, calibrate, cancel, done);
  dialog.append(title, subtitle, form, hint, buttons);
  document.body.appendChild(dialog);

  const current = (): ImageReferenceEdit => ({
    x: number(numeric.x, original.x),
    y: number(numeric.y, original.y),
    width: Math.max(0.001, number(numeric.width, original.width)),
    height: Math.max(0.001, number(numeric.height, original.height)),
    rotation: number(numeric.rotation, original.rotation),
    opacity: Number(opacity.value) / 100,
    locked: locked.checked,
  });
  const updatePreview = (): void => {
    const edit = current();
    opacityValue.textContent = `${Math.round(edit.opacity * 100)}%`;
    actions.preview(edit);
  };
  const close = (): void => {
    if (dialog.open) dialog.close();
    dialog.remove();
  };
  for (const input of Object.values(numeric)) input.addEventListener("input", () => {
    if (keepAspect.checked && (input === numeric.width || input === numeric.height)) {
      const aspect = original.width / original.height;
      if (input === numeric.width) numeric.height.value = String(Number(numeric.width.value) / aspect);
      else numeric.width.value = String(Number(numeric.height.value) * aspect);
    }
    updatePreview();
  });
  opacity.addEventListener("input", updatePreview);
  locked.addEventListener("change", updatePreview);
  keepAspect.addEventListener("change", updatePreview);
  done.addEventListener("click", () => { actions.apply(current()); close(); });
  cancel.addEventListener("click", () => { actions.preview(original); close(); });
  remove.addEventListener("click", () => { actions.remove(); close(); });
  calibrate.addEventListener("click", () => { actions.calibrate(current()); close(); });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    actions.preview(original);
    close();
  });
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  dialog.showModal();
}

function readEdit(reference: ImageReference): ImageReferenceEdit {
  return {
    x: reference.x,
    y: reference.y,
    width: reference.width,
    height: reference.height,
    rotation: reference.rotation,
    opacity: reference.opacity,
    locked: reference.locked,
  };
}

function numberField(
  parent: HTMLElement,
  title: string,
  value: number,
  decimals: number,
  min?: number,
): HTMLInputElement {
  const label = document.createElement("label");
  label.className = "image-reference-field";
  const name = document.createElement("span");
  name.textContent = title;
  const input = document.createElement("input");
  input.type = "number";
  input.step = decimals <= 2 ? "0.1" : "0.001";
  if (min !== undefined) input.min = String(min);
  input.value = value.toFixed(decimals);
  label.append(name, input);
  parent.appendChild(label);
  return input;
}

function number(input: HTMLInputElement, fallback: number): number {
  const parsed = Number(input.value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function makeButton(text: string, kind: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `image-reference-button ${kind}`;
  button.textContent = text;
  return button;
}

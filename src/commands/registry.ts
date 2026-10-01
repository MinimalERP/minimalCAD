/**
 * MinimalCAD Web
 * commands/registry.ts
 *
 * Ported from commands/registry.py's COMMAND_REGISTRY. name -> (factory,
 * typed-command-line aliases). Grows one entry per phase as more commands
 * come online.
 */

import type { CommandFactory } from "./types";
import { LineCommand } from "./line";
import { CircleCommand } from "./circle";
import { ArcCommand } from "./arc";
import { EllipseCommand } from "./ellipse";
import { RectangleCommand } from "./rectangle";
import { MoveCommand } from "./move";
import { CopyCommand } from "./copy";
import { RotateCommand } from "./rotate";
import { ScaleCommand } from "./scale";
import { MirrorCommand } from "./mirror";
import { PolarArrayCommand } from "./polarArray";
import { TrimCommand } from "./trim";
import { OffsetCommand } from "./offset";
import { FilletCommand } from "./fillet";
import { ChamferCommand } from "./chamfer";
import { TextCommand } from "./text";
import { ExplodeCommand } from "./explode";
import { JoinCommand } from "./join";
import { LinearDimensionCommand } from "./linearDimension";
import { AlignedDimensionCommand } from "./alignedDimension";
import { AngularDimensionCommand } from "./angularDimension";
import { DiameterDimensionCommand, RadiusDimensionCommand } from "./radialDimension";
import { LeaderCommand } from "./leader";
import { MoveGripCommand } from "./grips/moveGrip";
import { ExtendGripCommand } from "./grips/extendGrip";
import { CircleResizeGripCommand } from "./grips/circleResizeGrip";
import { DimensionGripCommand } from "./grips/dimensionGrip";
import { EditTextCommand } from "./editText";
import { SaveLibCommand } from "./saveLib";
import { InsertLibCommand } from "./insertLib";
import { ConstrainDistanceCommand } from "./constrainDistance";
import { ConstrainGeometryCommand } from "./constrainGeometry";
import { ExportPdfCommand } from "./exportPdf";
import { DimDecimalsCommand } from "./dimDecimals";

export interface RegistryEntry {
  factory: CommandFactory;
  aliases: string[];
}

export const COMMAND_REGISTRY: Record<string, RegistryEntry> = {
  line: { factory: (engine) => new LineCommand(engine), aliases: ["l"] },
  circle: { factory: (engine) => new CircleCommand(engine), aliases: ["c"] },
  arc: { factory: (engine) => new ArcCommand(engine), aliases: ["a"] },
  ellipse: { factory: (engine) => new EllipseCommand(engine), aliases: ["el"] },
  rectangle: { factory: (engine) => new RectangleCommand(engine), aliases: ["r", "rec"] },
  move: { factory: (engine) => new MoveCommand(engine), aliases: ["m"] },
  copy: { factory: (engine) => new CopyCommand(engine), aliases: ["co", "cp"] },
  rotate: { factory: (engine) => new RotateCommand(engine), aliases: ["ro"] },
  scale: { factory: (engine) => new ScaleCommand(engine), aliases: ["s"] },
  mirror: { factory: (engine) => new MirrorCommand(engine), aliases: ["mi"] },
  polararray: { factory: (engine) => new PolarArrayCommand(engine), aliases: ["pa"] },
  trim: { factory: (engine) => new TrimCommand(engine), aliases: ["t"] },
  offset: { factory: (engine) => new OffsetCommand(engine), aliases: ["o"] },
  fillet: { factory: (engine) => new FilletCommand(engine), aliases: ["f"] },
  chamfer: { factory: (engine) => new ChamferCommand(engine), aliases: ["cha"] },
  join: { factory: (engine) => new JoinCommand(engine), aliases: ["j"] },
  explode: { factory: (engine) => new ExplodeCommand(engine), aliases: ["ex"] },
  text: { factory: (engine) => new TextCommand(engine), aliases: ["x"] },
  linear: { factory: (engine) => new LinearDimensionCommand(engine), aliases: ["d", "dli"] },
  aligned: { factory: (engine) => new AlignedDimensionCommand(engine), aliases: ["dal"] },
  angular: { factory: (engine) => new AngularDimensionCommand(engine), aliases: ["dan"] },
  diameter: { factory: (engine) => new DiameterDimensionCommand(engine), aliases: ["ddi"] },
  radius: { factory: (engine) => new RadiusDimensionCommand(engine), aliases: ["dra"] },
  leader: { factory: (engine) => new LeaderCommand(engine), aliases: ["le", "lead"] },
  dimdec: { factory: (engine) => new DimDecimalsCommand(engine), aliases: ["dimdec"] },
  insertlib: { factory: (engine) => new InsertLibCommand(engine), aliases: ["il", "insert"] },
  savelib: { factory: (engine) => new SaveLibCommand(engine), aliases: ["sl"] },
  constrain: { factory: (engine) => new ConstrainDistanceCommand(engine), aliases: ["con", "cdist"] },
  horizontal: { factory: (engine) => new ConstrainGeometryCommand(engine, "horizontal"), aliases: ["hor"] },
  vertical: { factory: (engine) => new ConstrainGeometryCommand(engine, "vertical"), aliases: ["ver"] },
  parallel: { factory: (engine) => new ConstrainGeometryCommand(engine, "parallel"), aliases: ["par"] },
  perpendicular: { factory: (engine) => new ConstrainGeometryCommand(engine, "perpendicular"), aliases: ["perp"] },
  equal: { factory: (engine) => new ConstrainGeometryCommand(engine, "equal"), aliases: ["eq"] },
  coincident: { factory: (engine) => new ConstrainGeometryCommand(engine, "coincident"), aliases: ["coi"] },
  pdfexport: { factory: (engine) => new ExportPdfCommand(engine), aliases: ["pdf"] },
  // Contextual-only: entered directly via canvasView's grip hit-test, never typed.
  movegrip: { factory: (engine) => new MoveGripCommand(engine), aliases: [] },
  gripextend: { factory: (engine) => new ExtendGripCommand(engine), aliases: [] },
  gripresize: { factory: (engine) => new CircleResizeGripCommand(engine), aliases: [] },
  dimensiongrip: { factory: (engine) => new DimensionGripCommand(engine), aliases: [] },
  edittext: { factory: (engine) => new EditTextCommand(engine), aliases: [] },
};

/** Grip-entry-only commands excluded from blank-Enter "repeat last command" --
 *  a blank Enter after a grip edit shouldn't re-arm a grip tool with nothing to act on. */
export const NON_REPEATABLE = new Set<string>(["movegrip", "gripextend", "gripresize", "dimensiongrip", "edittext"]);

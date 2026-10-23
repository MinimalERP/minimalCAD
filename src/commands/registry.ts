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
import { PolygonCommand } from "./polygon";
import { MoveCommand } from "./move";
import { CopyCommand } from "./copy";
import { RotateCommand } from "./rotate";
import { ScaleCommand } from "./scale";
import { MirrorCommand } from "./mirror";
import { PolarArrayCommand } from "./polarArray";
import { ExtendCommand, TrimCommand } from "./trim";
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
  polygon: { factory: (engine) => new PolygonCommand(engine), aliases: ["pol"] },
  move: { factory: (engine) => new MoveCommand(engine), aliases: ["m"] },
  copy: { factory: (engine) => new CopyCommand(engine), aliases: ["co", "cp"] },
  rotate: { factory: (engine) => new RotateCommand(engine), aliases: ["ro"] },
  scale: { factory: (engine) => new ScaleCommand(engine), aliases: ["s"] },
  mirror: { factory: (engine) => new MirrorCommand(engine), aliases: ["mi"] },
  polararray: { factory: (engine) => new PolarArrayCommand(engine), aliases: ["pa"] },
  trim: { factory: (engine) => new TrimCommand(engine), aliases: ["t"] },
  extend: { factory: (engine) => new ExtendCommand(engine), aliases: ["et", "ext"] },
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

const DRAW_COMMANDS = new Set([
  "line", "circle", "arc", "ellipse", "rectangle", "polygon", "text",
  "linear", "aligned", "angular", "diameter", "radius", "leader",
]);
const EDIT_COMMANDS = new Set([
  "move", "copy", "rotate", "scale", "mirror", "polararray", "trim", "extend",
  "offset", "fillet", "chamfer", "join", "explode",
]);

const MODEL_COMMANDS: Array<{ name: string; aliases: string[]; group: number }> = [
  { name: "line3d", aliases: ["l3", "l", "line", "3dline"], group: 0 },
  { name: "newsketch", aliases: ["s", "sk", "sketch"], group: 0 },
  { name: "fillet", aliases: ["f"], group: 1 },
  { name: "chamfer", aliases: ["ch", "cha"], group: 1 },
  { name: "mirror3d", aliases: ["mir", "mirror"], group: 1 },
  { name: "rotate3d", aliases: ["ro", "rot", "rotate"], group: 1 },
  { name: "extrude", aliases: ["e", "ext"], group: 2 },
  { name: "revolve", aliases: ["r", "rev"], group: 2 },
  { name: "hole", aliases: ["h"], group: 2 },
  { name: "pattern", aliases: ["pat"], group: 2 },
  { name: "circpattern", aliases: ["cpat", "circular"], group: 2 },
  { name: "measureangle", aliases: ["mea", "measure", "ma", "ang", "angle"], group: 2 },
  { name: "measuredist", aliases: ["di", "dist", "distance"], group: 2 },
  { name: "sheetmetal", aliases: ["sm", "sheet"], group: 2 },
  { name: "workplane", aliases: ["wp", "plane", "ucs"], group: 2 },
];

/** Prefix matches are ranked by workflow: draw, edit, then other commands.
 * Within a group, an exact command or shortcut wins over a longer prefix. */
export function commandSuggestions(query: string, workspace: "2d" | "3d" = "2d"): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const entries = workspace === "3d"
    ? MODEL_COMMANDS
    : Object.entries(COMMAND_REGISTRY)
      .filter(([name]) => !name.endsWith("grip") && !name.startsWith("grip") && name !== "edittext")
      .map(([name, entry]) => ({
        name,
        aliases: entry.aliases,
        group: DRAW_COMMANDS.has(name) ? 0 : EDIT_COMMANDS.has(name) ? 1 : 2,
      }));
  return entries
    .filter(({ name, aliases }) => name.startsWith(q) || aliases.some((alias) => alias.startsWith(q)))
    .sort((a, b) => {
      if (a.group !== b.group) return a.group - b.group;
      const exactA = a.name === q || a.aliases.includes(q) ? 0 : 1;
      const exactB = b.name === q || b.aliases.includes(q) ? 0 : 1;
      return exactA - exactB;
    })
    .map(({ name }) => name);
}

/** Grip-entry-only commands excluded from blank-Enter "repeat last command" --
 *  a blank Enter after a grip edit shouldn't re-arm a grip tool with nothing to act on. */
export const NON_REPEATABLE = new Set<string>(["movegrip", "gripextend", "gripresize", "dimensiongrip", "edittext"]);

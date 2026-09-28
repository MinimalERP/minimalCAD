/**
 * MinimalCAD Web
 * part/params.ts
 *
 * Feature-value expressions ("50", "d1*2+5") evaluated against the part's
 * parameter table. Arithmetic is the command bar's own safe parser
 * (input/dynamicInput.ts's evalNumber, no eval()); this only adds name
 * lookup, by substituting each identifier with its already-resolved value.
 */

import { evalNumber } from "../input/dynamicInput";
import type { Parameter } from "./types";

const IDENT = /[A-Za-z_][A-Za-z0-9_]*/g;

/** Evaluates `expr`, or null if it is malformed or names an unknown parameter. */
export function evalExpression(expr: string, values: ReadonlyMap<string, number>): number | null {
  let unknown = false;
  const substituted = expr.replace(IDENT, (name) => {
    const value = values.get(name);
    if (value === undefined) {
      unknown = true;
      return "0";
    }
    return `(${value})`;
  });
  return unknown ? null : evalNumber(substituted);
}

/** Resolves every parameter in table order (each may use earlier ones).
 *  Unresolvable ones are simply absent from the result. */
export function resolveParameters(params: readonly Parameter[]): Map<string, number> {
  const values = new Map<string, number>();
  for (const p of params) {
    const value = evalExpression(p.expr, values);
    if (value !== null) values.set(p.name, value);
  }
  return values;
}

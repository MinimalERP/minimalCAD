/**
 * MinimalCAD Web
 * input/dynamicInput.ts
 *
 * Ported from dynamic_input.py. Every parse function here returns `null` on
 * any failure (malformed syntax, div-by-zero, garbage input) -- NEVER
 * throws -- since commands call these on live user keystrokes.
 *
 * evalNumber() is a hand-rolled recursive-descent parser restricted to
 * `+ - * / ( )`, unary +/-, and plain decimal number literals (no exponent
 * notation, no functions, no variables) -- the direct equivalent of the
 * Python source's `ast.parse()` + whitelisted-AST-walk approach. This is
 * deliberate: `eval()`/`Function()` on raw user input is never acceptable
 * here, safe or not.
 */

import type { Point } from "../core/types";

// --- evalNumber: tokenizer + recursive-descent parser ---

type TokenType = "number" | "+" | "-" | "*" | "/" | "(" | ")";
interface Token {
  type: TokenType;
  value?: number;
}

function tokenize(text: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === " " || ch === "\t") {
      i++;
      continue;
    }
    if (ch === "+" || ch === "-" || ch === "*" || ch === "/" || ch === "(" || ch === ")") {
      tokens.push({ type: ch });
      i++;
      continue;
    }
    const isDigit = ch !== undefined && ch >= "0" && ch <= "9";
    if (isDigit || ch === ".") {
      let j = i;
      let sawDot = false;
      while (j < text.length) {
        const c = text[j];
        if (c !== undefined && c >= "0" && c <= "9") {
          j++;
        } else if (c === "." && !sawDot) {
          sawDot = true;
          j++;
        } else {
          break;
        }
      }
      const numText = text.slice(i, j);
      if (numText === "." || numText === "") return null;
      const value = Number(numText);
      if (!Number.isFinite(value)) return null;
      tokens.push({ type: "number", value });
      i = j;
      continue;
    }
    return null; // unrecognized character
  }
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private consume(type: TokenType): boolean {
    const tok = this.peek();
    if (tok !== undefined && tok.type === type) {
      this.pos++;
      return true;
    }
    return false;
  }

  /** expr := term (('+' | '-') term)* */
  parseExpr(): number | null {
    let value = this.parseTerm();
    if (value === null) return null;
    for (;;) {
      if (this.consume("+")) {
        const rhs = this.parseTerm();
        if (rhs === null) return null;
        value = value + rhs;
      } else if (this.consume("-")) {
        const rhs = this.parseTerm();
        if (rhs === null) return null;
        value = value - rhs;
      } else {
        break;
      }
    }
    return value;
  }

  /** term := factor (('*' | '/') factor)* */
  private parseTerm(): number | null {
    let value = this.parseFactor();
    if (value === null) return null;
    for (;;) {
      if (this.consume("*")) {
        const rhs = this.parseFactor();
        if (rhs === null) return null;
        value = value * rhs;
      } else if (this.consume("/")) {
        const rhs = this.parseFactor();
        if (rhs === null || rhs === 0) return null;
        value = value / rhs;
      } else {
        break;
      }
    }
    return value;
  }

  /** factor := ('+' | '-') factor | primary */
  private parseFactor(): number | null {
    if (this.consume("-")) {
      const value = this.parseFactor();
      return value === null ? null : -value;
    }
    if (this.consume("+")) {
      return this.parseFactor();
    }
    return this.parsePrimary();
  }

  /** primary := NUMBER | '(' expr ')' */
  private parsePrimary(): number | null {
    const tok = this.peek();
    if (tok === undefined) return null;

    if (tok.type === "number") {
      this.pos++;
      return tok.value!;
    }
    if (tok.type === "(") {
      this.pos++;
      const value = this.parseExpr();
      if (value === null) return null;
      if (!this.consume(")")) return null;
      return value;
    }
    return null;
  }

  atEnd(): boolean {
    return this.pos >= this.tokens.length;
  }
}

/** Safe arithmetic expression evaluator: `+ - * / ( )`, unary sign, decimal
 *  literals only. Returns null on any parse/runtime failure, never throws. */
export function evalNumber(text: string | null | undefined): number | null {
  if (text === null || text === undefined) return null;
  const trimmed = text.trim();
  if (trimmed === "") return null;

  const tokens = tokenize(trimmed);
  if (tokens === null || tokens.length === 0) return null;

  const parser = new Parser(tokens);
  const value = parser.parseExpr();
  if (value === null || !parser.atEnd()) return null;
  if (!Number.isFinite(value)) return null;
  return value;
}

// --- Higher-level point/value grammars, shared by every drawing/transform command ---

/**
 * Parses a typed point/offset string into an absolute Point.
 *
 * Supported formats:
 *   "12,7"     -> relative offset (dx, dy) from `origin` (or absolute if origin is null)
 *   "@12,7"    -> same as above, '@' accepted for familiarity
 *   "50"       -> distance only, applied along `currentAngle` (radians) from `origin`
 *   "50<30"    -> distance<angle, angle in degrees, counter-clockwise from +X
 *
 * Typed values use AutoCAD's convention -- +Y is UP the screen, angles are
 * counter-clockwise -- while the drawing's world space is Y-down (the
 * desktop-compatible storage, see core/document.ts). So typed Y and typed
 * angles are flipped here, in this one place; `currentAngle` is already a
 * world angle and needs no flip.
 *   "50/30"    -> same as "50<30"; '/' is a no-Shift alternative key to '<'
 */
export function parsePoint(text: string, origin: Point | null, currentAngle = 0.0): Point | null {
  let t = text.trim();
  if (t === "") return null;
  if (t.startsWith("@")) t = t.slice(1);

  let dx: number;
  let dy: number;

  if (t.includes("<") || t.includes("/")) {
    const sep = t.includes("<") ? "<" : "/";
    const sepIdx = t.indexOf(sep);
    const distStr = t.slice(0, sepIdx);
    const angleStr = t.slice(sepIdx + 1);
    const dist = evalNumber(distStr);
    const angleDeg = evalNumber(angleStr);
    if (dist === null || angleDeg === null) return null;
    const angle = (angleDeg * Math.PI) / 180;
    dx = dist * Math.cos(angle);
    dy = -dist * Math.sin(angle); // CCW, Y up
  } else if (t.includes(",")) {
    const commaIdx = t.indexOf(",");
    const dxStr = t.slice(0, commaIdx);
    const dyStr = t.slice(commaIdx + 1);
    const parsedDx = evalNumber(dxStr);
    const parsedDy = evalNumber(dyStr);
    if (parsedDx === null || parsedDy === null) return null;
    dx = parsedDx;
    dy = -parsedDy; // Y up
  } else {
    const dist = evalNumber(t);
    if (dist === null) return null;
    dx = dist * Math.cos(currentAngle);
    dy = dist * Math.sin(currentAngle);
  }

  return origin === null ? { x: dx, y: dy } : { x: origin.x + dx, y: origin.y + dy };
}

export function parsePositiveFloat(text: string): number | null {
  const value = evalNumber(text);
  return value !== null && value > 0 ? value : null;
}

/** "a,b" -> [a,b], both required to evaluate to a positive number. */
export function parseTwoPositiveFloats(text: string): [number, number] | null {
  const t = text.trim();
  const commaIdx = t.indexOf(",");
  if (commaIdx === -1) return null;
  const a = evalNumber(t.slice(0, commaIdx));
  const b = evalNumber(t.slice(commaIdx + 1));
  if (a === null || b === null || a <= 0 || b <= 0) return null;
  return [a, b];
}

/**
 * "r25"/"R25" -> radius 25; "d25"/"D25" -> diameter 25 (radius 12.5);
 * bare "25" -> radius 25 (not diameter -- matches the desktop app's fix).
 */
export function parseCircleRadius(text: string): number | null {
  const t = text.trim();
  if (t === "") return null;

  const prefix = t[0]!.toLowerCase();
  if (prefix === "r") {
    const value = evalNumber(t.slice(1));
    return value !== null && value > 0 ? value : null;
  }
  if (prefix === "d") {
    const value = evalNumber(t.slice(1));
    return value !== null && value > 0 ? value / 2.0 : null;
  }
  const value = evalNumber(t);
  return value !== null && value > 0 ? value : null;
}

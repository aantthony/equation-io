/**
 * Compile an Expr to a flat stack program for fast repeated evaluation.
 *
 * The OG-image renderer samples fields at every pixel; walking the AST per
 * sample is too slow and Workers forbid dynamic codegen (`new Function`), so
 * expressions compile once to opcode arrays run by a small stack machine.
 */
import type { Expr } from '../lib/expr.ts';

const enum Op { Const, Var, Add, Sub, Mul, Div, Pow, Neg, Fn1, Fn2 }

const FN1: Record<string, (x: number) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  sech: x => 1 / Math.cosh(x),
  asinh: Math.asinh, acosh: Math.acosh, atanh: Math.atanh,
  sqrt: Math.sqrt, abs: Math.abs, exp: Math.exp, ln: Math.log, log: Math.log10,
  floor: Math.floor, ceil: Math.ceil, round: Math.round, sign: Math.sign,
  fract: x => x - Math.floor(x),
  re: x => x, im: () => 0, arg: x => (x < 0 ? Math.PI : 0), conj: x => x,
};

const FN2: Record<string, (a: number, b: number) => number> = {
  atan2: Math.atan2, min: Math.min, max: Math.max,
  mod: (a, b) => a - Math.floor(a / b) * b,
};

const FN1_NAMES = Object.keys(FN1);
const FN2_NAMES = Object.keys(FN2);

export interface Prog {
  code: number[];
  consts: number[];
  /** Stack slots needed at runtime. */
  depth: number;
}

/**
 * Compile `e` against a fixed variable layout: slots[name] is an index into
 * the `vars` array passed to run(). Throws on names or calls it can't handle
 * (e.g. complex-only forms) — callers treat that as "no preview for this row".
 */
export function compileProg(e: Expr, slots: ReadonlyMap<string, number>): Prog {
  const code: number[] = [];
  const consts: number[] = [];
  let depth = 0;
  let maxDepth = 0;
  const push = (n: number) => { depth += n; if (depth > maxDepth) maxDepth = depth; };
  const emit = (node: Expr): void => {
    switch (node.kind) {
      case 'num':
        code.push(Op.Const, consts.length);
        consts.push(node.value);
        push(1);
        return;
      case 'var': {
        const slot = slots.get(node.name);
        if (slot === undefined) throw new Error(`Unbound variable: ${node.name}`);
        code.push(Op.Var, slot);
        push(1);
        return;
      }
      case 'neg':
        emit(node.a);
        code.push(Op.Neg, 0);
        return;
      case 'bin': {
        emit(node.a);
        emit(node.b);
        const op = { '+': Op.Add, '-': Op.Sub, '*': Op.Mul, '/': Op.Div, '^': Op.Pow }[node.op];
        code.push(op, 0);
        push(-1);
        return;
      }
      case 'call': {
        for (const a of node.args) emit(a);
        if (node.args.length === 1 && node.name in FN1) {
          code.push(Op.Fn1, FN1_NAMES.indexOf(node.name));
        } else if (node.args.length === 2 && node.name in FN2) {
          code.push(Op.Fn2, FN2_NAMES.indexOf(node.name));
          push(-1);
        } else {
          throw new Error(`Cannot evaluate ${node.name}() here.`);
        }
        return;
      }
      default:
        throw new Error(`Cannot evaluate a ${node.kind} node numerically.`);
    }
  };
  emit(e);
  return { code, consts, depth: maxDepth };
}

const FN1_TABLE = FN1_NAMES.map(n => FN1[n]);
const FN2_TABLE = FN2_NAMES.map(n => FN2[n]);

export function run(p: Prog, vars: ArrayLike<number>, stack: Float64Array): number {
  const { code, consts } = p;
  let sp = 0;
  for (let i = 0; i < code.length; i += 2) {
    const arg = code[i + 1];
    switch (code[i]) {
      case Op.Const: stack[sp++] = consts[arg]; break;
      case Op.Var: stack[sp++] = vars[arg]; break;
      case Op.Add: sp--; stack[sp - 1] += stack[sp]; break;
      case Op.Sub: sp--; stack[sp - 1] -= stack[sp]; break;
      case Op.Mul: sp--; stack[sp - 1] *= stack[sp]; break;
      case Op.Div: sp--; stack[sp - 1] /= stack[sp]; break;
      case Op.Pow: sp--; stack[sp - 1] = Math.pow(stack[sp - 1], stack[sp]); break;
      case Op.Neg: stack[sp - 1] = -stack[sp - 1]; break;
      case Op.Fn1: stack[sp - 1] = FN1_TABLE[arg](stack[sp - 1]); break;
      case Op.Fn2: sp--; stack[sp - 1] = FN2_TABLE[arg](stack[sp - 1], stack[sp]); break;
    }
  }
  return stack[sp - 1];
}

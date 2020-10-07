import Tokenzier, { Token, PatternDict } from './tokenizer';
import parse, { ParseError, drainStack, parsePartial, Operator, OperatorDict, BinaryInfix, Prefix, Postfix } from './parser';

const ops: OperatorDict = {
  ';': BinaryInfix('Statements', 10),
  '->': BinaryInfix('Rule', 10),
  '//.': BinaryInfix('ReplaceRepeated', 10),
  '=': BinaryInfix('Equal', 10),
  '==': BinaryInfix('SameQ', 10),
  '!=': BinaryInfix('UnsameQ', 10),
  '!!': BinaryInfix('TrueQ', 10),
  '<': BinaryInfix('Less', 10),
  '<=': BinaryInfix('LessEqual', 10),
  '>': BinaryInfix('Greater', 10),
  '>=': BinaryInfix('GreaterEqual', 10),
  ',': BinaryInfix('Series', 11, true),
  ':': BinaryInfix('Property', 12),
  '=>': BinaryInfix('Lambda', 13, true),

  '-': BinaryInfix('Minus', 15),
  '−': BinaryInfix('Minus', 15),
  '+': BinaryInfix('Plus', 15),
  default: BinaryInfix('Default', 18),
  '/': BinaryInfix('Divide', 20),
  '÷': BinaryInfix('Divide', 20),
  '¬': Prefix('Not', 20),
  '*': BinaryInfix('Times', 20),
  '×': BinaryInfix('Times', 20),
  '^': BinaryInfix('Power', 25, true),
  '.': BinaryInfix('Dot', 30),
  '!': Postfix('Factorial', 80),
};

function isStringCandidate(x: string): boolean {
  const c0 = x[0];
  if (c0 !== '"' && c0 !== '\'') return false;
  if (x.length === 2) return true;
  const secondLast = x[x.length - 2];
  if (secondLast === c0) {
    const thirdLast = x[x.length - 3];
    if (thirdLast !== '\\') return false;
  }
  return true;
}

const syntax: PatternDict = {
  parenopen: /^[\(\{\[]$/,
  parenclose: /^[\)\}\]]$/,
  number: /^\d+(\.\d+)*$/,
  whitespace: /\s$/,
  symbol: /[A-Za-z]$/,
  string: isStringCandidate,
  operator: x => !!ops[x],
  invalid(x) { throw new Error(`Invalid character: ${x}.`); }
};

export const tokenize = Tokenzier(syntax);

const implicit: Token = {
  type: 'operator',
  str: 'default',
  line: -1,
  loc: [-1,-1],
}

function addImplicitTokens(tokens: Token[]): Token[] {
  return tokens
  .filter(t => t.type !== 'whitespace')
  .reduce((out, token) => {
    const last = out[out.length - 1];
    if (last) {
      if (token.type === 'parenopen') {
        if (last.type !== 'operator' && last.type !== 'parenopen') {
          out.push(implicit);
        }
      } else if (token.type === 'number' || token.type === 'symbol') {
        if (last.type === 'number' || last.type === 'symbol') {
          out.push(implicit);
        }
      }
    }
    out.push(token);
    return out;
  }, [] as Token[]);
}

interface Type {
  name: string;
}

function walk<T>(
  rpn: Token[],
  build: (token: Token) => T,
  apply: (op: Operator, args: T[]) => T,
): T {
  const stack: T[] = [];
  rpn.forEach(tok => {
    if (tok.type === 'operator') {
      const op = ops[tok.str]!;
      const args = stack.splice(stack.length - op.n);
      stack.push(apply(op, args));
    } else {
      stack.push(build(tok));
    }
  });
  return stack[0];
}

export interface AstNode {
  name: string;
  args: AstNode[];
  value?: string;
}

function createLeaf(token: Token): AstNode {
  return {
    name: token.type,
    args: [],
    value: token.str,
  };
}

function createNode(op: Operator, args: AstNode[]): AstNode {
  return {
    name: op.name,
    args: args,
  };
}

type LangPrimitive = 'any' | 'number' | 'string' | 'true' | 'false' | 'boolean' | 'unknown' | 'never';

interface CustomType {
  name: string;
  args: LangType[];
}

type LangType = LangPrimitive | CustomType;

function simplify(type: LangType): LangType {
  if (typeof type === 'string') return type;
  switch (type.name) {
    case 'Intersect': {
      const a = type.args[0];
      if (a === 'false' || a === 'true') return 'boolean';
      if (typeof a === 'string') return a;
    }
  }
  return type;
}

function construct(name: string, args: LangType[]): LangType {
  const p = <CustomType>{
    name,
    args,
  };
  return simplify(p);
}

type T = LangType;

const Types = {
  Array: (x: T) => construct('Array', [x]),
  Function: (args: T[], returns: T) => construct('Function', [Types.Tuple(args), returns]),
  Intersect: (a: T) => construct('Intersect', [a]),
  Boolean: () => 'boolean',
  Number: () => 'number',
  Tuple: (vals: LangType[]) => {
    return construct('Tuple', vals);
  }
}

function unpack(type: LangType, name: string): LangType[] | null {
  if (typeof type === 'string') return null;
  if (type.name === name) return type.args;
  return null;
}

const TYPE_ANY = 'any';

function accessProp(type: LangType, key: string): LangType {
  return type;
}

interface LangDeclaration {
  type: LangType;
  name: string;
}

interface IScope {
  fork(defns: LangDeclaration[]): IScope;
  get(name: string): LangDeclaration | undefined;
  error(message: string): void;
  assert(name: string, type: LangType): LangDeclaration;
}

type ScopeDict = {[key: string]: LangDeclaration};

class Scope implements IScope {
  parent: Scope | null;
  values: ScopeDict;
  errors: string[];
  infer: ScopeDict;
  constructor(parent: Scope | null, values: ScopeDict) {
    this.parent = parent;
    this.values = values;
    this.errors = [];
    this.infer = {};
  }
  fork(values: LangDeclaration[]) {
    const dict = values.reduce((all, def) => {
      all[def.name] = def;
      return all;
    }, <ScopeDict>{})
    return new Scope(this, dict);
  }
  get(name: string): LangDeclaration | undefined {
    const v = this.values[name];
    if (v) return v;
    if (this.parent) return this.parent.get(name);
    return undefined;
  }
  error(message: string) {
    if (!this.parent) {
      this.errors.push(message);
      return;
    }
    this.parent.error(message);
  }
  assert(name: string, type: LangType): LangDeclaration {
    const existing = this.get(name);
    if (existing) {
      if (!sat(existing.type, type)) {
        this.error(`Expected ${inspectType(type)} for ${name}, but got ${existing.type} instead.`);
      }

      existing.type = and(existing.type, type);

      return existing;
    }

    this.error(`${name} is not defined.`);
    return {
      name,
      type,
    };
  }
}

function forEach(target: AstNode, fn: (v: AstNode) => void) {
  if (target.name === 'Series') {
    target.args.forEach(arg => forEach(arg, fn));
    return;
  }
  fn(target);
}

function enumerate(target: AstNode): AstNode[] {
  const res: AstNode[] = [];
  forEach(target, c => res.push(c));
  return res;
}

function symbolName(target: AstNode): string {
  if (target.name === 'symbol') return target.value!;
  throw new Error(`Expected a symbol, got ${target.name} instead.`);
}

function createTypeDefinition(target: AstNode, scope: IScope): LangType {
  if (target.name === 'symbol') {
    if (target.value === 'string') return 'string';
    if (target.value === 'number') return 'number';
    if (target.value === 'boolean') return 'boolean';
    if (target.value === 'true') return 'true';
    if (target.value === 'false') return 'false';
    if (target.value === 'never') return 'never';
    if (target.value === 'any') return 'any';
    if (target.value === 'unknown') return 'unknown';
    const lookup = scope.get(target.value!);
    if (!lookup) {
      throw new Error(`Unknown type: ${target.value}`);
    }
  }
  throw new Error(`Unknown type: type=${target.name}`);
}

function readDeclaration(target: AstNode, scope: IScope): LangDeclaration {
  if (target.name === 'Property') {
    return {
      name: symbolName(target.args[0]),
      type: createTypeDefinition(target.args[1], scope),
    }
  }

  return {
    name: symbolName(target),
    type: 'unknown',
  };
}

const ROOT_SCOPE: ScopeDict = {
  true: <LangDeclaration>{ name: 'true', type: 'true' },
  false: <LangDeclaration>{ name: 'false', type: 'false' },
};

export function check(node: AstNode) {
  const scope = new Scope(null, ROOT_SCOPE);
  const type = typeCheckInscope(node, scope);
  return { type, scope };
}

const BINARY_MATH_OPS = [
  'Plus',
  'Times',
  'Divide',
  'Minus',
  'Power',
];

function inspectType(type: LangType): string {
  return type.toString();
}

function sat(subject: LangType, condition: LangType): boolean {
  if (subject === 'unknown') return true;
  if (condition === 'any') return true;
  if (condition === 'unknown') return true;
  if (condition === 'number') return subject === 'number';
  if (condition === 'string') return subject === 'string';
  if (condition === 'boolean') return subject === 'boolean' || subject === 'true' || subject === 'false';
  if (condition === 'true') return subject === 'boolean';
  if (condition === 'false') return subject === 'boolean';
  return false;
}

function is(subject: LangType, condition: LangType): boolean {
  const int = unpack(condition, 'Intersect');
  if (int) {
    return sat(subject, int[0]);
  }
  if (condition === 'any') return true;
  if (condition === 'unknown') return true;
  if (condition === 'number') return subject === 'number';
  if (condition === 'string') return subject === 'string';
  if (condition === 'boolean') return subject === 'boolean' || subject === 'true' || subject === 'false';
  if (condition === 'true') return subject === 'boolean';
  if (condition === 'false') return subject === 'boolean';
  return false;
}

function and(a: LangType, b: LangType): LangType {
  if (a === b) return a;
  const int = unpack(b, 'Intersect');
  if (int && int[0] === a) return a;

  if (a === 'unknown') return b;
  if (b === 'unknown') return a;
  return a;
}

function typeCheckInscope(node: AstNode, scope: IScope, required?: LangType): LangType {
  if (node.name === 'number') return 'number';
  if (node.name === 'string') return 'string';

  if (node.name === 'Lambda') {
    const defn = node.args[1];

    const fnArgs = enumerate(node.args[0])
    .map(arg => readDeclaration(arg, scope));

    const s = scope.fork(fnArgs);
    const retType = typeCheckInscope(defn, s);

    return Types.Function(fnArgs.map(a => a.type), retType);
  }

  if (node.name === 'symbol') {
    const name = node.value!;
    const def = scope.assert(name, required || 'unknown');
    return def.type;
  }

  if (node.name === 'Statements') {
    const [defScope, retType] = node.args.reduce((last: [IScope, LangType], arg: AstNode): [IScope, LangType] => {
      const oScope = last[0];
      const rType = typeCheckInscope(arg, oScope);
      if (arg.name === 'Equal') {
        const lhs = arg.args[0];
        const declr = readDeclaration(lhs, oScope);
        const nScope = scope.fork([declr]);
        return [nScope, rType];
      }
      return [oScope, rType] as any;
    }, <[IScope, LangType]>[scope, 'never'])
    return retType;
  }

  if (BINARY_MATH_OPS.indexOf(node.name) !== -1) {
    const types = node.args.map(arg => {
      return typeCheckInscope(arg, scope, 'number');
    });
    if (!types.every(t => is(t, 'number'))) {
      scope.error(`The ${node.name} operator expected [number,number], but got [${types.map(inspectType).join(',')}].`);
    }
    return 'number';
  }

  if (node.name === 'SameQ' || node.name ==='UnsameQ') {
    const first = typeCheckInscope(node.args[0], scope);
    const conforms = Types.Intersect(first);
    const others = node.args.slice(1).map(arg => {
      return typeCheckInscope(arg, scope, conforms);
    });
    if (!others.every(t => is(t, conforms))) {
      scope.error(`Type mismatch for ${node.name}: Got [${others.map(inspectType).join(',')}].`);
    }
    return 'boolean';
  }

  return 'unknown';
}

export function build(rpn: Token[]): AstNode {
  return walk(rpn, createLeaf, createNode);
}

export default function evaluate(string: string): AstNode {
  const tokens = tokenize(string);
  const implicit = addImplicitTokens(tokens);
  const rpn = parse(implicit, ops);
  const ast = build(rpn);
  return ast;
}

export function partial(string: string): {
  error: ParseError | null,
  tokens: Token[],
  stack: Token[],
  output: Token[],
  ast: AstNode | null,
} {
  const tokens = tokenize(string);
  const implied = addImplicitTokens(tokens);
  const stack: Token[] = [];
  try {
    const output = parsePartial(stack, implied, ops);
    const canDrain = !stack.some(t => t.type === 'parenopen');
    if (canDrain) drain(stack, output);
    const ast = canDrain ? build(output) : null;

    return {
      error: null,
      ast,
      tokens,
      stack,
      output,
    };
  } catch (error) {
    if (error.token) {
      return {
        tokens,
        error,
        stack: [],
        output: [],
        ast: null,
      };
    }
    throw error;
  }
}

export function drain(stack: Token[], output: Token[]) {
  drainStack(stack, output);
  return output;
}

export function format(rpn: Token[]): string {
  return rpn.map(t => t.str).join(' ');
}
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
  args: CustomType[];
}

type LangType = LangPrimitive | CustomType;

function createArrayType(base: LangType): LangType {
  return <CustomType>{
    name: 'Array',
    args: [base],
  };
}

function createFnType(args: LangType[], returns: LangType): LangType {
  return <CustomType>{
    name: 'Function',
    args: [args, returns],
  };
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
}

type ScopeDict = {[key: string]: LangDeclaration};

class Scope implements IScope {
  parent: Scope | null;
  values: ScopeDict;
  errors: string[];
  constructor(parent: Scope | null, values: ScopeDict) {
    this.parent = parent;
    this.values = values;
    this.errors = [];
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

export function check(node: AstNode) {
  const scope = new Scope(null, {});
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
  if (condition === 'any') return true;
  if (condition === 'unknown') return true;
  if (condition === 'number') return subject === 'number';
  if (condition === 'string') return subject === 'string';
  if (condition === 'boolean') return subject === 'boolean' || subject === 'true' || subject === 'false';
  if (condition === 'true') return subject === 'boolean';
  if (condition === 'false') return subject === 'boolean';
  return false;
}

function typeCheckInscope(node: AstNode, scope: IScope): LangType {
  if (node.name === 'number') return 'number';
  if (node.name === 'string') return 'string';
  if (node.name === 'symbol') {
    if (node.value === 'true') return 'true';
    if (node.value === 'false') return 'false';
  }
  if (node.name === 'Lambda') {
    const defn = node.args[1];

    const fnArgs = enumerate(node.args[0])
    .map(arg => readDeclaration(arg, scope));

    console.log({ fnArgs });
    const s = scope.fork(fnArgs);
    const retType = typeCheckInscope(defn, s);

    return createFnType(fnArgs.map(a => a.type), retType);
  }

  if (node.name === 'symbol') {
    const def = scope.get(node.value!);
    if (!def) throw new Error(`${node.value!} is not defined.`);
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
      return typeCheckInscope(arg, scope);
    });
    if (!types.every(t => t === 'number')) {
      scope.error(`The ${node.name} operator expected [number,number], but got [${types.map(inspectType).join(',')}].`);
    }
    return 'number';
  }

  if (node.name === 'SameQ' || node.name ==='UnsameQ') {
    const types = node.args.map(arg => {
      return typeCheckInscope(arg, scope);
    });
    if (!types.every(t => sat(t, types[0]))) {
      scope.error(`Type mismatch for ${node.name}: Got [${types.map(inspectType).join(',')}].`);
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
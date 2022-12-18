import shuntingFull, { BinaryInfix, OperatorDict, ParseError, Postfix, Prefix, shuntingDrain, shuntingPartial } from './parser';
import Tokenzier, { PatternDict, Token } from './tokenizer';

import build, { AstNode } from './ast';

const ops: OperatorDict = {
  ';': BinaryInfix('Statements', 10),
  '->': BinaryInfix('Rule', 10),
  '//.': BinaryInfix('ReplaceRepeated', 10),
  '=': BinaryInfix('Equal', 10),
  '==': BinaryInfix('SameQ', 10),
  '||': BinaryInfix('Or', 10),
  '&&': BinaryInfix('And', 10),
  '|': BinaryInfix('Or', 10),
  '&': BinaryInfix('And', 10),
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
  '': BinaryInfix('Default', 18),
  '/': BinaryInfix('Divide', 20),
  '÷': BinaryInfix('Divide', 20),
  '¬': Prefix('Not', 20),
  '*': BinaryInfix('Times', 20),
  '×': BinaryInfix('Times', 20),
  '^': BinaryInfix('Power', 25, true),
  '.': BinaryInfix('Dot', 30),
  '!': Postfix('Factorial', 80),

  '}': BinaryInfix('Curly', -1),
  ')': BinaryInfix('Paren', -1),
  ']': BinaryInfix('Bracket', -1),
};

const MULTI_CHAR_OPS = Object.keys(ops).filter(o => o.length > 1);

function isOpCandidate(x: string) {
  if (ops[x]) return true;
  return MULTI_CHAR_OPS.some(m => m.startsWith(x));
  return false;
}

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
  operator: isOpCandidate,
  invalid(x) { throw new Error(`Invalid character: ${x}.`); }
};

const raw = Tokenzier(syntax);

const implicit: Token = {
  type: 'operator',
  str: '',
  line: -1,
  loc: [-1,-1],
}

function addImplicitTokens(tokens: Token[]): Token[] {
  const out: Token[] = [];
  let last: Token | null = null;

  tokens.forEach((token) => {
    if (token.type === 'whitespace') {
      out.push(token);
      return;
    }

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
    last = token;
  });
  return out;
}

function tokenize(str: string): Token[] {
  const base = raw(str);
  const implicit = addImplicitTokens(base);
  return implicit;
}

export function full(str: string): AstNode {
  const tokens = tokenize(str);
  const rpn = shuntingFull(tokens, ops);
  const ast = build(ops, rpn);
  return ast;
}

export function partial(string: string) {
  const tokens = tokenize(string);
  const stack: Token[] = [];

  let error: ParseError | null = null;
  let output: AstNode | null = null;

  try {
    const rpn = shuntingPartial(stack, tokens, ops);
    const canDrain = !stack.some(t => t.type === 'parenopen');
    if (canDrain) shuntingDrain(stack, rpn);
    output = canDrain ? build(ops, rpn) : null;
  } catch (e) {
    if (e instanceof ParseError) {
      error = e;
    } else {
      throw e;
    }
  }

  return {
    error,
    tokens,
    stack,
    output,
  };
}
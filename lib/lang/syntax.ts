import { walk } from './ast';
import { BinaryInfix, Operator, OperatorDict, Postfix, Prefix, shunting } from './parser';
import Tokenzier, { PatternDict, Token } from './tokenizer';

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
  symbol: /[A-Za-z_]$/,
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

function addImplicitTokens(emit: (tok: Token) => void) {
  let last: Token | null = null;

  return function (token: Token) {
    if (token.type === 'whitespace') {
      emit(token);
      return;
    }

    if (last) {
      if (token.type === 'parenopen') {
        if (last.type !== 'operator' && last.type !== 'parenopen') {
          emit(implicit);
        }
      } else if (token.type === 'number' || token.type === 'symbol') {
        if (last.type === 'number' || last.type === 'symbol') {
          emit(implicit);
        }
      }
    }

    emit(token);
    last = token;
  };
}

export function instance<T>(
  build: (tok: Token) => T,
  apply: (tok: Token, op: Operator, args: T[]) => T,
  emit: (o: T) => void) {
  return raw(addImplicitTokens(
    shunting(ops, walk(ops, build, apply, emit))
  ));
}
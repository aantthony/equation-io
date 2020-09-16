import Tokenzier, { Token, PatternDict } from './tokenizer';
import parse, { ParseError, drainStack, parsePartial, Operator, OperatorDict, BinaryInfix, Prefix, Postfix } from './parser';

const ops: OperatorDict = {
  ';': BinaryInfix('Equal', 10),
  '->': BinaryInfix('Rule', 10),
  '//.': BinaryInfix('ReplaceRepeated', 10),
  '=': BinaryInfix('Equal', 10),
  '===': BinaryInfix('SameQ', 10),
  '!==': BinaryInfix('UnsameQ', 10),
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
  if (x[0] !== '"') return false;
  if (x.length === 2) return true;
  const secondLast = x[x.length - 2];
  if (secondLast === '"') {
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
        if (last.type !== 'operator') {
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

export default function evaluate(string: string) {
  const rawTokens = tokenize(string);
  const tokens = addImplicitTokens(rawTokens);
  const rpn = parse(tokens, ops);
  return rpn;
}

export function partial(string: string): {
  error: ParseError | null,
  tokens: Token[],
  stack: Token[],
  output: Token[],
} {
  const tokens = tokenize(string);
  const implied = addImplicitTokens(tokens);
  const stack: Token[] = [];
  try {
    const output = parsePartial(stack, implied, ops);
    const canDrain = !stack.some(t => t.type === 'parenopen');
    if (canDrain) drain(stack, output);
    return {
      error: null,
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
import { Token } from './tokenizer';

export interface Operator {
  name: string;
  n: number;
  prec: number;
  right: boolean;
}

export const BinaryInfix = (name: string, prec: number, right: boolean = false): Operator => ({
  name,
  n: 2,
  prec,
  right,
});

export const Prefix = (name: string, prec: number): Operator => ({
  name,
  n: 1,
  prec,
  right: true,
});

export const Postfix = (name: string, prec: number): Operator => ({
  name,
  n: 1,
  prec,
  right: false,
});

function map<T,V>(t: T|null, fn: (arg0: T) => V): V | null {
  return t ? fn(t): null;
}

export type OperatorDict = {
  [key: string]: Operator;
}

function lookup(token: Token, dict: OperatorDict): Operator {
  const def = dict[token.str];
  if (!def) throw new Error(`Unknown operator: ${token.str} at ${token.line}:${token.loc[0]}.`);
  return def;
}

export class ParseError extends Error {
  token: Token;
  constructor(message: string, token: Token) {
    super(message);
    this.token = token;
  }
}

// https://rosettacode.org/wiki/Parsing/Shunting-yard_algorithm#Go
export function parsePartial(
  stack: Token[],
  tokens: Token[],
  ops: OperatorDict,
): Token[] {
  const output: Token[] = [];
  for (const tok of tokens) {
    if (tok.type === 'parenopen') {
      stack.push(tok);
    } else if (tok.type === 'parenclose') {
      while (1) {
        const op = stack.pop();
        if (!op) throw new ParseError(`Could not find open brace.`, tok);
        if (op.type === 'parenopen') break;
        output.push(op);
      }
    } else if (tok.type === 'operator') {
      const o1 = lookup(tok, ops);
      while (stack.length) {
        // consider top item on stack
        const op = stack[stack.length - 1];
        if (op.type === 'parenopen') break;
        const o2 = lookup(op, ops);
        if (o1.prec > o2.prec) break;
        if (o1.prec == o2.prec && o1.right) break;
        // top item is an operator that needs to come off
        stack.pop();
        output.push(op);
      }
      stack.push(tok);
    } else {
      output.push(tok);
    }
  }

  return output;
}

export function drainStack(stack: Token[], output: Token[]) {
  // drain stack to result
  while (stack.length) {
    const tok = stack.pop()!;
    if (tok.type === 'parenopen') {
      throw new Error(`Missing closing parentheses for bracket at ${tok.line}:${tok.loc[0]}`);
    }
    output.push(tok);
  }
  return output;
}

export default function parse(tokens: Token[], ops: OperatorDict) {
  const stack: Token[] = [];
  const output = parsePartial(stack, tokens, ops);
  drainStack(stack, output);
  const rpn = output;
  return rpn;
}
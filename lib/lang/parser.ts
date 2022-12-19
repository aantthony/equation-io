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
export function shunting(
  ops: OperatorDict,
  emit: (tok: Token) => void,
) {
  const stack: Token[] = [];
  return function write(tok: Token | null) {
    if (tok === null) {
      // drain stack to result
      while (stack.length) {
        const tok = stack.pop()!;
        if (tok.type === 'parenopen') {
          throw new Error(`Missing closing parentheses for bracket at ${tok.line}:${tok.loc[0]}`);
        }
        emit(tok);
      }
    } else if (tok.type === 'parenopen') {
      stack.push(tok);
    } else if (tok.type === 'parenclose') {
      while (1) {
        const op = stack.pop();
        if (!op) {
          // treat as EOF
          return;
          throw new ParseError(`Could not find open brace.`, tok);
        }
        if (op.type === 'parenopen') {
          // modification: Add "{" "}" to output:
          emit(op);
          emit(tok);
          break;
        }
        emit(op);
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
        emit(op);
      }
      stack.push(tok);
    } else {
      emit(tok);
    }
  }
}

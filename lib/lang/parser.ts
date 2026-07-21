import { Token } from './tokenizer.js';


export interface OperatorSpec<T> {
  n: number;
  fn(...args: T[]): T;
  right: boolean;
}

export interface Operator<T> extends OperatorSpec<T> {
  prec: number;
}

export const BinaryInfix = <T>(fn: (a: T, b: T) => T): OperatorSpec<T> => ({
  n: 2,
  fn,
  right: false,
});

export const BinaryRightInfix = <T>(fn: (a: T, b: T) => T): OperatorSpec<T> => ({
  n: 2,
  fn,
  right: true,
});

export const Infix = <T>(fn: (nodes: T[]) => T): OperatorSpec<T> => {
  // Example RPN stack 3 1 * 2 *
  // Example RPN stack 3 1 2 * *
  // The difference is that the first one is right associative, the second is left associative.
  // Left associative: (3*1)*2 +1, should be executed on "+"
  // Right associative: 3*(1*2) +1, should executee on "+"
  // That means that the * operator cannot know when to execute `fn` or when to create an internal
  // node.

  return {
    n: 2,
    fn: (a, b) => {
      return fn([a, b]);
    },
    right: true,
  };
};

export const Prefix = <T>(fn: (a: T) => T): OperatorSpec<T> => ({
  n: 1,
  right: true,
  fn,
});

export const Postfix = <T>(fn: (a: T) => T): OperatorSpec<T> => ({
  n: 1,
  right: false,
  fn,
});

export type OperatorSpecDict<T> = {
  [key: string]: OperatorSpec<T>;
  EOF: OperatorSpec<T>;
}

export type OperatorDict<T> = {
  [key: string]: Operator<T>;
  EOF: Operator<T>;
}

export function operators<T>(dict: OperatorSpecDict<T>): OperatorDict<T> {
  const out: OperatorDict<T> = {
    EOF: {...dict.EOF, prec: -1},
  };
  let prec = 0;
  for (const key in dict) {
    const op = dict[key];
    out[key] = {
      ...op,
      prec,
    };
    prec += 1;
  }
  return out;
}

function lookup<T>(token: Token, dict: OperatorDict<T>): Operator<T> {
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
export function *shunting<T>(
  ops: OperatorDict<T>,
  tokens: Iterable<Token>,
): Generator<Token, void, void> {
  const stack: Token[] = [];
  for (const tok of tokens) {
    if (tok.type === 'parenopen') {
      stack.push(tok);
    } else if (tok.type === 'parenclose') {
      while (1) {
        const op = stack.pop();
        if (!op) {
          // treat as EOF
          // return;
          throw new ParseError(`Could not find open brace.`, tok);
        }
        if (op.type === 'parenopen') {
          // modification: Add "{" "}" to output:
          yield (op);
          yield (tok);
          break;
        }
        yield (op);
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
        yield (op);
      }
      stack.push(tok);
    } else {
      yield tok;
    }
  }

  // drain stack to result
  while (stack.length) {
    const entry = stack.pop()!;
    if (entry.type === 'parenopen') {
      throw new Error(`Missing closing parentheses for bracket "${entry.str}" at ${entry.line}:${entry.loc[0]}`);
    }
    yield (entry);
  }
}

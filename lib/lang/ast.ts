import { Token } from './tokenizer';
import { Operator, OperatorDict } from './parser';

function walk<T>(
  ops: OperatorDict,
  rpn: Token[],
  build: (token: Token) => T,
  apply: (token: Token, op: Operator, args: T[]) => T,
): T {
  const stack: T[] = [];
  rpn.forEach(tok => {
    if (tok.type === 'operator' || tok.type === 'parenclose') {
      const op = ops[tok.str]!;
      const args = stack.splice(stack.length - op.n);
      stack.push(apply(tok, op, args));
    } else if (tok.type === 'parenopen') {
      // It's just a token
      stack.push(build(tok));
    } else {
      stack.push(build(tok));
    }
  });
  return stack[0];
}

export interface AstNode {
  name: string;
  args: AstNode[];
  token: Token;
  value?: string;
}

function createLeaf(token: Token): AstNode {
  return {
    token,
    name: token.type,
    args: [],
    value: token.str,
  };
}

const R_ASSOC: {[key: string]: 1} = {
  'Plus': 1,
  'Series': 1,
};

const L_ASSOC: {[key: string]: 1} = {
  'Plus': 1,
  'Series': 1,
};

const BRACKET: {[key: string]: 1} = {
  CurlyBracket: 1,
  SquareBracket: 1,
  RoundBracket: 1,
};

function createNode(token: Token, op: Operator, args: AstNode[]): AstNode {
  if (BRACKET[op.name]) {
    const bareArgs = args.splice(0, args.length - 1);

    const arrayArgs: AstNode[] = (bareArgs.length === 1 && bareArgs[0].name === 'Series')
      ? bareArgs[0].args
      : bareArgs;

    return {
      token,
      name: op.name,
      args: arrayArgs,
    };
  }
  if (L_ASSOC[op.name] && args[1] && args[1].name === op.name) {
    return {
      token,
      name: op.name,
      args: [
        args[0],
        ...args[1].args,
      ],
    };
  }
  if (R_ASSOC[op.name] && args[0] && args[0].name === op.name) {
    return {
      token,
      name: op.name,
      args: [
        ...args[0].args,
        args[1],
      ],
    };
  }
  return {
    token,
    name: op.name,
    args: args,
  };
}

export default function build(ops: OperatorDict, rpn: Token[]): AstNode {
  return walk(ops, rpn, createLeaf, createNode);
}
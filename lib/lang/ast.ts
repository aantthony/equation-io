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

function createNode(token: Token, op: Operator, args: AstNode[]): AstNode {
  return {
    token,
    name: op.name,
    args: args,
  };
}

export default function build(ops: OperatorDict, rpn: Token[]): AstNode {
  return walk(ops, rpn, createLeaf, createNode);
}
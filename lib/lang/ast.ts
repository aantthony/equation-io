import { OperatorDict } from './parser';
import { Token } from './tokenizer';

/**
 * Executes a stream of RPN tokens, invoking the leaf() callback to create leaf AST nodes,
 * and the ops dictionary to create operator AST nodes.
 */
export function walk<T>(
  ops: OperatorDict<T>,
  leaf: (token: Token) => T,
  rpn: Iterable<Token>,
  push: (node: T) => void,
  pop: (n: number) => T[],
) {
  for (const tok of rpn) {
    if (tok.type === 'operator' || tok.type === 'parenclose') {
      const op = ops[tok.str];
      if (!op) throw new Error(`Unknown operator: ${tok.str} at ${tok.line}:${tok.loc[0]}.`);

      // Pop off op.n operands:
      const args = pop(op.n);
      
      // Push the result of applying the operator:
      const result = op.fn(...args);

      push(result);
    } else {
      push(leaf(tok));
    }
  }
}

export interface AstNode {
  name: string;
  args: AstNode[];
  token: Token;
  value?: string;
}

// const R_ASSOC: {[key: string]: 1} = {
//   'Plus': 1,
//   'Series': 1,
// };

// const L_ASSOC: {[key: string]: 1} = {
//   'Plus': 1,
//   'Series': 1,
// };

// const BRACKET: {[key: string]: 1} = {
//   Curly: 1,
//   Bracket: 1,
//   Paren: 1,
// };

// function createNode(token: Token, op: Operator, args: AstNode[]): AstNode {
//   if (BRACKET[op.name]) {
//     const bareArgs = args.splice(0, args.length - 1);

//     const arrayArgs: AstNode[] = (bareArgs.length === 1 && bareArgs[0].name === 'Series')
//       ? bareArgs[0].args
//       : bareArgs;

//     return {
//       token,
//       name: op.name,
//       args: arrayArgs,
//     };
//   }
//   if (L_ASSOC[op.name] && args[1] && args[1].name === op.name) {
//     return {
//       token,
//       name: op.name,
//       args: [
//         args[0],
//         ...args[1].args,
//       ],
//     };
//   }
//   if (R_ASSOC[op.name] && args[0] && args[0].name === op.name) {
//     return {
//       token,
//       name: op.name,
//       args: [
//         ...args[0].args,
//         args[1],
//       ],
//     };
//   }
//   return {
//     token,
//     name: op.name,
//     args: args,
//   };
// }

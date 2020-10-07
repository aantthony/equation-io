import { Token } from './tokenizer';

import{ ParseError, Operator, OperatorDict, BinaryInfix, Prefix, Postfix } from './parser';

import { LangDeclaration, ScopeDict, Scope, IScope } from './scope';
import { LangType, Types, inspectType }from './types';
import build, { AstNode } from './ast';
import typeCheck from './type-check';

import { full, partial as decode } from './syntax';

const ROOT_SCOPE: ScopeDict = {
  true: <LangDeclaration>{ name: 'true', type: 'true' },
  false: <LangDeclaration>{ name: 'false', type: 'false' },
};

export function check(node: AstNode) {
  // TODO: Make ROOT_SCOPE readonly
  const scope = new Scope(null, ROOT_SCOPE);
  const type = typeCheck(node, scope);
  return { type, scope };
}

export default function parse(string: string): AstNode {
  return full(string);
}

export function partial(string: string) {
  return decode(string);
}

export function format(ast: AstNode): string {
  let str = '';
  let prefix = 0;
  function add(n: AstNode) {
    if (n.value) {
      str += ''.padEnd(prefix) + n.value;
      return;
    }
    str += ''.padEnd(prefix) + n.name + '[\n';
    prefix += 2;
    n.args.forEach((a) => {
      add(a);
      str += ',\n';
    });
    prefix -= 2;
    str += ''.padEnd(prefix) + ']';
  }

  add(ast);
  return str;
}
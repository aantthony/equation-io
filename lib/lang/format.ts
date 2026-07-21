import type { AstNode } from './ast.ts';

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
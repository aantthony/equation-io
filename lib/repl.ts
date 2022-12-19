import colorReadline from 'node-color-readline';
import 'source-map-support/register';
import { Operator } from './lang/parser';
import { instance } from './lang/syntax';
import { Token } from './lang/tokenizer';

const repl = colorReadline.createInterface({
  input: process.stdin,
  output: process.stdout,
  colorize: function (str) {
    return str;
    // const { error, tokens, stack, output } = partial(str);

    // const openParen = stack.slice(0).reverse().find(t => t.type === 'parenopen');
    // const errorToken = error ? error.token : null;

    // return tokens.map((t, i) => {
    //   if (t === errorToken) return chalk.bgRed(t.str);
    //   if (t.type === 'string') return chalk.green(t.str);
    //   if (t.type === 'number') return chalk.yellow(t.str);
    //   if (t.type === 'symbol') return chalk.magenta(t.str);
    //   if (t.type === 'parenopen' && t === openParen) return chalk.underline.white(t.str);
    //   if (t.type === 'parenopen') return chalk.white(t.str);
    //   if (t.type === 'parenclose') return chalk.white(t.str);
    //   return t.str;
    // }).join('');
  }
});

interface OnEnumerate {
  (item: MS, count: bigint): void;
}

interface MS {
  forEach(fn: OnEnumerate): void;
}

const Empty: MS = {
  forEach(fn) {}
}

function Nat(val: bigint): MS {
  if (val === 0n) return Empty;
  return {
    forEach(fn) {
      fn(Empty, val);
    }
  }
}

function isEqual(a: MS, b: MS): boolean {
  if (!a || !b) throw new Error('Invalid arguments');
  let aCount = 0n;
  let bCount = 0n;
  let aEmpty = true;
  let bEmpty = true;

  a.forEach((item, count) => {
    aCount += count;
    aEmpty = false;
  });

  b.forEach((item, count) => {
    bCount += count;
    bEmpty = false;
  });

  if (aEmpty && bEmpty) return true;
  if (aEmpty || bEmpty) return false;
  if (aCount !== bCount) return false;

  let aItems: [MS, bigint][] = [];
  let bItems: [MS, bigint][] = [];

  a.forEach((item, count) => {
    aItems.push([item, count]);
  });

  b.forEach((item, count) => {
    bItems.push([item, count]);
  });

  for (let i = 0; i < aItems.length; i++) {
    const [aItem, aCount] = aItems[i];
    const [bItem, bCount] = bItems[i];
    if (aCount !== bCount) return false;
    if (!isEqual(aItem, bItem)) return false;
  }

  return true;
}

function factor(s: MS): MS {
  let factors: [MS, bigint][] = [];
  s.forEach((item, count) => {
    let found = false;
    for (let i = 0; i < factors.length; i++) {
      const [factor, factorCount] = factors[i];
      if (isEqual(factor, item)) {
        factors[i] = [factor, factorCount + count];
        found = true;
        break;
      }
    }
    if (!found) {
      factors.push([item, count]);
    }
  });

  return {
    forEach(fn) {
      factors.forEach(([factor, count]) => {
        fn(factor, count);
      });
    }
  }
}

function countEmpty(val: MS): bigint {
  let nEmpties = 0n;
  // const nonEmpties: [MS, bigint][] = [];

  val.forEach((item, count) => {
    if (item === Empty) {
      nEmpties += count;
    } else {
      let found = false;
      item.forEach(() => { found = true; });
      if (!found) {
        nEmpties += count;
      }
    }
  });

  return nEmpties;
}

function add(args: MS[]): MS {
  return {
    forEach(fn) {
      args.forEach((arg, c) => {
        arg.forEach((item, count) => {
          fn(item, count);
        });
      });
    }
  };
}

interface Scope {
  lookup(name: string): MS;
}

// function exec(ast: AstNode, scope: Scope): MS {
//   if (ast.name === 'symbol') {
//     return scope.lookup(ast.value || '');
//   }
//   // console.log(format(ast));
//   const ld = toLeaf[ast.name];
//   if (ld) return ld(ast.value || '');

//   if (ast.name === 'Default') {
//     if (ast.args[0].name === 'symbol') {
//       const fnName = ast.args[0].value;
//       const fnArgs = ast.args[1].args;

//       if (!fnName) throw new Error('No function name');
//       const fn = Fn[fnName];
//       if (!fn) {
//         throw new Error(`Unknown function ${fnName}`);
//       }
//       return fn(fnArgs.map(i => exec(i, scope)));
//     } else if (ast.args[0].name === 'number') {
//       const n = toLeaf['number'](ast.args[0].value || '');

//       return Fn.Times([n, exec(ast.args[1], scope)]);
//     }
//   }

//   const fn = Fn[ast.name];
//   if (fn) return fn(ast.args.map(i => exec(i, scope)));
//   console.log(ast);

//   throw new Error(`Unknown function ${ast.name}`);
// }

interface TreeNode {
  name: string;
  args?: TreeNode[];
  value?: string;
}

function formatTree(ast: TreeNode): string {
  let str = '';
  let prefix = 0;
  function stringForName(name: string): string {
    if (name === 'Bracket') return '';
    return name;
  }
  function add(n: TreeNode) {
    if (n.name === 'Bracket' && n.args?.length === 1 && n.args[0].value) {
      str += ''.padEnd(prefix) + '[' + n.args[0].value + ']';
      return;
    }

    if (n.value) {
      str += ''.padEnd(prefix) + n.value;
      return;
    }
    str += ''.padEnd(prefix) + stringForName(n.name) + '[\n';
    prefix += 2;
    n.args?.forEach((a) => {
      add(a);
      str += ',\n';
    });
    prefix -= 2;
    str += ''.padEnd(prefix) + ']';
  }

  add(ast);
  return str;
}

function toTree(ms: MS): TreeNode {
  const sum: TreeNode[] = [];

  ms.forEach((item, count) => {
    if (count === 1n) {
      sum.push({
        name: 'Bracket',
        args: [toTree(item)],
      });
    } else {
      sum.push({
        name: 'Times',
        args: [
          {
            name: 'number',
            value: count.toString(),
          },
          {
            name: 'Bracket',
            args: [toTree(item)],
          },
        ]
      });
    }
  });
  
  if (sum.length === 0) {
    return {
      name: '',
      value: '0'
    };
  } else if (sum.length === 1) {
    return sum[0];
  }
  return {
    name: 'Plus',
    args: sum,
  };
}

function formatMs(ms: MS): string {
  return formatTree(toTree(ms));
}

const Fn: {
  [key: string]: (args: MS[]) => MS;
} = {
  Bracket(items) {
    return {
      forEach(fn) {
        items.forEach(i => {
          fn(i, 1n);
        });
      }
    }
  },
  Plus(args) {
    return add(args);
  },
  Times(args) {
    const a = args[0];
    const b = args[1];
    const rest = args.slice(2);

    return {
      forEach(fn) {
        a.forEach((aItem, aCount) => {
          b.forEach((bItem, bCount) => {
            fn(add([aItem, bItem]), aCount * bCount);
          });
        });
        rest.forEach(r => r.forEach(fn));
      }
    }
  },
  Divide(args) {
    const a = args[0];
    const b = args[1];
    const rest = args.slice(2);

    return {
      forEach(fn) {
        a.forEach((aItem, aCount) => {
          b.forEach((bItem, bCount) => {
            fn(add([aItem, bItem]), aCount / bCount);
          });
        });
        rest.forEach(r => r.forEach(fn));
      }
    }
  },
  Minus([a, b]) {
    return {
      forEach(fn) {
        a.forEach((aItem, aCount) => {
          b.forEach((bItem, bCount) => {
            fn(add([aItem, bItem]), aCount - bCount);
          });
        });
      }
    }
  },
  NumEmpty([arg]) {
    return Nat(countEmpty(arg));
  },
  Count([arg]) {
    let n = 0n;
    arg.forEach(
      (item, count) => {
        n += count;
      }
    );
    return Nat(n);
  },
  Unique([arg]) {
    let n = 0n;
    factor(arg).forEach(
      (item, count) => {
        n += 1n;
      }
    );

    return Nat(n);
  },
  Equal(args) {
    console.log('Equal', args);
    return Nat(1n);
    // return isEqual(a, b) ? Nat(1n) : Nat(0n);
  }
};

const saved = new Map<string, MS>();

function build(tok: Token): MS {
  if (tok.type === 'number') return Nat(BigInt(tok.str));
  throw new Error(`Unknown token ${tok.type}`);
}

function apply(tok: Token, op: Operator, args: MS[]): MS {
  const fn = Fn[op.name];
  if (fn) return fn(args);
  throw new Error(`Unknown operator ${op.name}`);
}

repl.on('line', function (cmd) {
  const scope: Scope = {
    lookup(name) {
      const res = saved.get(name);
      if (res) return res;
      throw new Error(`Unknown symbol ${name}`);
    }
  };

  const inst = instance(build, apply, res => {
    const f = factor(res);
    saved.set('_', f);
    console.log(formatMs(f));

    repl.prompt();
  });

  inst(cmd);
});

repl.prompt();
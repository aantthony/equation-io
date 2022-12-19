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
  brand?: symbol;
  s?: string;
  forEach(fn: OnEnumerate): void;
}

const Empty: MS = {
  s: '0',
  forEach(fn) {}
}

function Nat(val: bigint): MS {
  if (val === 0n) return Empty;
  return {
    s: `${val}`,
    forEach(fn) {
      fn(Empty, val);
    }
  }
}

function isEqual(a: MS, b: MS): boolean {
  if (!a || !b) throw new Error('Invalid arguments');
  let aItems: [MS, bigint][] = [];
  let bItems: [MS, bigint][] = [];

  let aTC = 0n;
  let bTC = 0n;

  a.forEach((item, count) => {
    aItems.push([item, count]);
    aTC += count;
  });

  b.forEach((item, count) => {
    bItems.push([item, count]);
    bTC += count;
  });

  if (aTC !== bTC) return false;
  if (!aItems.length && !bItems.length) return true;

  const balances: [MS, bigint][] = [];

  aItems.forEach(([item, count]) => {
    const match = bItems.find(([bItem]) => isEqual(item, bItem));
    if (match) {
      match[1] += count;
    } else {
      balances.push([item, count]);
    }
  });

  bItems.forEach(([item, count]) => {
    const match = aItems.find(([aItem]) => isEqual(item, aItem));
    if (match) {
      match[1] -= count;
    } else {
      balances.push([item, -count]);
    }
  });

  const allGood = balances.every(([item, count]) => count === 0n);

  return allGood;
}

function factor(s: MS): MS {
  let factors: [MS, bigint][] = [];
  s.forEach((item, count) => {
    let found = false;
    for (let i = 0; i < factors.length; i++) {
      const [factor, factorCount] = factors[i];
      const qSame = isEqual(factor, item);
      if (qSame) {
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

function prod(args: MS[]): MS {
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
  };
}

function div(a: MS, b: MS): MS {
  const aCount = countEmpty(a);
  const bCount = countEmpty(b);

  if (aCount === 0n && bCount === 0n) return Empty;
  if (aCount === 0n) return Nat(bCount);
  if (bCount === 0n) return Nat(aCount);

  return Nat(aCount / bCount);
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

type TreeNode =
| { name: 'Plus'; items: TreeNode[]; }
| { name: 'Multiton'; count: string; item: TreeNode; }
| { name: 'Singleton'; item: TreeNode; }
| { name: 'Empty'; }
| { name: 'Nat'; value: string; }

function formatTree(ast: TreeNode): string {
  let str = '';
  let prefix = 0;
  function _(): string {
    return ''.padEnd(prefix);
  }
  function add(n: TreeNode) {
    if (n.name === 'Empty') {
      str += `${_()}Empty\n`;
    } else if (n.name === 'Nat') {
      str += `${_()}Nat(${n.value})\n`;
    } else if (n.name === 'Multiton') {
      str += `${_()}${n.count}[\n`;
      prefix += 2;
      add(n.item);
      prefix -= 2;
      str += `${_()}]`;
    } else if (n.name === 'Plus') {
      str += `${_()}Plus[\n`;
      prefix += 2;
      n.items.forEach(add);
      prefix -= 2;
      str += `${_()}]\n`;
    } else {
      throw new Error('Unknown node type');
    }
  }

  function single(n: TreeNode): string {
    if (n.name === 'Empty') return '0';
    if (n.name === 'Nat') return n.value.toString();
    if (n.name === 'Multiton') return `${n.count}[${single(n.item)}]`;
    if (n.name === 'Singleton') return `[${single(n.item)}]`;
    if (n.name === 'Plus') return n.items.map(single).join(' + ');
    throw new Error('Unknown node type');
  }

  // add(ast);
  return single(ast);
}

function toTree(ms: MS): TreeNode {
  const items: [MS, bigint][] = [];

  ms.forEach((item, count) => {
    if (count === 0n) return;
    const found = items.find(([i]) => isEqual(i, item));
    if (found) {
      found[1] += count;
    } else {
      items.push([item, count]);
    }
  });

  if (items.length === 0) {
    return {
      name: 'Empty',
    };
  }

  if (items.length === 1) {
    // eg. 3*[2]
    const count = items[0][1];
    const item = toTree(items[0][0]);
    if (item.name === 'Empty') {
      return { name: 'Nat', value: `${count}` };
    }

    if (count === 1n) {
      return {
        name: 'Singleton',
        item,
      };
    }

    return {
      name: 'Multiton',
      count: `${count}`,
      item,
    };
  }

  return {
    name: 'Plus',
    items: items.map(([item, count]): TreeNode => {
      const i = toTree(item);
      if (count === 1n) {
        if (i.name === 'Empty') {
          return { name: 'Nat', value: '1' };
        }
        return {
          name: 'Singleton',
          item: i,
        };
      }

      if (i.name === 'Empty') {
        return { name: 'Nat', value: `${count}` };
      }

      return {
        name: 'Multiton',
        count: `${count}`,
        item: i,
      };
    }),
  };
}

function formatMs(ms: MS): string {
  const tr = toTree(ms);
  // console.log(JSON.stringify(tr, null, 2));
  return formatTree(tr);
}

const bSeries = Symbol('Series');

interface Series extends MS {
  brand?: typeof bSeries;
  items?: MS[];
}

function Series(items: MS[]): Series {
  return {
    brand: bSeries,
    items,
    forEach() {
      throw new Error('Series are intermediate datastructures passed into function arguments, and cannot be iterated');
    },
  }
}

const TRUE = Nat(1n);
const FALSE = Empty;

const Fn: {
  [key: string]: (args: MS[]) => MS;
} = {
  Series(items) {
    return Series(items);
  },
  Bracket(args) {
    const contents = args[0] as Series;
    const terminal = args[1];
    if (terminal !== null) throw new Error('Terminal not null');

    if (contents.brand === bSeries) {
      const items = contents.items!;
      return {
        forEach(fn) {
          function collect(entry: MS) {
            if (entry.brand === bSeries) {
              (entry as Series).items!.forEach(collect);
            } else {
              fn(entry, 1n);
            }
          }

          items.forEach(collect);
        }
      };
    }

    return {
      forEach(fn) {
        fn(contents, 1n);
      }
    }
  },
  Paren(args) {
    const contents = args[0];
    const terminal = args[1];
    if (terminal !== null) throw new Error('Terminal not null');

    if (contents.brand === bSeries) {
      throw new Error('Tuple not supported');
    }

    return contents;
  },
  Plus(args) {
    return add(args);
  },
  Times(args) {
    return prod(args);
  },
  Divide(args) {
    const a = args[0];
    const b = args[1];

    if (args.length !== 2) throw new Error('Divide with more than 2 arguments not supported');

    return div(a, b);
  },
  Minus([a, b]) {
    if (!b) {
      // unary minus
      return {
        forEach(fn) {
          a.forEach((aItem, aCount) => {
            fn(aItem, -aCount);
          });
        }
      };
    }

    return {
      forEach(fn) {
        a.forEach((aItem, aCount) => {
          fn(aItem, aCount);
        });
        b.forEach((bItem, bCount) => {
          fn(bItem, -bCount);
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
    if (args.length < 2) throw new Error('Equal needs at least 2 arguments');
    const a = args[0];
    const b = args[1];
    return isEqual(a, b) ? TRUE : FALSE;
  },
};

const saved = new Map<string, MS>();

function build(tok: Token): MS {
  if (tok.type === 'parenopen') return null as any;
  if (tok.type === 'number') return Nat(BigInt(tok.str));
  if (tok.type === 'symbol') {
    return saved.get(tok.str) || {
      s: tok.str,
      forEach(fn) {
        throw new Error(`Unknown symbol ${tok.str}`);
      }
    };
  }
  throw new Error(`Unknown token ${tok.type}`);
}

function apply(tok: Token, op: Operator, args: MS[]): MS {
  // console.log('apply', tok.type, op.name, args);
  if (op.name === 'Default') {
    const lhs = args[0];
    const rhs = args[1];
    
    // do a product:
    return prod([lhs, rhs]);
  }
  if (tok.type === 'parenclose') {
    const fn = Fn[op.name];
    if (fn) return fn(args);
    throw new Error(`Unknown operator ${op.name}`);
  }
  const fn = Fn[op.name];
  if (fn) return fn(args);
  throw new Error(`Unknown operator ${op.name}`);
}

function exec(str: string, emit: (ms: MS) => void) {
  instance(build, apply, emit)(str);
}

function def(name: string, str: string) {
  exec(str, ms => {
    saved.set(name, ms);
  });
}

def('a', '[1]');

def('x', '[1]');
def('y', '[2]');


// exec('(2x+y-x*x*x)*(x + 3y)', ms => {
//   factor(ms).forEach((item, count) => {
//     const s = formatMs(item);
//     console.log(s, count);
//   });
// });

repl.on('line', function (cmd) {
  const scope: Scope = {
    lookup(name) {
      const res = saved.get(name);
      if (res) return res;
      throw new Error(`Unknown symbol ${name}`);
    }
  };

  const inst = instance(build, apply, res => {
    if (!res) {
      repl.prompt();
      return;
    }
    const f = factor(res);

    // const f = res;
    saved.set('_', f);
    console.log(formatMs(res));

    repl.prompt();
  });

  inst(cmd);
});

repl.prompt();
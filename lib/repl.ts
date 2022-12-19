import colorReadline from 'node-color-readline';
import 'source-map-support/register';
import formatMs from './format';
import isEqual from './is-equal';
import { Operator } from './lang/parser';
import { instance } from './lang/syntax';
import { Token } from './lang/tokenizer';
import { Empty, MS } from './ms';

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

function Nat(val: bigint): MS {
  if (val === 0n) return Empty;
  return {
    s: `${val}`,
    forEach(fn) {
      fn(Empty, val);
    }
  }
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

function Plus(args: MS[]): MS {
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

function Times(args: MS[]): MS {
  const a = args[0];
  const b = args[1];
  const rest = args.slice(2);

  return {
    forEach(fn) {
      a.forEach((aItem, aCount) => {
        b.forEach((bItem, bCount) => {
          fn(Plus([aItem, bItem]), aCount * bCount);
        });
      });
      rest.forEach(r => r.forEach(fn));
    }
  };
}

function negate(s: MS): MS {
  return {
    forEach(fn) {
      s.forEach((item, count) => {
        fn(item, -count);
      });
    }
  };
}

/**
 * Implements polynomial division of a/b
 * 
 * First, we factor terms in a and b.
 * 
 * @param a 
 * @param b 
 */
function div(a: MS, b: MS): MS {
  console.log('Divide', formatMs(a), '÷', formatMs(b));
  // a = aZeros + aNonZeros
  // b = bZeros + bNonZeros
  // a/b=x
  // a/b=xZeros + remainder/b

  // Remainder/b = a/b - xZeros
  // Remainder = a - xZeros * b
  // Remainder = aZeros + aNonZeros - aZeros/bZeros * (bZeros + bNonZeros)
  //           = aZeros + aNonZeros - aZeros - aZeros/bZeros * bNonZeros
  //           = aNonZeros - xZeros * bNonZeros

  // Count the number of zeros in a:
  let aZeros = 0n;
  const aNonZeros: [MS, bigint][] = [];
  a.forEach((item, count) => {
    if (isEqual(item, Empty)) {
      aZeros += count;
    } else {
      aNonZeros.push([item, count]);
    }
  });

  if (aZeros === 0n && aNonZeros.length === 0) {
    return Empty;
  }

  // Count the number of zeros in b:
  let bZeros = 0n;
  const bNonZeros: [MS, bigint][] = [];
  b.forEach((item, count) => {
    if (isEqual(item, Empty)) {
      bZeros += count;
    } else {
      bNonZeros.push([item, count]);
    }
  });

  console.log({
    aZeros,
    aNonZeros,
    bZeros,
    bNonZeros,
  });

  if (bZeros === 0n) {
    if (bNonZeros.length === 0) {
      throw new Error('PolyDivision by zero');
    }
  }

  if (aZeros === bZeros && aZeros === 0n) {
    // return (a-b) / b
    div(Plus([
      a,
      negate(b),
    ]), b);
  }

  const xZeros = aZeros / bZeros;

  // remainder = aNonZeros - xZeros * bNonZeros

  const remainder: MS = {
    forEach(fn) {
      aNonZeros.forEach(([item, count]) => {
        fn(item, count);
      });
      bNonZeros.forEach(([item, count]) => {
        fn(item, -xZeros * count);
      });
    },
  };

  return {
    forEach(fn) {
      fn(Empty, xZeros);
      div(remainder, b).forEach(fn);
    }
  };
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

// True is a function that invokes the callback once, with the empty set
const TRUE = Nat(1n);

// False never invokes, it is the empty set
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
  Plus,
  Times,
  Divide(args) {
    const a = args[0];
    const b = args[1];

    if (args.length !== 2) throw new Error('Divide with more than 2 arguments not supported');

    return div(a, b);
  },
  Minus([a, b]) {
    if (!b) return negate(a);
    return Plus([a, negate(b)]);
  },
  Count([arg]) {
    // Converts all items in the set into 0s.
    let n = 0n;
    arg.forEach(
      (item, count) => {
        n += count;
      }
    );
    return Nat(n);
  },
  Unique([arg]) {
    // Converts the multiset into a set
    const terms: MS[] = [];
    
    arg.forEach((item) => {
      const seen = terms.some((term) => isEqual(term, item));
      if (!seen) terms.push(item);
    });
    
    return {
      forEach(fn) {
        terms.forEach((term) => {
          fn(term, 1n);
        });
      }
    };
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
    return Times([lhs, rhs]);
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
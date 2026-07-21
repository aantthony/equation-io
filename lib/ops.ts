import { compare } from './compare.js';
import formatMs from './format.js';
import { Empty, FALSE, MS, TRUE } from './ms.js';

export function Equal(a: MS, b: MS): MS {
  return compare(a, b) === 0 ? TRUE : FALSE;
}

export function Not(a: MS) {
  return Equal(a, FALSE);
}

export function add(args: MS[]): MS {
  return function *() {
    for (const arg of args) yield* arg();
  }
}

function Doublet(a: MS, b: MS): MS {
  return function *() {
    yield [a, 1n];
    yield [b, 1n];
  };
}

export function Plus(terms: MS): MS {
  return function *() {
    for (const [operand, operandCount] of terms()) {
      if (operandCount === 0n) continue;
      for (const [item, count] of operand()) {
        yield [item, count * operandCount];
      }
    }
  };
}

function plus(terms: MS[]): MS {
  return function *() {
    for (const summand of terms) {
      yield* summand();
    }
  };
}

export function Negative(s: MS): MS {
  return function *() {
    for (const [item, count] of s()) {
      yield [item, -count];
    }
  }
}

function multiplyPair(a: MS, b: MS): MS {
  return function *() {
    for (const [aItem, aCount] of a()) {
      for (const [bItem, bCount] of b()) {
        const item = plus([aItem, bItem]);
        yield [item, aCount * bCount];
      }
    }
  };
}

export function multiplyMany(args: MS[]): MS {
  if (args.length === 0) return TRUE;
  if (args.length === 1) return args[0];
  let result = multiplyPair(args[0], args[1]);
  
  for (let i = 2; i < args.length; i++) {
    result = multiplyPair(result, args[i]);
  }

  return result;
}

// function reduce(arr: MS[], f: (a: MS, b: MS) => MS): MS {
//   return arr.reduce(f, TRUE);
// }

function scale(ms: MS, scale: bigint): MS {
  return function *() {
    for (const [item, count] of ms()) {
      yield [item, count * scale];
    }
  };
}

/*
  Input: [3a, b], [0,1] [true, false]
  output: [
    ...(prod(prefix=3a, [[0,1], [true, false]]))
    ...(prod(prefix=b, [[0,1], [true, false]]))


    ...(
      prod(prefix=b+0, [[true, false]])
      prod(prefix=b+1, [[true, false]])

      prod(prefix=b+1+true, [])
      prod(prefix=b+1+false, [])

      b+1+false
    )
  ]

  3*(2*[1]) = [0,0,0]*[1,1] = [3x0]*[2x1]
      = [0,0,0]*[1,1]
      = [
        0+1,0+1,
        0+1,0+1,
        0+1,0+1,

        opt 0: multiplicity 3
          yield* cart(prefix=[0], [[1,1]], multiplicity=3)
          = [
            opt 1: multiplicity 2
              yield* cart(prefix=[0,1], [], multiplicity=6)
              = [
                0+1   count=6
              ]
          ]
      ]
      = [
        1,1,1,1,1,1
      ]
      = [6x1]

  
  x=[1]
  x^3*[0,0] = [1][1][1][0,0]
      = [
        1+1+1+0, 1+1+1+0,
      ]
      = [
        yield *cart(prefix=[3x1], [[0,0]], multiplicity=1)


  [1]^3=cart(prefix=[], [3x[1]], multiplicity=1)
       = [1]*[1]*[1]
      = [
        1+1+1
      ]
       = [
          yield *cart(prefix=[3x1], [], multiplicity=1)
          = [
            1+1+1
          ]
       ]

  2^32 = 2*2*2*2
       = [0,0]*[0,0]*...*[0,0]
       = [
          0+0+0=0 (32 of them),
          .. how many of them? 2^32
       ]
        = [
          yield *cart(prefix=[32x0], [], multiplicity=2^32)
*/
function* cartesianProduct(prefix: [MS, bigint][], factors: [MS, bigint][], multiplicity: bigint): Generator<[MS, bigint], void, void> {
  // console.log('cartesianProduct', {
  //   prefix: prefix.map(([item, count]) => [formatMs(item), count]),
  //   factors: factors.map(([item, count]) => [formatMs(item), count]),
  //   multiplicity,
  // })
  if (!factors.length) {
    // console.log({
    //   summand: prefix.map(([item, count]) => [formatMs(item), count]),
    // });
    const sum: MS = function *() {
      for (const [summand, count] of prefix) {
        for (const [i, ic] of summand()) {
          yield [i, ic * count];
        }
      }
    }
    // we want to yield sum(prefix) * multiplicity
    // console.log('yield sum', formatMs(sum));
    yield [sum, multiplicity];
  } else {
    const [[head, headCount], ...tail] = factors;
    // console.log('headCount', headCount)
    for (const [opt, optMultiplicity] of head()) {
      // console.log('optMultiplicity', optMultiplicity)
      const newPrefix: [MS, bigint][] = [...prefix, [opt, headCount]];
      yield* cartesianProduct(newPrefix, tail, multiplicity * (optMultiplicity ** headCount));
    }
  }
}

export function Times(setOfFactors: MS): MS {
  return function *() {
    const all: [MS, bigint][] = [];
    for (const [factor, factorCount] of setOfFactors()) {
      all.push([factor, factorCount]);
    }

    yield* cartesianProduct([], all, 1n);
  };
}

function Singleton(item: MS): MS {
  return function *() {
    yield [item, 1n];
  }
}

export function Power(base: MS, exponent: MS) {
  return Times(multiplyPair(exponent, Singleton(base)));
}

/**
 * Implements polynomial division of a/b
 * 
 * First, we factor terms in a and b.
 * 
 * @param a 
 * @param b 
 */
export function Divide(a: MS, b: MS): MS {
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
  for (const [item, count] of a()) {
    if (compare(item, Empty) === 0) {
      aZeros += count;
    } else {
      aNonZeros.push([item, count]);
    }
  }

  if (aZeros === 0n && aNonZeros.length === 0) {
    return Empty;
  }

  // Count the number of zeros in b:
  let bZeros = 0n;
  const bNonZeros: [MS, bigint][] = [];
  for (const [item, count] of b()) {
    if (compare(item, Empty) === 0) {
      bZeros += count;
    } else {
      bNonZeros.push([item, count]);
    }
  }

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

  const xZeros = aZeros / bZeros;

  console.log({ xZeros });

  // remainder = aNonZeros - xZeros * bNonZeros

  const remainder: MS = function *() {
    yield* aNonZeros;
    for (const [item, count] of bNonZeros) {
      yield [item, -xZeros * count];
    }
  };

  // console.log('remainder', formatMs(remainder));

  return function *() {
    yield [Empty, xZeros];
    yield* Divide(remainder, b)();
  }
}

export const SameQ = Equal;
export const UnsameQ = (a: MS, b: MS) => Not(SameQ(a, b));
export const TrueQ = (a: MS) => Equal(a, TRUE);
export const Less = (a: MS, b: MS) => compare(a, b) < 0 ? TRUE : FALSE;
export const LessEqual = (a: MS, b: MS) => compare(a, b) <= 0 ? TRUE : FALSE;
export const Greater = (a: MS, b: MS) => compare(a, b) > 0 ? TRUE : FALSE;
export const GreaterEqual = (a: MS, b: MS) => compare(a, b) >= 0 ? TRUE : FALSE;
export const Minus = (a: MS, b?: MS) => b ? Plus(Doublet(a, Negative(b))) : Negative(a);

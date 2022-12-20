import { compare } from './compare';
import formatMs from './format';
import { Empty, FALSE, MS, TRUE } from './ms';

export function Equal(a: MS, b: MS): MS {
  return compare(a, b) === 0 ? TRUE : FALSE;
}

export function Not(a: MS) {
  return Equal(a, FALSE);
}

export function Plus(args: MS[]): MS {
  return function *() {
    for (const arg of args) yield* arg();
  }
}

export function Negative(s: MS): MS {
  return function *() {
    for (const [item, count] of s()) {
      yield [item, -count];
    }
  }
}

export function Times(args: MS[]): MS {
  if (args.length === 0) return TRUE;

  const a = args[0];
  const b = args[1];

  if (!b) return a;

  const aTimesB: MS = function *() {
    for (const [aItem, aCount] of a()) {
      for (const [bItem, bCount] of b()) {
        yield [Plus([aItem, bItem]), aCount * bCount];
      }
    }
  };

  const rest = args.slice(2);

  if (rest.length === 0) return aTimesB;

  return Times([aTimesB, ...rest]);
}

export function Power(a: MS, b: MS): MS {
  return a;
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
export const Minus = (a: MS, b?: MS) => b ? Plus([a, Negative(b)]) : Negative(a);

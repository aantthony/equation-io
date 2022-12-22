import { compare } from './compare';
import formatMs from './format';
import { Empty, FALSE, MS, TRUE } from './ms';

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
        const aSingleton = Singleton(aItem);
        const bSingleton = Singleton(bItem);
        const aAndB = Doublet(aSingleton, bSingleton);
        yield [Plus(aAndB), aCount * bCount];
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

export function Times(factors: MS): MS {
  console.log('Times', formatMs(factors));

  return function *() {
    const allFactors: MS[] = [];

    for (const [factor, factorCount] of factors()) {
      console.log('Times factor', formatMs(factor), factorCount);
      if (factorCount === 0n) continue;
      if (factorCount < 0n) {
        throw new Error('Negative exponent');
      }
      for (let i = 0n; i < factorCount; i++) {
        allFactors.push(factor);
      }
    }
    const prod = multiplyMany(allFactors);
    console.log('prod', formatMs(prod));
    for (const [item, count] of prod()) {
      yield [item, count];
    }
  };
}

function Singleton(item: MS): MS {
  return function *() {
    yield [item, 1n];
  }
}

export function Power(base: MS, exponent: MS) {
  // We need to compute Times(exponent * [base])
  const termsToAdd = Doublet(exponent, Singleton(base));
  return Times(Times(Plus(termsToAdd)));
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

export type MS = () => Generator<[MS, bigint], void, unknown>;

export const Empty: MS = function *() {};

export function Nat(n: bigint): MS {
  if (n === 0n) return Empty;
  return function *() {
    yield [Empty, n];
  };
}


// True is a function that invokes the callback once, with the empty set
export const TRUE = Nat(1n);

// False never invokes, it is the empty set
export const FALSE = Empty;

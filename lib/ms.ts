export type MS = () => Generator<[MS, bigint], void, void>;

export const Empty: MS = function *Empty() {};

export function Nat(n: bigint): MS {
  if (n === 0n) return Empty;
  return function *NatN() {
    yield [Empty, n];
  };
}

// True is a function that invokes the callback once, with the empty set
export const TRUE = Nat(1n);

// False never invokes, it is the empty set
export const FALSE = Empty;

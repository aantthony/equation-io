export interface OnEnumerate {
  (item: MS, count: bigint): void;
}

export interface MS {
  brand?: symbol;
  s?: string;
  forEach(fn: OnEnumerate): void;
}

export const Empty: MS = {
  s: '0',
  forEach(fn) {}
}

import { MS } from './ms';

export function compare(a: MS, b: MS): 1 | -1 | 0 {
  if (!a || !b) throw new Error('Invalid arguments');

  const gA = a();
  const gB = b();

  while (1) {
    const nA = gA.next();
    const nB = gB.next();

    if (nA.done && nB.done) return 0;

    if (nA.done) return -1;
    if (nB.done) return 1;

    const [sA, cA] = nA.value;
    const [sB, cB] = nB.value;

    // Let's compare the symbols first
    const indComp = compare(sA, sB);
    if (indComp !== 0) return indComp;

    // If the symbols are the same, compare the coefficients
    if (cA < cB) return -1;
    if (cA > cB) return 1;

    // If the symbols and coefficients are the same, continue
  }

  throw new Error('Unreachable');
}

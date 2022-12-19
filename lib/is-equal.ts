import { MS } from './ms';

export default function isEqual(a: MS, b: MS): boolean {
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

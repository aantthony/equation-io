import isEqual from './is-equal';
import { MS } from './ms';

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

export default function formatMs(ms: MS): string {
  const tr = toTree(ms);
  // console.log(JSON.stringify(tr, null, 2));
  return formatTree(tr);
}

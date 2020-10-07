
export type LangPrimitive = 'any' | 'number' | 'string' | 'true' | 'false' | 'boolean' | 'unknown' | 'never';

export interface CustomType {
  name: string;
  args: LangType[];
}

export type LangType = LangPrimitive | CustomType;

/**
 * Generate a (non-canonical) human-readable string to fully describe a type.
 */
export function inspectType(type: LangType): string {
  if (typeof type == 'string') return type;
  if (type.name === 'Array') {
    return `${inspectType(type.args[0])}[]`;
  }
  if (type.name === 'Tuple') {
    return `[${type.args.map(inspectType).join(',')}]`;
  }
  if (type.name === 'Function') {
    const argType = inspectType(type.args[0])
      .replace(/^\[(.+)\]$/, '($1)')

    return `${argType} => ${inspectType(type.args[1])}`
  }
  return `${type.name}<${type.args.map(inspectType).join(',')}>`
}

function simplify(type: LangType): LangType {
  if (typeof type === 'string') return type;
  switch (type.name) {
    case 'Intersect': {
      const a = type.args[0];
      if (a === 'false' || a === 'true') return 'boolean';
      if (typeof a === 'string') return a;
    }
    case 'And': {
      const [a, b] = type.args;
      if (a === b) return a;
      const int = unpack(b, 'Intersect');
      if (int && int[0] === a) return a;

      if (a === 'unknown') return b;
      if (b === 'unknown') return a;
      return a;
    }
  }
  return type;
}

function construct(name: string, args: LangType[]): LangType {
  const p = <CustomType>{
    name,
    args,
  };
  return simplify(p);
}

type T = LangType;

export const Types = {
  Array: (x: T) => construct('Array', [x]),
  Function: (args: T[], returns: T) => construct('Function', [Types.Tuple(args), returns]),
  Intersect: (a: T) => construct('Intersect', [a]),
  And: (a: T, b: T) => construct('And', [a, b]),
  Boolean: () => 'boolean',
  Number: () => 'number',
  Tuple: (vals: LangType[]) => construct('Tuple', vals),
}

export function unpack(type: LangType, name: string): LangType[] | null {
  if (typeof type === 'string') return null;
  if (type.name === name) return type.args;
  return null;
}

const TYPE_ANY = 'any';

function accessProp(type: LangType, key: string): LangType {
  return type;
}

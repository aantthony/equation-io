
export type LangPrimitive = 'any' | 'number' | 'string' | 'true' | 'false' | 'boolean' | 'unknown' | 'never';

export interface CustomType {
  name: string;
  args: LangType[];
}

export interface StringConstant {
  name: 'string';
  args: LangType[];
  string: string;
}

export type InterfaceDict = {[key: string]: LangType};

export interface InterfaceType {
  name: 'interface';
  args: LangType[];
  dict: InterfaceDict;
}

export type LangType = LangPrimitive | StringConstant | InterfaceType | CustomType;

export function readString(type: LangType): string | null {
  if (typeof type === 'string') return null;
  if (type.name === 'String') {
    const t = type as StringConstant;
    return t.string;
  }
  return null;
}

export function unpack(type: LangType, name: string): LangType[] | null {
  if (typeof type === 'string') return null;
  if (type.name === name) return type.args;
  return null;
}

/**
 * Generate a (non-canonical) human-readable string to fully describe a type.
 */
export function inspectType(type: LangType): string {
  if (typeof type == 'string') return type;
  if (type.name === 'interface') {
    const d = readInterface(type)!;
    const s = Object.keys(d).map(k => {
      const v = d[k];
      return `${k}: ${inspectType(v)}`
    }).join(',');
    return `{${s}}`
  }
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

function readInterface(type: LangType): InterfaceDict | null {
  if (typeof type === 'string') return null;
  if (type.name === 'interface') return (<InterfaceType>type).dict;
  return null;
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

      const interfaceA = readInterface(a);
      const interfaceB = readInterface(b);

      if (interfaceA && interfaceB) {
        const dict: InterfaceDict = {};
        function mergeIn(dict: InterfaceDict) {
          Object.keys(dict).forEach(k => {
            const v = dict[k];
            const existing = dict[k];
            if (existing) {
              dict[k] = construct('And', [existing, v]);
            } else {
              dict[k] = v;
            }
          });
        }

        mergeIn(interfaceA);
        mergeIn(interfaceB);

        return <InterfaceType>{
          name: 'interface',
          args: [],
          dict,
        };
      }

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

function Str(string: string) {
  return construct('String', [{ name: 'string', args: [], string }])
}

function makeProp(key: string, value: LangType): LangType {
  return construct('Property', [Str(key), value])
}

export const Types = {
  Array: (x: T) => construct('Array', [x]),
  Function: (args: T[], returns: T) => construct('Function', [Types.Tuple(args), returns]),
  Intersect: (a: T) => construct('Intersect', [a]),
  And: (a: T, b: T) => construct('And', [a, b]),
  Boolean: () => 'boolean',
  Number: () => 'number',
  Tuple: (vals: LangType[]) => construct('Tuple', vals),
  String: (string: string) => Str(string),
  Interface: (dict: InterfaceDict) => {
    return <InterfaceType> {
      name: 'interface',
      args: [],
      dict,
    };
  },
}

const TYPE_ANY = 'any';

export function accessProp(type: LangType, key: string): LangType {
  return type;
}

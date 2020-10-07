import { AstNode } from './ast';
import { IScope, LangDeclaration } from './scope';
import { LangType, Types, unpack, inspectType, accessProp, InterfaceDict } from './types';

const BINARY_MATH_OPS = [
  'Plus',
  'Times',
  'Divide',
  'Minus',
  'Power',
];

function sat(subject: LangType, condition: LangType): boolean {
  if (subject === 'unknown') return true;
  if (condition === 'any') return true;
  if (condition === 'unknown') return true;
  if (condition === 'number') return subject === 'number';
  if (condition === 'string') return subject === 'string';
  if (condition === 'boolean') return subject === 'boolean' || subject === 'true' || subject === 'false';
  if (condition === 'true') return subject === 'boolean';
  if (condition === 'false') return subject === 'boolean';
  return false;
}

function is(subject: LangType, condition: LangType): boolean {
  const int = unpack(condition, 'Intersect');
  if (int) {
    return sat(subject, int[0]);
  }
  if (condition === 'any') return true;
  if (condition === 'unknown') return true;
  if (condition === 'number') return subject === 'number';
  if (condition === 'string') return subject === 'string';
  if (condition === 'boolean') return subject === 'boolean' || subject === 'true' || subject === 'false';
  if (condition === 'true') return subject === 'boolean';
  if (condition === 'false') return subject === 'boolean';
  return false;
}


function forEach(target: AstNode, fn: (v: AstNode) => void) {
  if (target.name === 'Series') {
    target.args.forEach(arg => forEach(arg, fn));
    return;
  }
  fn(target);
}

function enumerate(target: AstNode): AstNode[] {
  const res: AstNode[] = [];
  forEach(target, c => res.push(c));
  return res;
}

function symbolName(target: AstNode): string {
  if (target.name === 'symbol') return target.value!;
  throw new Error(`Expected a symbol, got ${target.name} instead.`);
}

function assert(scope: IScope, name: string, type: LangType): LangDeclaration {
  const existing = scope.get(name);
  if (existing) {
    if (!sat(existing.type, type)) {
      scope.error(`Expected ${inspectType(type)} for ${name}, but got ${existing.type} instead.`);
    }

    existing.type = Types.And(existing.type, type);

    return existing;
  }

  scope.error(`${name} is not defined.`);
  return {
    name,
    type,
  };
}

function createTypeDefinition(target: AstNode, scope: IScope): LangType {
  if (target.name === 'symbol') {
    if (target.value === 'string') return 'string';
    if (target.value === 'number') return 'number';
    if (target.value === 'boolean') return 'boolean';
    if (target.value === 'true') return 'true';
    if (target.value === 'false') return 'false';
    if (target.value === 'never') return 'never';
    if (target.value === 'any') return 'any';
    if (target.value === 'unknown') return 'unknown';
    const lookup = scope.get(target.value!);
    if (!lookup) {
      throw new Error(`Unknown type: ${target.value}`);
    }
  }
  throw new Error(`Unknown type: type=${target.name}`);
}

function readDeclaration(target: AstNode, scope: IScope): LangDeclaration {
  if (target.name === 'Property') {
    return {
      name: symbolName(target.args[0]),
      type: createTypeDefinition(target.args[1], scope),
    }
  }

  return {
    name: symbolName(target),
    type: 'unknown',
  };
}

function unpackParen(x: AstNode, str: string): AstNode {
  if (x.name === 'RoundBracket') {
    return x.args[0];
  }
  return x;
}

export default function typeCheckInscope(node: AstNode, scope: IScope, required?: LangType): LangType {
  while (node.name === 'RoundBracket' && node.args.length === 1) {
    node = node.args[0];
  }
  if (node.name === 'number') return 'number';
  if (node.name === 'string') return 'string';

  if (node.name === 'RoundBracket') {
    // tuple
    const tt = required ? unpack(required, 'Tuple') : null;

    const res = node.args.map((a, i) => {
      const e = tt ? tt[i] : undefined;
      return typeCheckInscope(a, scope, e);
    });

    return Types.Tuple(res);
  } else if (node.name === 'Lambda') {
    const defn = node.args[1];
    const args = unpackParen(node.args[0], '(');
    const fnArgs = enumerate(args).map(arg => readDeclaration(arg, scope));

    const s = scope.fork(fnArgs);
    const retType = typeCheckInscope(defn, s);

    return Types.Function(fnArgs.map(a => a.type), retType);
  }
  if (node.name === 'symbol') {
    const name = node.value!;
    console.log('asserting', name, inspectType(required || 'unknown'));
    const def = assert(scope, name, required || 'unknown');
    return def.type;
  }
  if (node.name === 'Statements') {
    const [defScope, retType] = node.args.reduce((last: [IScope, LangType], arg: AstNode): [IScope, LangType] => {
      const oScope = last[0];
      const rType = typeCheckInscope(arg, oScope);
      if (arg.name === 'Equal') {
        const lhs = arg.args[0];
        const declr = readDeclaration(lhs, oScope);
        const nScope = scope.fork([declr]);
        return [nScope, rType];
      }
      return [oScope, rType] as any;
    }, <[IScope, LangType]>[scope, 'never'])
    return retType;
  }
  if (BINARY_MATH_OPS.indexOf(node.name) !== -1) {
    const types = node.args.map(arg => {
      return typeCheckInscope(arg, scope, 'number');
    });
    if (!types.every(t => is(t, 'number'))) {
      scope.error(`The ${node.name} operator expected [number,number], but got ${types.map(inspectType).join(node.token.str)}.`);
    }
    return 'number';
  }
  if (node.name === 'SameQ' || node.name ==='UnsameQ') {
    const first = typeCheckInscope(node.args[0], scope);
    const conforms = Types.Intersect(first);
    const others = node.args.slice(1).map(arg => {
      return typeCheckInscope(arg, scope, conforms);
    });
    if (!others.every(t => is(t, conforms))) {
      scope.error(`Type mismatch for ${node.name}: Got ${others.map(inspectType).join(node.token.str)}.`);
    }
    return 'boolean';
  }
  if (node.name === 'SquareBracket') {
    if (required) {
      const aType = unpack(required, 'Array');

      const subType = aType ? aType[0] : 'unknown';

      const res = node.args.map(a => {
        return typeCheckInscope(a, scope, subType);
      });
      return Types.Tuple(res);
    }

    const res = node.args.map(a => {
      return typeCheckInscope(a, scope);
    });
    return Types.Tuple(res);
  }
  if (node.name === 'CurlyBracket') {
    const dict: InterfaceDict = {};
    function addProp(key: string, t: AstNode) {
      const inferedPropType = required ? accessProp(required, key) : undefined;
      dict[key] = typeCheckInscope(t, scope, inferedPropType);
    }
    node.args.map(p => {
      if (p.name === 'Property') {
        if (p.args[0].name === 'symbol') {
          addProp(p.args[0].value!, p.args[1]);
        } else if (p.args[0].name === 'string') {
          addProp(JSON.parse(p.args[0].value!), p.args[1]);
        } else {
          throw new Error('Unregonizable property');
        }
      }
    });

    return Types.Interface(dict);
  }
  if (node.name === 'Default') {
    const typeLhs = typeCheckInscope(node.args[0], scope);
    const fnType = unpack(typeLhs, 'Function');
    if (fnType) {
      const tupleArgType = unpack(fnType[0], 'Tuple');
      if (!tupleArgType) throw new Error('Fn is not tuple?');
      const typeRhs = typeCheckInscope(node.args[1], scope, tupleArgType[0])
      if (!is(typeRhs, tupleArgType[0])) {
        scope.error(`Invalid function argument. Expected: ${inspectType(tupleArgType[0])}, got ${inspectType(typeRhs)}.`);
      }
      return fnType[1];
    }

    scope.error(`Unknown lhs default: ${inspectType(typeLhs)}`);

    const typeRhs = typeCheckInscope(node.args[1], scope);
    const typeLhsInf = Types.Function([typeRhs], required || 'unknown');
    const typeLhs2 = typeCheckInscope(node.args[0], scope, typeLhsInf);
    const fnArg2 = unpack(typeLhs2, 'Function');
    if (fnArg2) return fnArg2[1];
    return 'unknown';
  }

  scope.error(`Type checking not defined for ${node.name}.`);
  return 'unknown';
}

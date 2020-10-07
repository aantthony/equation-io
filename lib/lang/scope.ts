import { Types, LangType } from './types';

export interface LangDeclaration {
  type: LangType;
  name: string;
}

export interface IScope {
  fork(defns: LangDeclaration[]): IScope;
  get(name: string): LangDeclaration | undefined;
  error(message: string): void;
}

export type ScopeDict = {[key: string]: LangDeclaration};

export class Scope implements IScope {
  parent: Scope | null;
  values: ScopeDict;
  errors: string[];
  constructor(parent: Scope | null, values: ScopeDict) {
    this.parent = parent;
    this.values = values;
    this.errors = [];
  }
  fork(values: LangDeclaration[]) {
    const dict = values.reduce((all, def) => {
      all[def.name] = def;
      return all;
    }, <ScopeDict>{})
    return new Scope(this, dict);
  }
  get(name: string): LangDeclaration | undefined {
    const v = this.values[name];
    if (v) return v;
    if (this.parent) return this.parent.get(name);
    return undefined;
  }
  error(message: string) {
    if (!this.parent) {
      this.errors.push(message);
      return;
    }
    this.parent.error(message);
  }
}

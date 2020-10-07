import lang, * as L from './lang';
import { LangType, inspectType } from './lang/types';

export const partial = L.partial;
export const check = L.check;

export function parse(str: string) {
  return lang(str);
}

export function typeInpect(t: LangType): string {
  return inspectType(t);
}

export default lang;

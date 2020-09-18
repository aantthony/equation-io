import lang, * as L from './lang';

export const tokenizer = L.tokenize;
export const partial = L.partial;
export const drain = L.drain;

export function parse(str: string) {
  return lang(str);
}

export default lang;

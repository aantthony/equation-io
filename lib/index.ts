import lang, * as L from './lang';

export const tokenizer = L.tokenize;
export const partial = L.partial;
export const drain = L.drain;

export default lang;

// const expr = lang(`
// const expr = lang("");
// `);

// console.log(format(expr));

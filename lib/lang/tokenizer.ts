export interface PatternDict {
  [type: string]: (RegExp | ((val: string) => boolean));
}

export interface Token {
  type: string;
  str: string;
  line: number;
  loc: [number, number];
}

export default function Tokenizer(patternDict: PatternDict) {
  const names = Object.keys(patternDict);
  const fns = names.map(k => {
    const val = patternDict[k];
    if (typeof val === 'object') return (s: string) => val.test(s);
    return val;
  });

  return function tokenizer(string: string): Token[] {
    const tokens: Token[] = [];

    let s = string[0];
    let si = 0;
    let t = fns.findIndex(p => p(s));
    let line = 1;

    for (let i = 1; i < string.length; i++) {
      const ds = string[i];
      const cds = s + ds;
      if (fns[t](cds)) {
        s = cds;
      } else {
        tokens.push({
          type: names[t],
          str: s,
          line,
          loc: [si, i]
        });
        const nt = fns.findIndex(p => p(ds));
        t = nt;
        s = ds;
        si = i;
      }
    }
    if (s) {
      tokens.push({
        type: names[t],
        str: s,
        line,
        loc: [si, string.length],
      });
    }

    return tokens;
  }
}

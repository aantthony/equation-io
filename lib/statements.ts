/**
 * The statement-list text format shared by the URL hash, the examples menu,
 * and clipboard paste: statements separate on newlines or ';', but only at
 * bracket depth zero, so a formula wrapped across lines inside parens (how
 * LLMs and textbooks format multi-component tuples) stays one statement.
 * Newlines swallowed inside brackets become spaces so token boundaries
 * survive.
 *
 * Implemented as a raw character scan rather than on the tokenizer: splitting
 * must be total (the editor splits half-typed, unparseable text, and one
 * broken statement must not corrupt the rows after it), and the grammar has
 * no strings, comments, or other tokens that can contain bracket or separator
 * characters. If such tokens are ever added, rebuild this on the tokenizer.
 */
export function splitStatements(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of text.replace(/\r\n?/g, '\n')) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    if ((ch === '\n' || ch === ';') && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch === '\n' ? ' ' : ch;
    }
  }
  parts.push(cur);
  return parts;
}

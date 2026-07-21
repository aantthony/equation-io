import { describe, expect, it } from 'vitest';
import formatMs from './format.ts';
import { DeclarationNode, parse } from './syntax.ts';

function evaluate(input: string, globals = new Map<string, DeclarationNode>()): string {
  const res = parse(input, globals);
  if (!res || res.type !== 'value') throw new Error(`Expected a value for ${JSON.stringify(input)}`);
  return formatMs(res.value);
}

describe('parse', () => {
  it('evaluates arithmetic', () => {
    expect(evaluate('1+1')).toBe('2');
    expect(evaluate('2*3+4')).toBe('10');
    expect(evaluate('2^10')).toBe('1024');
  });

  it('resolves assigned identifiers', () => {
    const globals = new Map<string, DeclarationNode>();
    const assignment = parse('x=3', globals);
    if (!assignment || assignment.type !== 'assignment') throw new Error('Expected an assignment');
    globals.set(assignment.l.id.name, {
      type: 'declaration',
      id: assignment.l.id,
      value: assignment.r,
    });
    expect(evaluate('x*x', globals)).toBe('9');
  });
});

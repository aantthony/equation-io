import { describe, expect, it } from 'vitest';
import { splitStatements } from './statements.ts';

describe('splitStatements', () => {
  it('splits on ";" and newlines at depth zero', () => {
    expect(splitStatements('a = 2; y = sin(a x)/a')).toEqual(['a = 2', ' y = sin(a x)/a']);
    expect(splitStatements('y = sin(x)\ny = cos(x)')).toEqual(['y = sin(x)', 'y = cos(x)']);
    expect(splitStatements('y = sin(x); y = cos(x)\nx = 2')).toEqual(['y = sin(x)', ' y = cos(x)', 'x = 2']);
  });

  it('keeps a formula wrapped across lines inside brackets whole', () => {
    expect(splitStatements('((2+cos(u/2))*cos(u),\n (2+cos(u/2))*sin(u),\n sin(u/2))'))
      .toEqual(['((2+cos(u/2))*cos(u),  (2+cos(u/2))*sin(u),  sin(u/2))']);
    expect(splitStatements('[1,\n2]')).toEqual(['[1, 2]']);
    expect(splitStatements('{x,\ny}')).toEqual(['{x, y}']);
  });

  it('keeps ";" inside brackets in the statement text', () => {
    expect(splitStatements('(1; 2)')).toEqual(['(1; 2)']);
  });

  it('normalizes CRLF and CR to statement breaks', () => {
    expect(splitStatements('x = 1\r\nx = 2\rx = 3')).toEqual(['x = 1', 'x = 2', 'x = 3']);
    expect(splitStatements('(1,\r\n 2)')).toEqual(['(1,  2)']);
  });

  it('clamps unbalanced closers so later separators still split', () => {
    expect(splitStatements('x)\ny = 1')).toEqual(['x)', 'y = 1']);
  });

  it('preserves empty statements and single statements verbatim', () => {
    expect(splitStatements('')).toEqual(['']);
    expect(splitStatements('y = sin(x)')).toEqual(['y = sin(x)']);
    expect(splitStatements(';')).toEqual(['', '']);
  });
});

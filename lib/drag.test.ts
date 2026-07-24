import { describe, expect, it } from 'vitest';
import { dragAxes, splitPair } from './drag.ts';

describe('splitPair', () => {
  it('splits a simple pair at the top-level comma', () => {
    expect(splitPair('(2, 3)')).toEqual(['2', '3']);
  });

  it('ignores commas nested in parens or brackets', () => {
    expect(splitPair('(f(1, 2), [3, 4][1])')).toEqual(['f(1, 2)', '[3, 4][1]']);
  });

  it('rejects non-pairs', () => {
    expect(splitPair('(1, 2, 3)')).toBeNull(); // triple
    expect(splitPair('(1)')).toBeNull(); // no comma
    expect(splitPair('(1, 2) + (3, 4)')).toBeNull(); // outer parens don't wrap the row
    expect(splitPair('x + 1')).toBeNull();
  });
});

describe('dragAxes', () => {
  const sliders = (names: string[]) => (name: string) => (names.includes(name) ? 'slider' : null);

  it('classifies literal and slider coordinates as movable', () => {
    const drag = dragAxes('(2, a)', sliders(['a']));
    expect(drag).not.toBeNull();
    expect(drag!.axes).toEqual(['literal', 'slider']);
  });

  it('pins computed coordinates but keeps the pair grabbable if one axis moves', () => {
    expect(dragAxes('(a+1, 3)', sliders(['a']))!.axes).toEqual([null, 'literal']);
  });

  it('returns null when nothing can move', () => {
    expect(dragAxes('(2cos(t), a+1)', sliders(['a']))).toBeNull();
    expect(dragAxes('(b, c)', sliders([]))).toBeNull(); // names that are not sliders
  });
});

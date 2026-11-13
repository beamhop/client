import { describe, expect, it } from 'vitest';
import { minutes, tokens } from './format.ts';

describe('format', () => {
  it('rounds usage minutes for display', () => {
    expect(minutes(0.8744666666666667)).toBe('0.9');
    expect(minutes(2)).toBe('2');
    expect(minutes(9.96)).toBe('10');
    expect(minutes(42.4)).toBe('42');
    expect(minutes(0)).toBe('0');
  });
  it('shortens token counts', () => {
    expect(tokens(40_123)).toBe('40k');
    expect(tokens(1_250_000)).toBe('1.3M');
    expect(tokens(12)).toBe('12');
  });
});

import { describe, expect, it } from 'vitest';
import { escapeCurrencyDollars as esc } from './markdownMath';

describe('escapeCurrencyDollars', () => {
  it('leaves text without dollars alone', () => {
    expect(esc('plain *text*')).toBe('plain *text*');
  });

  it('keeps inline formulas', () => {
    expect(esc('Energy is $E=mc^2$ and $x_1$ too')).toBe('Energy is $E=mc^2$ and $x_1$ too');
    expect(esc('$2x+3$')).toBe('$2x+3$');
  });

  it('escapes prices, however many there are', () => {
    expect(esc('It costs $5.')).toBe('It costs \\$5.');
    expect(esc('Between $5 and $10 a month')).toBe('Between \\$5 and \\$10 a month');
    expect(esc('$5-$10')).toBe('\\$5-\\$10');
    expect(esc('$5')).toBe('\\$5');
  });

  it('keeps display formulas, also across lines', () => {
    expect(esc('$$\\int_0^1 x^2 dx$$')).toBe('$$\\int_0^1 x^2 dx$$');
    expect(esc('before\n$$\na + b\n$$\nafter $3')).toBe('before\n$$\na + b\n$$\nafter \\$3');
  });

  it('does not touch code', () => {
    expect(esc('use `$5` here and $5')).toBe('use `$5` here and \\$5');
    expect(esc('```sh\necho $HOME $5\n```\nthen $5')).toBe('```sh\necho $HOME $5\n```\nthen \\$5');
  });

  it('leaves an already escaped dollar alone', () => {
    expect(esc('\\$5 and \\$10')).toBe('\\$5 and \\$10');
  });

  it('does not let a formula run over a line break', () => {
    expect(esc('costs $5\nand later $x$')).toBe('costs \\$5\nand later $x$');
  });
});

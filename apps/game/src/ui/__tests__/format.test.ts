import { describe, expect, it } from 'vitest';
import { signed } from '../format.js';

describe('signed', () => {
  it('prints the sign on both sides of zero', () => {
    expect(signed(2.5)).toBe('+2.5');
    expect(signed(-2.5)).toBe('-2.5');
  });

  it('never prints a minus sign on a value that rounds to zero', () => {
    expect(signed(-0.01)).toBe('+0.0');
    expect(signed(-0.004, 2)).toBe('+0.00');
    expect(signed(-0)).toBe('+0.0');
    expect(signed(0)).toBe('+0.0');
  });

  it('rounds to the digits asked for', () => {
    expect(signed(3.14159, 2)).toBe('+3.14');
    expect(signed(-12.345, 0)).toBe('-12');
  });
});

import { sha256Hex, stableStringify } from './content-hash';

describe('stableStringify', () => {
  it('is independent of object key order', () => {
    const a = stableStringify({ b: 1, a: 2, c: { y: 1, x: 2 } });
    const b = stableStringify({ a: 2, c: { x: 2, y: 1 }, b: 1 });
    expect(a).toBe(b);
  });

  it('preserves array order (arrays are ordered data)', () => {
    expect(stableStringify([1, 2, 3])).not.toBe(stableStringify([3, 2, 1]));
  });

  it('distinguishes different values', () => {
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
  });
});

describe('sha256Hex', () => {
  it('is stable for equal input and differs for different input', () => {
    expect(sha256Hex('x')).toBe(sha256Hex('x'));
    expect(sha256Hex('x')).not.toBe(sha256Hex('y'));
    expect(sha256Hex('x')).toMatch(/^[0-9a-f]{64}$/);
  });
});

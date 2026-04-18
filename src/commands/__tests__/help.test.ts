import { describe, test, expect } from 'bun:test';
import { validateTradeArgs } from '../help.js';

describe('validateTradeArgs', () => {
  test('accepts integer count without price', () => {
    expect(validateTradeArgs('10')).toEqual({ count: 10, price: undefined });
  });

  test('accepts fractional count for fractional-enabled markets', () => {
    expect(validateTradeArgs('2.5')).toEqual({ count: 2.5, price: undefined });
    expect(validateTradeArgs('0.1', '56')).toEqual({ count: 0.1, price: 56 });
  });

  test('rejects non-numeric count', () => {
    expect(validateTradeArgs('abc')).toEqual({ error: expect.stringContaining('Invalid count') });
    expect(validateTradeArgs('')).toEqual({ error: expect.stringContaining('Invalid count') });
  });

  test('rejects zero or negative count', () => {
    expect(validateTradeArgs('0')).toEqual({ error: expect.stringContaining('Invalid count') });
  });

  test('accepts integer cents 1-99', () => {
    expect(validateTradeArgs('10', '56')).toEqual({ count: 10, price: 56 });
    expect(validateTradeArgs('1', '1')).toEqual({ count: 1, price: 1 });
    expect(validateTradeArgs('1', '99')).toEqual({ count: 1, price: 99 });
  });

  test('rejects cents outside 1-99 range', () => {
    expect(validateTradeArgs('1', '0')).toEqual({ error: expect.stringContaining('Invalid price') });
    expect(validateTradeArgs('1', '100')).toEqual({ error: expect.stringContaining('Invalid price') });
    expect(validateTradeArgs('1', '150')).toEqual({ error: expect.stringContaining('Invalid price') });
  });

  test('accepts dollar input and converts to cents', () => {
    expect(validateTradeArgs('10', '0.56')).toEqual({ count: 10, price: 56 });
    expect(validateTradeArgs('10', '0.01')).toEqual({ count: 10, price: 1 });
    expect(validateTradeArgs('10', '0.99')).toEqual({ count: 10, price: 99 });
  });

  test('accepts subpenny dollar input (fractional cents)', () => {
    const result = validateTradeArgs('10', '0.5650');
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.count).toBe(10);
    expect(result.price).toBeCloseTo(56.5, 5);
  });

  test('rejects dollar inputs outside 0.01-0.99 range', () => {
    expect(validateTradeArgs('1', '1.00')).toEqual({ error: expect.stringContaining('Invalid price') });
    expect(validateTradeArgs('1', '0.00')).toEqual({ error: expect.stringContaining('Invalid price') });
    expect(validateTradeArgs('1', '-0.5')).toEqual({ error: expect.stringContaining('Invalid price') });
  });

  test('rejects malformed price strings', () => {
    expect(validateTradeArgs('1', 'abc')).toEqual({ error: expect.stringContaining('Invalid price') });
    expect(validateTradeArgs('1', '56c')).toEqual({ error: expect.stringContaining('Invalid price') });
  });
});

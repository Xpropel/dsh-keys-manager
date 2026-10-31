import assert from 'node:assert/strict';
import test from 'node:test';
import { addDecimals, compareDecimals, isDecimalString, multiplyDecimals, subtractDecimals } from '../src/money.ts';

test('decimal arithmetic stays exact above Number safe integer and below floating-point precision', () => {
  assert.equal(subtractDecimals('9007199254740993.00000000000000000001', '9007199254740993.00000000000000000000'), '0.00000000000000000001');
  assert.equal(addDecimals('9007199254740993.00000000000000000001', '0.00000000000000000009'), '9007199254740993.00000000000000000010');
  assert.equal(subtractDecimals('0.3', '0.2'), '0.1');
  assert.equal(addDecimals('0.1', '0.2'), '0.3');
});

test('multiplication converts currencies exactly and rounds half-up to the result scale', () => {
  assert.equal(multiplyDecimals('10', '7.2'), '72.0000');
  assert.equal(multiplyDecimals('8.3000', '7.2134'), '59.8712');
  assert.equal(multiplyDecimals('0.00005', '1'), '0.0001');
  assert.equal(multiplyDecimals('0.00004', '1'), '0.0000');
  assert.equal(multiplyDecimals('-1.005', '2'), '-2.0100');
  assert.equal(multiplyDecimals('3', '0.333333'), '1.0000');
});

test('different scales align while retaining the finest observed decimal scale', () => {
  assert.equal(subtractDecimals('1.2300', '1.22'), '0.0100');
  assert.equal(addDecimals('0', '0.0100'), '0.0100');
  assert.equal(addDecimals('1.2', '2.345'), '3.545');
  assert.equal(subtractDecimals('00010.00', '00009.999'), '0.001');
  assert.equal(subtractDecimals('10', '1'), '9');
});

test('signed balances and negative zero are handled without floating point', () => {
  assert.equal(subtractDecimals('0.01', '-0.01'), '0.02');
  assert.equal(subtractDecimals('-1.00', '2'), '-3.00');
  assert.equal(addDecimals('-1.00', '1'), '0.00');
  assert.equal(addDecimals('-0.00', '0'), '0.00');
  assert.equal(compareDecimals('-0.00', '0.000'), 0);
  assert.equal(compareDecimals('10.000', '9.999999999'), 1);
  assert.equal(compareDecimals('-10.000', '-9.999999999'), -1);
});

test('decimal inputs reject exponents, whitespace, missing digits and unbounded strings', () => {
  for (const value of ['', ' 1', '1 ', '1e-3', '+1', '.1', '1.', 'NaN', 'Infinity', '1\n', '1'.repeat(1025), 1, null, {}]) {
    assert.equal(isDecimalString(value), false);
    assert.throws(() => addDecimals(value as string, '0'));
  }
  assert.equal(isDecimalString('0.0000000001'), true);
  assert.equal(isDecimalString('1'.repeat(101), 100), false);
});

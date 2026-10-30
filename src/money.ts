/** Exact base-10 money arithmetic. Values never pass through Number/parseFloat. */
const DECIMAL = /^-?\d+(?:\.\d+)?$/;
const MAX_DECIMAL_LENGTH = 1024;

interface Decimal {
  coefficient: bigint;
  scale: number;
}

export function isDecimalString(value: unknown, maxLength = MAX_DECIMAL_LENGTH): value is string {
  return typeof value === 'string' && value.length <= maxLength && DECIMAL.test(value);
}

function parse(value: string): Decimal {
  if (!isDecimalString(value)) throw new Error('Invalid decimal amount');
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ''] = unsigned.split('.');
  const coefficient = BigInt(`${whole}${fraction}`);
  return { coefficient: negative ? -coefficient : coefficient, scale: fraction.length };
}

function align(left: string, right: string): { left: bigint; right: bigint; scale: number } {
  const a = parse(left);
  const b = parse(right);
  const scale = Math.max(a.scale, b.scale);
  return {
    left: a.coefficient * 10n ** BigInt(scale - a.scale),
    right: b.coefficient * 10n ** BigInt(scale - b.scale),
    scale,
  };
}

function format(coefficient: bigint, scale: number): string {
  const negative = coefficient < 0n;
  const digits = (negative ? -coefficient : coefficient).toString().padStart(scale + 1, '0');
  const unsigned = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  const result = negative ? `-${unsigned}` : unsigned;
  if (result.length > MAX_DECIMAL_LENGTH) throw new Error('Decimal amount exceeds supported size');
  return result;
}

/** Result keeps the finer of the two decimal scales, including trailing zeroes. */
export function addDecimals(left: string, right: string): string {
  const values = align(left, right);
  return format(values.left + values.right, values.scale);
}

/** Result keeps the finer of the two decimal scales, including trailing zeroes. */
export function subtractDecimals(left: string, right: string): string {
  const values = align(left, right);
  return format(values.left - values.right, values.scale);
}

export function compareDecimals(left: string, right: string): -1 | 0 | 1 {
  const values = align(left, right);
  return values.left < values.right ? -1 : values.left > values.right ? 1 : 0;
}

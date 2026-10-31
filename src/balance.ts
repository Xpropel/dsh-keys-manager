import { addDecimals, isDecimalString, multiplyDecimals } from './money.ts';
import type { BalanceObservationSource, CurrencyBalance } from './types.ts';

export interface BalanceObservation {
  balanceCny: string;
  source: BalanceObservationSource;
}

export interface ParsedBalance {
  available: boolean;
  /** One validated entry per currency code, amounts kept as exact decimal strings. */
  entries: CurrencyBalance[];
}

/** Preserve the server's decimal representation without binary-float rounding. */
export function parseBalance(value: unknown): ParsedBalance {
  if (!value || typeof value !== 'object') throw new Error('Invalid balance response');
  const payload = value as Record<string, unknown>;
  if (typeof payload.is_available !== 'boolean' || !Array.isArray(payload.balance_infos)) {
    throw new Error('Invalid balance response');
  }
  const raw = payload.balance_infos.filter(
    (entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object',
  );
  if (raw.length !== payload.balance_infos.length) throw new Error('Invalid balance response');
  const seen = new Set<string>();
  const entries = raw.map((entry) => {
    if (typeof entry.currency !== 'string' || !/^[A-Za-z]{3}$/.test(entry.currency)) {
      throw new Error('Invalid balance currency');
    }
    const currency = entry.currency.toUpperCase();
    if (seen.has(currency)) throw new Error(`Ambiguous ${currency} balance response`);
    seen.add(currency);
    if (!isDecimalString(entry.total_balance, 100)) throw new Error(`Invalid ${currency} balance`);
    return { currency, amount: entry.total_balance as string };
  });
  return { available: payload.is_available, entries };
}

/**
 * Sum every currency in CNY. CNY amounts keep their exact server representation;
 * other currencies convert at CNY-per-unit rates, each rounded half-up to 4 decimals.
 * Returns null when any required rate is missing, so partial totals are never shown.
 */
export function totalInCny(entries: readonly CurrencyBalance[], rates: ReadonlyMap<string, string>): string | null {
  let total: string | null = null;
  for (const entry of entries) {
    if (entry.currency === 'CNY') {
      total = total === null ? entry.amount : addDecimals(total, entry.amount);
      continue;
    }
    const rate = rates.get(entry.currency);
    if (rate === undefined) return null;
    const converted = multiplyDecimals(entry.amount, rate, 4);
    total = total === null ? converted : addDecimals(total, converted);
  }
  return total;
}

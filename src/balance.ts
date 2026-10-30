import { isDecimalString } from './money.ts';
import type { BalanceObservationSource } from './types.ts';

export interface BalanceObservation {
  balanceCny: string;
  source: BalanceObservationSource;
}

export interface ParsedBalance {
  available: boolean;
  balanceCny: string | null;
  statisticsObservation: BalanceObservation | null;
}

/** Preserve the server's decimal representation without binary-float rounding. */
export function parseBalance(value: unknown): ParsedBalance {
  if (!value || typeof value !== 'object') throw new Error('Invalid balance response');
  const payload = value as Record<string, unknown>;
  if (typeof payload.is_available !== 'boolean' || !Array.isArray(payload.balance_infos)) {
    throw new Error('Invalid balance response');
  }
  const entries = payload.balance_infos.filter(
    (entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object',
  );
  if (entries.length !== payload.balance_infos.length) throw new Error('Invalid balance response');
  const cny = entries.filter((entry) => entry.currency === 'CNY');
  if (cny.length > 1) throw new Error('Ambiguous CNY balance response');
  const amount = cny[0]?.total_balance;
  if (cny.length && !isDecimalString(amount, 100)) {
    throw new Error('Invalid CNY balance');
  }
  const balanceCny = cny.length ? amount as string : null;
  return {
    available: payload.is_available,
    balanceCny,
    statisticsObservation: balanceCny !== null ? { balanceCny, source: 'api' }
      : !payload.is_available && entries.length === 0 ? { balanceCny: '0', source: 'unavailable-zero' }
        : null,
  };
}

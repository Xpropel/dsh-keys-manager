import { isDecimalString } from './money.ts';

/**
 * Default exchange-rate source: Frankfurter (European Central Bank reference
 * rates, no API key required). Returns the CNY value of one unit of the given
 * currency as an exact decimal string, or null when no trustworthy rate exists.
 */
export async function fetchCnyRate(
  fetcher: typeof globalThis.fetch,
  currency: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const response = await fetcher(`https://api.frankfurter.app/latest?from=${currency}&to=CNY`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    const payload = (await response.json()) as { rates?: Record<string, unknown> } | null;
    const rate = payload?.rates?.CNY;
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) return null;
    const text = String(rate);
    return isDecimalString(text, 32) ? text : null;
  } catch {
    return null;
  }
}

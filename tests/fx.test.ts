import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchCnyRate } from '../src/fx.ts';

const jsonResponse = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status });

test('reads the CNY rate for one unit of the requested currency', async () => {
  const fetcher = async (url: string | URL | Request) => {
    assert.match(String(url), /from=USD&to=CNY/);
    return jsonResponse({ amount: 1, base: 'USD', date: '2026-10-30', rates: { CNY: 6.6529 } });
  };
  assert.equal(await fetchCnyRate(fetcher as typeof fetch, 'USD'), '6.6529');
});

test('returns null for HTTP errors, malformed payloads and network failures', async () => {
  const httpError = async () => jsonResponse({}, 500);
  assert.equal(await fetchCnyRate(httpError as typeof fetch, 'USD'), null);
  const missing = async () => jsonResponse({ rates: {} });
  assert.equal(await fetchCnyRate(missing as typeof fetch, 'USD'), null);
  const notNumber = async () => jsonResponse({ rates: { CNY: '6.6529' } });
  assert.equal(await fetchCnyRate(notNumber as typeof fetch, 'USD'), null);
  const offline = async () => { throw new Error('offline'); };
  assert.equal(await fetchCnyRate(offline as typeof fetch, 'USD'), null);
});

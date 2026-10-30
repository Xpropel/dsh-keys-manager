import assert from 'node:assert/strict';
import { setImmediate as yieldTurn, setTimeout as pause } from 'node:timers/promises';
import test from 'node:test';
import { parseBalance } from '../src/balance.ts';
import { KeyPool, PoolError, type KeyPoolRefreshTiming } from '../src/pool.ts';
import type { CredentialStore, KeyPoolOptions, KeyStatistics, LegacyPoolMetadata, MetadataStore, PoolMetadata } from '../src/types.ts';

const keyA = 'sk-test-secret-aaaaaaaa';
const keyB = 'sk-test-secret-bbbbbbbb';
const keyC = 'sk-test-secret-cccccccc';
const balance = (amount = '10.00', available = true) => new Response(JSON.stringify({
  is_available: available, balance_infos: [{ currency: 'CNY', total_balance: amount }],
}), { status: 200 });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(overrides: Partial<KeyPoolOptions> = {}, timing: Partial<KeyPoolRefreshTiming> = {}) {
  const secrets = new Map<string, string>();
  let saved: PoolMetadata | undefined;
  const credentials: CredentialStore = {
    async resolve(ref) { return secrets.get(ref); },
    async set(ref, value) { secrets.set(ref, value); },
    async unset(ref) { secrets.delete(ref); },
  };
  const metadata: MetadataStore = {
    async load() { return saved ? structuredClone(saved) : undefined; },
    async save(value) { saved = structuredClone(value); },
  };
  const pool = new KeyPool({
    credentials, metadata, now: () => 1234567890, fetch: async () => balance(), ...overrides,
  }, timing);
  return { pool, secrets, credentials, metadata, saved: () => saved };
}

test('imports normalized unique keys, masks secrets, and isolates snapshot copies', async (t) => {
  const { pool, secrets, saved } = fixture();
  t.after(() => pool.stop());
  const result = await pool.importKeys([{ key: `  ${keyA}  ` }, { key: keyA }, { key: keyB, label: '备用' }]);
  assert.equal(result.addedIds.length, 2);
  assert.equal(result.duplicateCount, 1);
  assert.equal(secrets.size, 2);
  assert.equal(pool.snapshot().activeId, result.addedIds[0]);
  const serialized = JSON.stringify({ snapshot: pool.snapshot(), metadata: saved() });
  assert.equal(serialized.includes(keyA), false);
  assert.equal(serialized.includes(keyB), false);
  assert.equal('credentialRef' in pool.snapshot().keys[0]!, false);
  assert.match(saved()!.keys[0]!.credentialRef, /^[A-Za-z_][A-Za-z0-9_]*$/);
  const copy = pool.snapshot();
  copy.keys[0]!.label = 'mutated';
  copy.settings.autoSwitch = false;
  copy.keys[0]!.statistics.totalConsumedCny = '100.00';
  copy.events.length = 0;
  assert.equal(pool.snapshot().keys[0]!.label, 'Key 1');
  assert.equal(pool.snapshot().settings.autoSwitch, true);
  assert.equal(pool.snapshot().keys[0]!.statistics.totalConsumedCny, '0');
  assert.equal(pool.snapshot().events.length, 1);
  assert.deepEqual(await pool.acquire(), { id: result.addedIds[0], key: keyA });
});

test('rejects invalid batches atomically and never places full keys in labels', async (t) => {
  const { pool, secrets } = fixture();
  t.after(() => pool.stop());
  for (const inputs of [[], [{ key: '' }], [{ key: 'sk bad' }], [{ key: 'sk\nbad' }],
    [{ key: keyA }, { key: keyB, label: keyB }], [{ key: keyA, label: keyB }, { key: keyB }],
    Array.from({ length: 201 }, () => ({ key: keyA }))]) {
    await assert.rejects(pool.importKeys(inputs), (error: unknown) => error instanceof PoolError && error.code === 'VALIDATION');
  }
  assert.equal(pool.snapshot().keys.length, 0);
  assert.equal(secrets.size, 0);
});

test('serializes concurrent duplicate imports', async (t) => {
  const { pool, secrets } = fixture();
  t.after(() => pool.stop());
  const results = await Promise.all(Array.from({ length: 12 }, () => pool.importKeys([{ key: keyA }])));
  assert.equal(results.reduce((sum, result) => sum + result.addedIds.length, 0), 1);
  assert.equal(pool.snapshot().keys.length, 1);
  assert.equal(secrets.size, 1);
});

test('keeps a sticky active key and uses explicit priority after 402', async (t) => {
  const { pool } = fixture();
  t.after(() => pool.stop());
  const { addedIds: [a, b, c] } = await pool.importKeys([{ key: keyA }, { key: keyB }, { key: keyC }]);
  await pool.reorder([c!, b!, a!]);
  assert.equal((await pool.acquire()).id, a);
  await pool.reportFailure(a!, 402);
  assert.equal(pool.snapshot().keys.find((entry) => entry.id === a)?.enabled, true);
  assert.equal(pool.snapshot().keys.find((entry) => entry.id === a)?.status, 'exhausted');
  assert.equal((await pool.acquire()).id, c);
  await pool.reportFailure(c!, 401);
  assert.equal((await pool.acquire()).id, b);
  await pool.reportFailure(b!, 402);
  await assert.rejects(pool.acquire(), { code: 'NO_AVAILABLE_KEY' });
  assert.equal(pool.snapshot().events.some((event) => event.kind === 'exhausted'), true);
  assert.equal(pool.snapshot().events.some((event) => event.kind === 'invalid'), true);
});

test('does not switch a failed active key when automatic switching is disabled', async (t) => {
  const { pool } = fixture();
  t.after(() => pool.stop());
  const { addedIds: [a, b] } = await pool.importKeys([{ key: keyA }, { key: keyB }]);
  await pool.updateSettings({ autoSwitch: false });
  await pool.markExhausted(a!);
  assert.equal(pool.snapshot().activeId, a);
  await assert.rejects(pool.acquire(), { code: 'ACTIVE_KEY_UNAVAILABLE' });
  await pool.setActive(b!);
  assert.equal((await pool.acquire()).key, keyB);
});

test('disabling, removing and reordering maintain eligibility without losing credentials prematurely', async (t) => {
  const { pool, secrets } = fixture();
  t.after(() => pool.stop());
  const { addedIds: [a, b, c] } = await pool.importKeys([{ key: keyA }, { key: keyB }, { key: keyC }]);
  await assert.rejects(pool.reorder([a!, b!]), { code: 'VALIDATION' });
  await assert.rejects(pool.reorder([a!, a!, c!]), { code: 'VALIDATION' });
  await pool.setEnabled(a!, false);
  assert.equal((await pool.acquire()).id, b);
  await assert.rejects(pool.setActive(a!), { code: 'ACTIVE_KEY_UNAVAILABLE' });
  await pool.remove(b!);
  assert.equal(secrets.size, 2);
  assert.equal((await pool.acquire()).id, c);
  await pool.setEnabled(c!, false);
  await assert.rejects(pool.acquire(), { code: 'NO_AVAILABLE_KEY' });
  await pool.setEnabled(a!, true);
  assert.equal((await pool.acquire()).id, a);
});

test('exact CNY strings survive refresh; currency does not override is_available', async (t) => {
  let response = balance('9007199254740993.00123456789');
  const { pool } = fixture({ fetch: async () => response });
  t.after(() => pool.stop());
  const { addedIds: [id] } = await pool.importKeys([{ key: keyA }]);
  await pool.refresh(id);
  assert.equal(pool.snapshot().keys[0]!.balanceCny, '9007199254740993.00123456789');
  assert.equal(pool.snapshot().keys[0]!.lastCheckedAt, 1234567890);
  response = balance('0.00', true);
  await pool.refresh(id);
  assert.equal(pool.snapshot().keys[0]!.status, 'ready');
  response = new Response(JSON.stringify({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '2.00' }] }));
  await pool.refresh(id);
  assert.equal(pool.snapshot().keys[0]!.balanceCny, null);
  assert.equal((await pool.acquire()).id, id);
});

test('balance errors retain old amounts and redact upstream secrets', async (t) => {
  let response: () => Promise<Response> = async () => balance('12.3400');
  const { pool } = fixture({ fetch: (..._args) => response() });
  t.after(() => pool.stop());
  const { addedIds: [id] } = await pool.importKeys([{ key: keyA }]);
  await pool.refresh(id);
  response = async () => { throw new Error(`Network request ${keyA}`); };
  await pool.refresh(id);
  assert.equal(pool.snapshot().keys[0]!.balanceCny, '12.3400');
  assert.equal(pool.snapshot().keys[0]!.status, 'error');
  assert.equal(JSON.stringify(pool.snapshot()).includes(keyA), false);
  response = async () => new Response(keyA, { status: 503 });
  await pool.refresh(id);
  assert.match(pool.snapshot().keys[0]!.lastError!, /503/);
  assert.equal(pool.snapshot().keys[0]!.balanceCny, '12.3400');
});

test('a failed refresh cannot reactivate exhausted keys; a successful refresh can', async (t) => {
  let fail = false;
  const { pool } = fixture({ fetch: async () => { if (fail) throw Error('offline'); return balance(); } });
  t.after(() => pool.stop());
  const { addedIds: [id] } = await pool.importKeys([{ key: keyA }]);
  await pool.markExhausted(id!);
  fail = true;
  await pool.refresh(id);
  assert.equal(pool.snapshot().keys[0]!.status, 'exhausted');
  await assert.rejects(pool.acquire(), { code: 'NO_AVAILABLE_KEY' });
  fail = false;
  await pool.refresh(id);
  assert.equal((await pool.acquire()).id, id);
  assert.equal(pool.snapshot().events.some((event) => event.kind === 'recovered'), true);
});

test('new failure events win over a previously started balance response', async (t) => {
  const gate = deferred<Response>();
  const started = deferred<void>();
  const { pool } = fixture({ fetch: async () => { started.resolve(); return gate.promise; } });
  t.after(() => pool.stop());
  const { addedIds: [id] } = await pool.importKeys([{ key: keyA }]);
  const refresh = pool.refresh(id);
  await started.promise;
  await pool.reportFailure(id!, 401);
  gate.resolve(balance('99.00'));
  await refresh;
  assert.equal(pool.snapshot().keys[0]!.status, 'invalid');
  assert.equal(pool.snapshot().keys[0]!.balanceCny, null);
});

test('newer balance refresh results win over older ones', async (t) => {
  const first = deferred<Response>();
  const started = deferred<void>();
  let count = 0;
  const { pool } = fixture({ fetch: async () => {
    if (++count === 1) { started.resolve(); return first.promise; }
    return balance('20.00');
  } });
  t.after(() => pool.stop());
  const { addedIds: [id] } = await pool.importKeys([{ key: keyA }]);
  const old = pool.refresh(id);
  await started.promise;
  await pool.refresh(id);
  first.resolve(balance('999.00'));
  await old;
  assert.equal(pool.snapshot().keys[0]!.balanceCny, '20.00');
});

test('limits aggregate balance concurrency to three', async (t) => {
  const gate = deferred<void>();
  let current = 0;
  let maximum = 0;
  let total = 0;
  const { pool } = fixture({ fetch: async () => {
    total++;
    current++;
    maximum = Math.max(current, maximum);
    await gate.promise;
    current--;
    return balance();
  } });
  t.after(() => pool.stop());
  await pool.importKeys(Array.from({ length: 8 }, (_, i) => ({ key: `sk-concurrency-secret-${i}` })));
  const refreshing = pool.refresh();
  for (let i = 0; i < 30 && total < 3; i++) await yieldTurn();
  assert.equal(total, 3);
  gate.resolve();
  await refreshing;
  assert.equal(total, 8);
  assert.equal(maximum, 3);
});

test('times out balance requests without leaking secrets', async (t) => {
  const { pool } = fixture({ refreshTimeoutMs: 10, fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error(keyA)), { once: true });
  }) });
  t.after(() => pool.stop());
  await pool.importKeys([{ key: keyA }]);
  await pool.refresh();
  assert.equal(pool.snapshot().keys[0]!.status, 'error');
  assert.match(pool.snapshot().keys[0]!.lastError!, /超时/);
  assert.equal(JSON.stringify(pool.snapshot()).includes(keyA), false);
});

test('unrelated HTTP failures do not mark a key exhausted', async (t) => {
  const { pool } = fixture();
  t.after(() => pool.stop());
  const { addedIds: [id] } = await pool.importKeys([{ key: keyA }]);
  for (const status of [400, 429, 500, 503]) await pool.reportFailure(id!, status);
  assert.equal(pool.snapshot().keys[0]!.status, 'unknown');
  assert.equal((await pool.acquire()).id, id);
});

test('missing credentials are marked invalid and fail over', async (t) => {
  const { pool, secrets, saved } = fixture();
  t.after(() => pool.stop());
  const { addedIds: [a, b] } = await pool.importKeys([{ key: keyA }, { key: keyB }]);
  secrets.delete(saved()!.keys[0]!.credentialRef);
  assert.equal((await pool.acquire()).id, b);
  assert.equal(pool.snapshot().keys.find((entry) => entry.id === a)?.status, 'invalid');
});

test('a failed metadata save rolls back newly stored credentials and permits later mutations', async (t) => {
  const { credentials, secrets } = fixture();
  let failing = true;
  const { pool } = fixture({ credentials, metadata: {
    async load() { return undefined; },
    async save() { if (failing) throw Error(keyA); },
  } });
  t.after(() => pool.stop());
  await assert.rejects(pool.importKeys([{ key: keyA }]), (error: unknown) => {
    assert.ok(error instanceof PoolError);
    assert.equal(error.message.includes(keyA), false);
    return error.code === 'STORAGE_ERROR';
  });
  assert.equal(secrets.size, 0);
  assert.equal(pool.snapshot().keys.length, 0);
  failing = false;
  await pool.importKeys([{ key: keyB }]);
  assert.equal(pool.snapshot().keys.length, 1);
});

test('refresh can finish safely after a key is removed', async (t) => {
  const gate = deferred<Response>();
  const started = deferred<void>();
  const { pool } = fixture({ fetch: async () => { started.resolve(); return gate.promise; } });
  t.after(() => pool.stop());
  const { addedIds: [id] } = await pool.importKeys([{ key: keyA }]);
  const pending = pool.refresh(id);
  await started.promise;
  await pool.remove(id!);
  gate.resolve(balance());
  await pending;
  await pool.reportFailure(id!, 402);
  assert.equal(pool.snapshot().keys.length, 0);
});

test('stop aborts in-flight refresh and prevents further work', async () => {
  const started = deferred<void>();
  let aborted = false;
  const { pool } = fixture({ fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
    started.resolve();
    init?.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
  }) });
  await pool.importKeys([{ key: keyA }]);
  const pending = pool.refresh();
  await started.promise;
  pool.stop();
  await pending;
  assert.equal(aborted, true);
  assert.equal(pool.snapshot().keys[0]!.status, 'unknown');
  await assert.rejects(pool.acquire(), { code: 'POOL_STOPPED' });
});

test('persisted state is reloaded, while event log is limited and process-local', async (t) => {
  const { pool, credentials, metadata, saved } = fixture();
  t.after(() => pool.stop());
  const { addedIds: [a, b] } = await pool.importKeys([{ key: keyA }, { key: keyB }]);
  for (let i = 0; i < 55; i++) await pool.setActive(i % 2 ? a! : b!);
  assert.equal(pool.snapshot().events.length, 50);
  assert.equal('events' in saved()!, false);
  const second = new KeyPool({ credentials, metadata, fetch: async () => balance() });
  t.after(() => second.stop());
  await second.init();
  assert.equal(second.snapshot().events.length, 0);
  assert.deepEqual(second.snapshot().keys, pool.snapshot().keys);
  assert.equal((await second.acquire()).id, pool.snapshot().activeId);
});

test('rejects corrupt metadata and invalid settings without echoing contents', async (t) => {
  const { pool } = fixture({ metadata: { async load() { return { version: 100, key: keyA } as unknown as PoolMetadata; }, async save() {} } });
  t.after(() => pool.stop());
  await assert.rejects(pool.init(), (error: unknown) => error instanceof PoolError && !error.message.includes(keyA));
  const clean = fixture().pool;
  t.after(() => clean.stop());
  for (const seconds of [-1, 1, 29, 86401, Number.NaN, 31.2]) {
    await assert.rejects(clean.updateSettings({ refreshIntervalSeconds: seconds }), { code: 'VALIDATION' });
  }
  await clean.updateSettings({ refreshIntervalSeconds: 0 });
  assert.equal(clean.snapshot().settings.refreshIntervalSeconds, 0);
});

test('balance parser rejects malformed amounts and does not infer availability', () => {
  assert.deepEqual(parseBalance({ is_available: false, balance_infos: [{ currency: 'CNY', total_balance: '0.001' }] }),
    { available: false, balanceCny: '0.001', statisticsObservation: { balanceCny: '0.001', source: 'api' } });
  for (const input of [null, {}, { is_available: 'true', balance_infos: [] },
    { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: 1.5 }] },
    { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '1e+3' }] },
    { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '1' }, { currency: 'CNY', total_balance: '2' }] }]) {
    assert.throws(() => parseBalance(input));
  }
});

test('statistics establish a first-observation baseline and accumulate decreases and increases independently', async t => {
  let amount = '10.0000';
  let clock = 1000;
  const { pool, saved } = fixture({ now: () => clock, fetch: async () => balance(amount) });
  t.after(() => pool.stop());
  const { addedIds: [id] } = await pool.importKeys([{ key: keyA }]);
  assert.equal(pool.snapshot().keys[0]!.statistics.initialBalanceCny, null);
  await pool.refresh(id);
  assert.deepEqual(pool.snapshot().keys[0]!.statistics, {
    initialBalanceCny: '10.0000', lastObservedCny: '10.0000', totalConsumedCny: '0', totalAddedCny: '0',
    startedAt: 1000, updatedAt: 1000, lastObservationSource: 'api',
  });
  clock = 2000; amount = '7.2000'; await pool.refresh(id);
  clock = 3000; amount = '12.2000'; await pool.refresh(id);
  clock = 4000; amount = '11.9000'; await pool.refresh(id);
  const entry = pool.snapshot().keys[0]!;
  assert.deepEqual(entry.statistics, {
    initialBalanceCny: '10.0000', lastObservedCny: '11.9000', totalConsumedCny: '3.1000', totalAddedCny: '5.0000',
    startedAt: 1000, updatedAt: 4000, lastObservationSource: 'api',
  });
  assert.equal(entry.balanceCny, '11.9000');
  assert.equal(entry.balanceObservationSource, 'api');
  assert.equal(entry.balanceObservedAt, 4000);
  assert.equal(saved()!.version, 2);
  assert.deepEqual(saved()!.keys[0]!.statistics, entry.statistics);
  assert.equal(JSON.stringify(saved()).includes(keyA), false);
});

test('only an empty unavailable balance response derives a zero observation', async t => {
  let response = balance('0.12345678901234567890');
  const { pool } = fixture({ fetch: async () => response, now: () => 1000 });
  t.after(() => pool.stop());
  const { addedIds: [id] } = await pool.importKeys([{ key: keyA }]);
  await pool.refresh(id);
  await pool.markExhausted(id!);
  assert.equal(pool.snapshot().keys[0]!.statistics.totalConsumedCny, '0');
  assert.equal(pool.snapshot().keys[0]!.balanceCny, '0.12345678901234567890');
  response = new Response(JSON.stringify({ is_available: false, balance_infos: [] }));
  await pool.refresh(id);
  let entry = pool.snapshot().keys[0]!;
  assert.equal(entry.balanceCny, null);
  assert.equal(entry.balanceObservationSource, 'unavailable-zero');
  assert.equal(entry.balanceObservedAt, 1000);
  assert.equal(entry.statistics.lastObservedCny, '0');
  assert.equal(entry.statistics.totalConsumedCny, '0.12345678901234567890');
  assert.equal(entry.statistics.lastObservationSource, 'unavailable-zero');
  const statistics = entry.statistics;
  // Same timestamp is deliberate: current observation evidence cannot rely on timestamps for identity.
  response = new Response(JSON.stringify({ is_available: false, balance_infos: [{ currency: 'USD', total_balance: '0.00' }] }));
  await pool.refresh(id);
  entry = pool.snapshot().keys[0]!;
  assert.equal(entry.balanceCny, null);
  assert.equal(entry.balanceObservationSource, null);
  assert.equal(entry.balanceObservedAt, null);
  assert.deepEqual(entry.statistics, statistics);
  response = new Response(JSON.stringify({ is_available: true, balance_infos: [] }));
  await pool.refresh(id);
  assert.deepEqual(pool.snapshot().keys[0]!.statistics, statistics);
  assert.equal(pool.snapshot().keys[0]!.balanceObservationSource, null);
});

test('first unavailable-empty result starts at zero without inventing historical usage', async t => {
  const { pool } = fixture({ fetch: async () => new Response(JSON.stringify({ is_available: false, balance_infos: [] })) });
  t.after(() => pool.stop());
  await pool.importKeys([{ key: keyA }]);
  await pool.refresh();
  const statistics = pool.snapshot().keys[0]!.statistics;
  assert.equal(statistics.initialBalanceCny, '0');
  assert.equal(statistics.lastObservedCny, '0');
  assert.equal(statistics.totalConsumedCny, '0');
  assert.equal(statistics.totalAddedCny, '0');
  assert.equal(statistics.lastObservationSource, 'unavailable-zero');
});

test('failed balance checks preserve statistics and actual observation time, separate from check time', async t => {
  let clock = 1000;
  let mode: 'ok' | 'network' | 'invalid' | 'server' = 'ok';
  const { pool } = fixture({ now: () => clock, fetch: async () => {
    if (mode === 'network') throw Error(keyA);
    if (mode === 'invalid') return new Response('{malformed JSON');
    if (mode === 'server') return new Response('unavailable', { status: 503 });
    return balance('9.999999999999999999');
  } });
  t.after(() => pool.stop());
  await pool.importKeys([{ key: keyA }]);
  await pool.refresh();
  const expected = pool.snapshot().keys[0]!.statistics;
  for (const failure of ['network', 'invalid', 'server'] as const) {
    mode = failure; clock += 1000;
    await pool.refresh();
    const entry = pool.snapshot().keys[0]!;
    assert.deepEqual(entry.statistics, expected);
    assert.equal(entry.balanceCny, '9.999999999999999999');
    assert.equal(entry.balanceObservationSource, 'api');
    assert.equal(entry.balanceObservedAt, 1000);
    assert.equal(entry.lastCheckedAt, clock);
    assert.equal(entry.status, 'error');
  }
});

test('an actual 402 does not zero statistics while a later balance API still reports funds', async t => {
  let amount = '1.00';
  const { pool } = fixture({ fetch: async () => balance(amount) });
  t.after(() => pool.stop());
  const { addedIds: [id] } = await pool.importKeys([{ key: keyA }]);
  await pool.refresh(id);
  await pool.reportFailure(id!, 402);
  assert.equal(pool.snapshot().keys[0]!.statistics.totalConsumedCny, '0');
  amount = '0.70';
  await pool.refresh(id);
  const statistics = pool.snapshot().keys[0]!.statistics;
  assert.equal(statistics.lastObservedCny, '0.70');
  assert.equal(statistics.totalConsumedCny, '0.30');
  assert.equal(statistics.totalAddedCny, '0');
  assert.equal(statistics.lastObservationSource, 'api');
});

test('statistics persist across restart and continue from the last observation', async t => {
  let amount = '9007199254740993.12345678901234567890';
  const { pool, credentials, metadata } = fixture({ fetch: async () => balance(amount) });
  t.after(() => pool.stop());
  await pool.importKeys([{ key: keyA }]);
  await pool.refresh();
  amount = '9007199254740993.12345678901234567889';
  await pool.refresh();
  assert.equal(pool.snapshot().keys[0]!.statistics.totalConsumedCny, '0.00000000000000000001');
  const resumed = new KeyPool({ credentials, metadata, fetch: async () => balance(amount) });
  t.after(() => resumed.stop());
  await resumed.init();
  assert.deepEqual(resumed.snapshot().keys[0]!.statistics, pool.snapshot().keys[0]!.statistics);
  amount = '9007199254740993.12345678901234567887';
  await resumed.refresh();
  assert.equal(resumed.snapshot().keys[0]!.statistics.totalConsumedCny, '0.00000000000000000003');
  assert.equal(resumed.snapshot().keys[0]!.statistics.initialBalanceCny, '9007199254740993.12345678901234567890');
});

function legacyMetadata(): LegacyPoolMetadata {
  return {
    version: 1, activeId: 'old-key', settings: { autoSwitch: true, refreshIntervalSeconds: 0 },
    keys: [{
      id: 'old-key', credentialRef: 'OLD_KEY_REFERENCE', label: '旧 Key', maskedKey: 'sk-••••aaaa', enabled: true,
      status: 'error', balanceCny: '100.00', lastCheckedAt: 77, lastError: '曾经查询失败。',
    }],
  };
}

test('version 1 metadata migrates to version 2 without treating cached amounts as historical statistics', async t => {
  let saved: PoolMetadata | undefined;
  const pool = new KeyPool({
    credentials: { resolve: async () => keyA, set: async () => {}, unset: async () => {} },
    metadata: { load: async () => legacyMetadata(), save: async value => { saved = structuredClone(value); } },
    fetch: async () => balance('80.00'), now: () => 1000,
  });
  t.after(() => pool.stop());
  await pool.init();
  assert.equal(saved!.version, 2);
  let entry = pool.snapshot().keys[0]!;
  assert.equal(entry.balanceCny, '100.00');
  assert.equal(entry.balanceObservationSource, 'api');
  assert.equal(entry.balanceObservedAt, null);
  assert.equal(entry.lastCheckedAt, 77);
  assert.equal(entry.statistics.initialBalanceCny, null);
  assert.equal(entry.statistics.totalConsumedCny, '0');
  await pool.refresh();
  entry = pool.snapshot().keys[0]!;
  assert.equal(entry.statistics.initialBalanceCny, '80.00');
  assert.equal(entry.statistics.totalConsumedCny, '0');
  assert.equal(entry.statistics.totalAddedCny, '0');
  assert.equal(entry.balanceObservedAt, 1000);
});

test('migration storage failures are surfaced safely without activating a half-migrated pool', async t => {
  const { pool } = fixture({ metadata: {
    load: async () => legacyMetadata(), save: async () => { throw Error(keyA); },
  } });
  t.after(() => pool.stop());
  await assert.rejects(pool.init(), error => error instanceof PoolError && error.code === 'STORAGE_ERROR' && !error.message.includes(keyA));
  assert.equal(pool.snapshot().keys.length, 0);
});

test('version 2 validates complete nonnegative statistics and the balance-change identity', async t => {
  const baseline: KeyStatistics = {
    initialBalanceCny: '10.00', lastObservedCny: '9.00', totalConsumedCny: '1.00', totalAddedCny: '0',
    startedAt: 1000, updatedAt: 2000, lastObservationSource: 'api',
  };
  const variants: unknown[] = [
    undefined, {}, { ...baseline, totalConsumedCny: '-1' }, { ...baseline, totalAddedCny: 'NaN' },
    { ...baseline, initialBalanceCny: null }, { ...baseline, updatedAt: 999 },
    { ...baseline, lastObservationSource: 'unavailable-zero' }, { ...baseline, totalConsumedCny: '2.00' },
    { ...baseline, lastObservedCny: 9 }, { ...baseline, totalAddedCny: '1e2' },
  ];
  for (const statistics of variants) {
    const legacy = legacyMetadata();
    const state = {
      ...legacy, version: 2, keys: [{ ...legacy.keys[0]!, statistics, balanceObservationSource: 'api', balanceObservedAt: 2000 }],
    } as PoolMetadata;
    const { pool } = fixture({ metadata: { load: async () => state, save: async () => {} } });
    t.after(() => pool.stop());
    await assert.rejects(pool.init(), { code: 'STORAGE_ERROR' });
  }
});

test('a stale concurrent refresh cannot add a false consumption or refill movement', async t => {
  const oldResponse = deferred<Response>();
  const started = deferred<void>();
  let count = 0;
  const { pool } = fixture({ fetch: async () => {
    count++;
    if (count === 1) return balance('100.00');
    if (count === 2) { started.resolve(); return oldResponse.promise; }
    return balance('80.00');
  } });
  t.after(() => pool.stop());
  await pool.importKeys([{ key: keyA }]);
  await pool.refresh();
  const stale = pool.refresh();
  await started.promise;
  await pool.refresh();
  oldResponse.resolve(balance('90.00'));
  await stale;
  const statistics = pool.snapshot().keys[0]!.statistics;
  assert.equal(statistics.lastObservedCny, '80.00');
  assert.equal(statistics.totalConsumedCny, '20.00');
  assert.equal(statistics.totalAddedCny, '0');
});

test('first acquisition waits for one shared baseline check before returning concurrent leases', async t => {
  const response = deferred<Response>();
  const started = deferred<void>();
  let checks = 0;
  let returned = false;
  const { pool } = fixture({ fetch: async () => { checks++; started.resolve(); return response.promise; } });
  t.after(() => pool.stop());
  await pool.importKeys([{ key: keyA }]);
  const first = pool.acquire().then(lease => { returned = true; return lease; });
  const second = pool.acquire();
  await started.promise;
  await yieldTurn();
  assert.equal(checks, 1);
  assert.equal(returned, false);
  response.resolve(balance('8.1200'));
  assert.equal((await first).key, keyA);
  assert.equal((await second).key, keyA);
  assert.equal(pool.snapshot().keys[0]!.statistics.initialBalanceCny, '8.1200');
});

test('an unavailable first-use balance skips that key without fabricating past consumption', async t => {
  const checked: string[] = [];
  const { pool } = fixture({ fetch: async (_url, init) => {
    const key = new Headers(init?.headers).get('authorization')!;
    checked.push(key);
    return key.includes(keyA) ? Response.json({ is_available: false, balance_infos: [] }) : balance('2.00');
  } });
  t.after(() => pool.stop());
  const { addedIds: [a, b] } = await pool.importKeys([{ key: keyA }, { key: keyB }]);
  assert.equal((await pool.acquire()).id, b);
  assert.equal(checked.length, 2);
  const unavailable = pool.snapshot().keys.find(key => key.id === a)!;
  assert.equal(unavailable.status, 'exhausted');
  assert.equal(unavailable.statistics.initialBalanceCny, '0');
  assert.equal(unavailable.statistics.totalConsumedCny, '0');
});

test('a failed first-use query leaves the baseline unknown and does not repeatedly block normal acquisition', async t => {
  let checks = 0;
  const { pool } = fixture({ fetch: async () => { checks++; throw Error('synthetic unavailable balance API'); } }, {
    baselineTimeoutMs: 25, minimumRefreshIntervalMs: 1000,
  });
  t.after(() => pool.stop());
  await pool.importKeys([{ key: keyA }]);
  assert.equal((await pool.acquire()).key, keyA);
  assert.equal((await pool.acquire()).key, keyA);
  assert.equal(checks, 1);
  const entry = pool.snapshot().keys[0]!;
  assert.equal(entry.statistics.initialBalanceCny, null);
  assert.equal(entry.statistics.totalConsumedCny, '0');
  assert.equal(entry.status, 'error');
});

test('baseline deadline includes waiting for an already-running balance check', { timeout: 1000 }, async t => {
  const started = deferred<void>();
  const { pool } = fixture({ fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
    started.resolve();
    init?.signal?.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
  }) }, { baselineTimeoutMs: 15 });
  t.after(() => pool.stop());
  await pool.importKeys([{ key: keyA }]);
  const background = pool.refresh();
  await started.promise;
  assert.equal((await pool.acquire()).key, keyA);
  assert.equal(pool.snapshot().keys[0]!.statistics.startedAt, null);
  pool.stop();
  await background;
});

test('baseline deadline also bounds a queued first-use query without sending it later', { timeout: 1000 }, async t => {
  let calls = 0;
  const allBusy = deferred<void>();
  const { pool } = fixture({ fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
    if (++calls === 3) allBusy.resolve();
    init?.signal?.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
  }) }, { baselineTimeoutMs: 15 });
  t.after(() => pool.stop());
  const { addedIds } = await pool.importKeys([keyA, keyB, keyC, 'sk-queued-extra-key'].map(key => ({ key })));
  const background = pool.refresh();
  await allBusy.promise;
  await pool.setActive(addedIds[3]!);
  assert.equal((await pool.acquire()).key, 'sk-queued-extra-key');
  assert.equal(calls, 3);
  pool.stop();
  await background;
  assert.equal(calls, 3);
});

test('aborting an acquisition stops the caller while a shared baseline can still serve another request', async t => {
  const response = deferred<Response>();
  const started = deferred<void>();
  const { pool } = fixture({ fetch: async () => { started.resolve(); return response.promise; } });
  t.after(() => pool.stop());
  await pool.importKeys([{ key: keyA }]);
  const controller = new AbortController();
  const canceled = pool.acquire(controller.signal);
  const live = pool.acquire();
  await started.promise;
  controller.abort(new Error('synthetic cancellation'));
  await assert.rejects(canceled, /synthetic cancellation/);
  response.resolve(balance('3.00'));
  assert.equal((await live).key, keyA);
  assert.equal(pool.snapshot().keys[0]!.statistics.initialBalanceCny, '3.00');
});

test('scheduled refreshes coalesce per key, target only requested ids, and respect a minimum interval', async t => {
  const observed: Array<{ key: string; at: number }> = [];
  const { pool } = fixture({ fetch: async (_url, init) => {
    observed.push({ key: new Headers(init?.headers).get('authorization')!, at: performance.now() });
    return balance('4.00');
  } }, { afterRequestDelayMs: 2, minimumRefreshIntervalMs: 25 });
  t.after(() => pool.stop());
  const { addedIds: [a] } = await pool.importKeys([{ key: keyA }, { key: keyB }]);
  await Promise.all([pool.scheduleRefresh([a!, a!]), pool.scheduleRefresh([a!]), pool.scheduleRefresh([a!])]);
  assert.equal(observed.length, 1);
  await pool.scheduleRefresh([a!]);
  assert.equal(observed.length, 2);
  assert.ok(observed[1]!.at - observed[0]!.at >= 24);
  assert.equal(observed.every(value => value.key.includes(keyA)), true);
  assert.equal(pool.snapshot().keys[1]!.statistics.initialBalanceCny, null);
});

test('a request finishing during a scheduled check results in only one follow-up check', async t => {
  const first = deferred<Response>();
  const started = deferred<void>();
  let checks = 0;
  const { pool } = fixture({ fetch: async () => {
    if (++checks === 1) { started.resolve(); return first.promise; }
    return balance('3.00');
  } }, { afterRequestDelayMs: 1, minimumRefreshIntervalMs: 5 });
  t.after(() => pool.stop());
  const { addedIds: [id] } = await pool.importKeys([{ key: keyA }]);
  const pending = pool.scheduleRefresh([id!]);
  await started.promise;
  const later = [pool.scheduleRefresh([id!]), pool.scheduleRefresh([id!]), pool.scheduleRefresh([id!])];
  first.resolve(balance('4.00'));
  await Promise.all([pending, ...later]);
  assert.equal(checks, 2);
  assert.equal(pool.snapshot().keys[0]!.statistics.totalConsumedCny, '1.00');
});

test('scheduled lagging positive balances cannot revive a rejected key, while explicit refresh can', async t => {
  const { pool } = fixture({ fetch: async () => balance('0.50') }, {
    afterRequestDelayMs: 1, minimumRefreshIntervalMs: 1,
  });
  t.after(() => pool.stop());
  const { addedIds: [id] } = await pool.importKeys([{ key: keyA }]);
  await pool.acquire();
  await pool.reportFailure(id!, 402);
  await pool.scheduleRefresh([id!]);
  let entry = pool.snapshot().keys[0]!;
  assert.equal(entry.status, 'exhausted');
  assert.equal(entry.balanceCny, '0.50');
  assert.equal(entry.statistics.totalConsumedCny, '0');
  assert.match(entry.lastError!, /402/);
  await assert.rejects(pool.acquire(), { code: 'NO_AVAILABLE_KEY' });
  await pool.refresh(id);
  entry = pool.snapshot().keys[0]!;
  assert.equal(entry.status, 'ready');
});

test('stop clears queued refreshes and settles their callers without network work', async () => {
  let checks = 0;
  const { pool } = fixture({ fetch: async () => { checks++; return balance(); } }, {
    afterRequestDelayMs: 20, minimumRefreshIntervalMs: 0,
  });
  const { addedIds: [id] } = await pool.importKeys([{ key: keyA }]);
  const pending = pool.scheduleRefresh([id!]);
  await yieldTurn();
  pool.stop();
  await pending;
  await pool.scheduleRefresh([id!]);
  await pause(25);
  assert.equal(checks, 0);
});

test('stop aborts an active scheduled check and settles all coalesced waiters', async () => {
  const started = deferred<void>();
  let aborted = false;
  const { pool } = fixture({ fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
    started.resolve();
    init?.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('stopped')); }, { once: true });
  }) }, { afterRequestDelayMs: 1, minimumRefreshIntervalMs: 0 });
  const { addedIds: [id] } = await pool.importKeys([{ key: keyA }]);
  const first = pool.scheduleRefresh([id!]);
  await started.promise;
  const second = pool.scheduleRefresh([id!]);
  pool.stop();
  await Promise.all([first, second]);
  assert.equal(aborted, true);
  assert.equal(pool.snapshot().keys[0]!.statistics.startedAt, null);
});

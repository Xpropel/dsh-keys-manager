import { randomUUID } from 'node:crypto';
import { parseBalance, type BalanceObservation } from './balance.ts';
import { addDecimals, compareDecimals, isDecimalString, subtractDecimals } from './money.ts';
import type {
  AcquiredKey, ImportKeyInput, ImportKeysResult, KeyMetadata, KeyPoolOptions,
  BalanceObservationSource, KeyStatus, KeyStatistics, PoolEvent, PoolMetadata, PoolSettings, PoolSnapshot, StoredPoolMetadata,
} from './types.ts';

export type PoolErrorCode = 'VALIDATION' | 'NOT_FOUND' | 'NO_AVAILABLE_KEY' |
  'ACTIVE_KEY_UNAVAILABLE' | 'CREDENTIAL_NOT_FOUND' | 'POOL_STOPPED' | 'STORAGE_ERROR';

export class PoolError extends Error {
  constructor(public readonly code: PoolErrorCode, message: string) {
    super(message);
    this.name = 'PoolError';
  }
}

/** Scheduling is separate from wall-clock statistics timestamps and testable without real APIs. */
export interface KeyPoolRefreshTiming {
  baselineTimeoutMs: number;
  afterRequestDelayMs: number;
  minimumRefreshIntervalMs: number;
}

interface RefreshTask {
  id: string;
  credentialRef: string;
  generation: number;
  started: boolean;
}

interface RefreshOptions {
  allowRecovery: boolean;
  priority?: boolean;
  signal?: AbortSignal;
}

interface ScheduledRefresh {
  timer?: ReturnType<typeof setTimeout>;
  busy: boolean;
  pending: Array<() => void>;
  running: Array<() => void>;
}

function withSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

const defaults: PoolSettings = { autoSwitch: true, refreshIntervalSeconds: 300 };
const emptyMetadata = (): PoolMetadata => ({ version: 2, keys: [], activeId: null, settings: { ...defaults } });
const emptyStatistics = (): KeyStatistics => ({
  initialBalanceCny: null, lastObservedCny: null, totalConsumedCny: '0', totalAddedCny: '0',
  startedAt: null, updatedAt: null, lastObservationSource: null,
});
const eligible = (entry: KeyMetadata): boolean => entry.enabled && entry.status !== 'invalid' && entry.status !== 'exhausted';
const clone = <T>(value: T): T => structuredClone(value);
const statuses = new Set<KeyStatus>(['unknown', 'ready', 'exhausted', 'invalid', 'error']);

function validatedSettings(settings: Partial<PoolSettings>, base = defaults): PoolSettings {
  if (!settings || typeof settings !== 'object') throw new PoolError('VALIDATION', '设置格式无效。');
  const result = {
    autoSwitch: settings.autoSwitch === undefined ? base.autoSwitch : settings.autoSwitch,
    refreshIntervalSeconds: settings.refreshIntervalSeconds === undefined ? base.refreshIntervalSeconds : settings.refreshIntervalSeconds,
  };
  if (typeof result.autoSwitch !== 'boolean' || !Number.isInteger(result.refreshIntervalSeconds) ||
      (result.refreshIntervalSeconds !== 0 && (result.refreshIntervalSeconds < 30 || result.refreshIntervalSeconds > 86400))) {
    throw new PoolError('VALIDATION', '刷新间隔必须为 0 或 30–86400 秒。');
  }
  return result;
}

function validateStatistics(value: KeyStatistics): KeyStatistics {
  const invalid = () => new PoolError('STORAGE_ERROR', 'Key 累计统计格式无效。');
  if (!value || typeof value !== 'object' || !isDecimalString(value.totalConsumedCny) || !isDecimalString(value.totalAddedCny) ||
      compareDecimals(value.totalConsumedCny, '0') < 0 || compareDecimals(value.totalAddedCny, '0') < 0) throw invalid();
  if (value.initialBalanceCny === null) {
    if (value.lastObservedCny !== null || value.startedAt !== null || value.updatedAt !== null || value.lastObservationSource !== null ||
        compareDecimals(value.totalConsumedCny, '0') !== 0 || compareDecimals(value.totalAddedCny, '0') !== 0) throw invalid();
  } else {
    if (!isDecimalString(value.initialBalanceCny, 100) || !isDecimalString(value.lastObservedCny, 100) ||
        !Number.isSafeInteger(value.startedAt) || (value.startedAt as number) < 0 ||
        !Number.isSafeInteger(value.updatedAt) || (value.updatedAt as number) < (value.startedAt as number) ||
        (value.lastObservationSource !== 'api' && value.lastObservationSource !== 'unavailable-zero') ||
        (value.lastObservationSource === 'unavailable-zero' && compareDecimals(value.lastObservedCny, '0') !== 0)) throw invalid();
    try {
      const reconstructed = subtractDecimals(addDecimals(value.initialBalanceCny, value.totalAddedCny), value.totalConsumedCny);
      if (compareDecimals(reconstructed, value.lastObservedCny) !== 0) throw invalid();
    } catch { throw invalid(); }
  }
  return {
    initialBalanceCny: value.initialBalanceCny, lastObservedCny: value.lastObservedCny,
    totalConsumedCny: value.totalConsumedCny, totalAddedCny: value.totalAddedCny,
    startedAt: value.startedAt, updatedAt: value.updatedAt, lastObservationSource: value.lastObservationSource,
  };
}

function observeStatistics(current: KeyStatistics, observation: BalanceObservation, checkedAt: number): KeyStatistics {
  const timestamp = Math.max(checkedAt, current.updatedAt ?? 0);
  if (current.lastObservedCny === null) {
    return {
      ...emptyStatistics(), initialBalanceCny: observation.balanceCny, lastObservedCny: observation.balanceCny,
      startedAt: timestamp, updatedAt: timestamp, lastObservationSource: observation.source,
    };
  }
  const movement = compareDecimals(current.lastObservedCny, observation.balanceCny);
  return {
    ...current,
    totalConsumedCny: movement > 0 ? addDecimals(current.totalConsumedCny, subtractDecimals(current.lastObservedCny, observation.balanceCny)) : current.totalConsumedCny,
    totalAddedCny: movement < 0 ? addDecimals(current.totalAddedCny, subtractDecimals(observation.balanceCny, current.lastObservedCny)) : current.totalAddedCny,
    lastObservedCny: observation.balanceCny, updatedAt: timestamp, lastObservationSource: observation.source,
  };
}

function validateMetadata(value: StoredPoolMetadata): PoolMetadata {
  if (!value || (value.version !== 1 && value.version !== 2) || !Array.isArray(value.keys)) {
    throw new PoolError('STORAGE_ERROR', 'Key 配置格式无效。');
  }
  const ids = new Set<string>();
  const refs = new Set<string>();
  const keys = value.keys.map((entry) => {
    if (!entry || typeof entry.id !== 'string' || !entry.id || ids.has(entry.id) ||
        typeof entry.credentialRef !== 'string' || !entry.credentialRef || refs.has(entry.credentialRef) ||
        typeof entry.label !== 'string' || typeof entry.maskedKey !== 'string' ||
        typeof entry.enabled !== 'boolean' || !statuses.has(entry.status) ||
        !(entry.balanceCny === null || isDecimalString(entry.balanceCny, 100)) ||
        !(entry.lastCheckedAt === null || (typeof entry.lastCheckedAt === 'number' && Number.isFinite(entry.lastCheckedAt))) ||
        !(entry.lastError === null || typeof entry.lastError === 'string')) {
      throw new PoolError('STORAGE_ERROR', 'Key 配置格式无效。');
    }
    ids.add(entry.id);
    refs.add(entry.credentialRef);
    const current = entry as KeyMetadata;
    const balanceObservationSource = value.version === 1
      ? entry.balanceCny !== null ? 'api' : null
      : current.balanceObservationSource;
    // Older lastCheckedAt could have been a failed check, so it cannot establish amount freshness.
    const balanceObservedAt = value.version === 1 ? null : current.balanceObservedAt;
    if ((balanceObservationSource !== null && balanceObservationSource !== 'api' && balanceObservationSource !== 'unavailable-zero') ||
        !(balanceObservedAt === null || (Number.isSafeInteger(balanceObservedAt) && balanceObservedAt >= 0)) ||
        (balanceObservationSource === 'api' && entry.balanceCny === null) ||
        (balanceObservationSource !== 'api' && entry.balanceCny !== null) ||
        (balanceObservationSource === null && balanceObservedAt !== null) ||
        (balanceObservationSource === 'unavailable-zero' && balanceObservedAt === null)) {
      throw new PoolError('STORAGE_ERROR', 'Key 余额观察记录格式无效。');
    }
    // Explicitly select known fields so unexpected properties never reach snapshots.
    return {
      id: entry.id, credentialRef: entry.credentialRef, label: entry.label,
      maskedKey: entry.maskedKey, enabled: entry.enabled, status: entry.status,
      balanceCny: entry.balanceCny, lastCheckedAt: entry.lastCheckedAt, lastError: entry.lastError,
      balanceObservationSource, balanceObservedAt,
      statistics: value.version === 1 ? emptyStatistics() : validateStatistics((entry as KeyMetadata).statistics),
    };
  });
  return {
    version: 2, keys,
    activeId: typeof value.activeId === 'string' && ids.has(value.activeId) ? value.activeId : null,
    settings: validatedSettings(value.settings),
  };
}

/** Account membership is intentionally not inferred from keys or equal balances. */
export class KeyPool {
  private state: PoolMetadata = emptyMetadata();
  private initialization?: Promise<void>;
  private mutations: Promise<unknown> = Promise.resolve();
  private readonly generations = new Map<string, number>();
  private readonly controllers = new Set<AbortController>();
  private events: PoolEvent[] = [];
  private readonly fetcher: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly refreshTiming: KeyPoolRefreshTiming;
  private readonly baselineChecks = new Map<string, Promise<void>>();
  private readonly baselineAttemptAt = new Map<string, number>();
  private readonly refreshAttemptAt = new Map<string, number>();
  private readonly refreshTasks = new Map<string, { task: RefreshTask; promise: Promise<void> }>();
  private readonly scheduledRefreshes = new Map<string, ScheduledRefresh>();
  private timer?: ReturnType<typeof setInterval>;
  private backgroundRefreshRunning = false;
  private stopped = false;
  private refreshRunning = 0;
  private refreshWaiters: Array<() => void> = [];

  constructor(private readonly options: KeyPoolOptions, timing: Partial<KeyPoolRefreshTiming> = {}) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.refreshTimeoutMs ?? 12000;
    this.refreshTiming = { baselineTimeoutMs: 3000, afterRequestDelayMs: 1000, minimumRefreshIntervalMs: 5000, ...timing };
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new PoolError('VALIDATION', '余额查询超时必须为正数。');
    }
    if (!Number.isFinite(this.refreshTiming.baselineTimeoutMs) || this.refreshTiming.baselineTimeoutMs <= 0 ||
        !Number.isFinite(this.refreshTiming.afterRequestDelayMs) || this.refreshTiming.afterRequestDelayMs < 0 ||
        !Number.isFinite(this.refreshTiming.minimumRefreshIntervalMs) || this.refreshTiming.minimumRefreshIntervalMs < 0) {
      throw new PoolError('VALIDATION', '余额刷新时间配置无效。');
    }
  }

  init(): Promise<void> {
    this.assertRunning();
    this.initialization ??= (async () => {
      let stored: StoredPoolMetadata | undefined;
      try { stored = await this.options.metadata.load(); }
      catch { throw new PoolError('STORAGE_ERROR', '无法读取 Key 配置。'); }
      this.assertRunning();
      const next = stored === undefined ? emptyMetadata() : validateMetadata(stored);
      if (stored?.version === 1) {
        try { await this.options.metadata.save(clone(next)); }
        catch { throw new PoolError('STORAGE_ERROR', '无法升级 Key 累计统计配置。'); }
      }
      this.state = next;
      for (const entry of this.state.keys) this.generations.set(entry.id, 0);
      this.configureTimer();
    })();
    return this.initialization;
  }

  snapshot(): PoolSnapshot {
    const { keys, activeId, settings } = this.state;
    return {
      keys: keys.map(({ credentialRef: _ref, ...entry }) => ({ ...entry, statistics: { ...entry.statistics } })),
      activeId, settings: { ...settings }, events: this.events.map((event) => ({ ...event })),
    };
  }

  async importKeys(inputs: ImportKeyInput[]): Promise<ImportKeysResult> {
    await this.init();
    if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 200) {
      throw new PoolError('VALIDATION', '每批请导入 1–200 个 Key。');
    }
    const normalized = inputs.map((input) => {
      if (!input || typeof input.key !== 'string') throw new PoolError('VALIDATION', 'Key 必须是字符串。');
      const key = input.key.trim();
      if (!key || /\s/u.test(key) || key.length > 4096) throw new PoolError('VALIDATION', 'Key 不能为空或包含空格、换行。');
      if (input.label !== undefined && typeof input.label !== 'string') throw new PoolError('VALIDATION', '名称必须是字符串。');
      const label = input.label?.trim();
      if (label && (label.length > 100 || /[\r\n]/.test(label))) throw new PoolError('VALIDATION', '名称限 100 个字符且不能换行。');
      if (label?.includes(key)) throw new PoolError('VALIDATION', '名称不能包含完整 Key。');
      return { key, label };
    });
    return this.serial(async () => {
      const known = new Set<string>();
      for (const entry of this.state.keys) {
        try {
          const key = await this.options.credentials.resolve(entry.credentialRef);
          if (key) known.add(key);
        } catch { throw new PoolError('STORAGE_ERROR', '无法读取已有 Key 凭据。'); }
      }
      const allSecrets = new Set([...known, ...normalized.map((input) => input.key)]);
      if (normalized.some((input) => input.label && [...allSecrets].some((secret) => input.label!.includes(secret)))) {
        throw new PoolError('VALIDATION', '名称不能包含完整 Key。');
      }
      const next = clone(this.state);
      const added: KeyMetadata[] = [];
      let duplicateCount = 0;
      try {
        for (const input of normalized) {
          if (known.has(input.key)) { duplicateCount++; continue; }
          known.add(input.key);
          const id = randomUUID();
          const entry: KeyMetadata = {
            id, credentialRef: `DSH_KEY_POOL_${id.replaceAll('-', '_').toUpperCase()}`,
            label: input.label || `Key ${next.keys.length + 1}`,
            maskedKey: input.key.length > 8 ? `${input.key.slice(0, 3)}••••${input.key.slice(-4)}` : '••••••••',
            enabled: true, status: 'unknown', balanceCny: null, lastCheckedAt: null, lastError: null,
            balanceObservationSource: null, balanceObservedAt: null,
            statistics: emptyStatistics(),
          };
          added.push(entry);
          await this.options.credentials.set(entry.credentialRef, input.key);
          next.keys.push(entry);
        }
        if (!next.activeId) next.activeId = next.keys.find(eligible)?.id ?? null;
        if (added.length) await this.commit(next);
      } catch {
        // Remove only the credentials created by this attempt, keeping existing keys intact.
        await Promise.allSettled(added.map((entry) => this.options.credentials.unset(entry.credentialRef)));
        throw new PoolError('STORAGE_ERROR', '保存 Key 失败，未导入本批配置。');
      }
      for (const entry of added) this.generations.set(entry.id, 0);
      return { addedIds: added.map((entry) => entry.id), duplicateCount };
    });
  }

  async remove(id: string): Promise<void> {
    await this.init();
    return this.serial(async () => {
      const entry = this.find(id);
      const next = clone(this.state);
      next.keys = next.keys.filter((candidate) => candidate.id !== id);
      if (next.activeId === id) next.activeId = next.keys.find(eligible)?.id ?? null;
      // Commit removal first, so credential deletion errors cannot leave a selectable dead key.
      await this.commit(next);
      this.bump(id);
      try { await this.options.credentials.unset(entry.credentialRef); }
      catch { throw new PoolError('STORAGE_ERROR', 'Key 已从列表移除，但凭据清理失败。'); }
    });
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.init();
    if (typeof enabled !== 'boolean') throw new PoolError('VALIDATION', 'enabled 必须是布尔值。');
    return this.serial(async () => {
      this.find(id);
      const next = clone(this.state);
      next.keys.find((entry) => entry.id === id)!.enabled = enabled;
      this.selectFallback(next);
      await this.commit(next);
      this.bump(id);
    });
  }

  async setActive(id: string): Promise<void> {
    await this.init();
    return this.serial(async () => {
      if (!eligible(this.find(id))) throw new PoolError('ACTIVE_KEY_UNAVAILABLE', '该 Key 当前不可用，请先启用或刷新余额。');
      const next = clone(this.state);
      next.activeId = id;
      await this.commit(next);
    });
  }

  async reorder(ids: string[]): Promise<void> {
    await this.init();
    return this.serial(async () => {
      if (!Array.isArray(ids) || ids.length !== this.state.keys.length || new Set(ids).size !== ids.length ||
          ids.some((id) => !this.state.keys.some((entry) => entry.id === id))) {
        throw new PoolError('VALIDATION', '排序必须恰好包含全部 Key。');
      }
      const next = clone(this.state);
      const byId = new Map(next.keys.map((entry) => [entry.id, entry]));
      next.keys = ids.map((id) => byId.get(id)!);
      await this.commit(next);
    });
  }

  async updateSettings(settings: Partial<PoolSettings>): Promise<void> {
    await this.init();
    return this.serial(async () => {
      const next = clone(this.state);
      next.settings = validatedSettings(settings, next.settings);
      this.selectFallback(next);
      await this.commit(next);
      this.configureTimer();
    });
  }

  async acquire(signal?: AbortSignal, options: { observeBalance?: boolean } = {}): Promise<AcquiredKey> {
    await this.init();
    const rejected = new Set<string>();
    const limit = Math.max(1, this.state.keys.length);
    for (let attempt = 0; attempt < limit; attempt++) {
      signal?.throwIfAborted();
      const lease = await this.acquireCandidate(rejected);
      if (options.observeBalance !== false) await withSignal(this.ensureBaseline(lease.id), signal);
      signal?.throwIfAborted();
      const usable = await this.serial(async () => {
        const entry = this.state.keys.find(candidate => candidate.id === lease.id);
        return !!entry && eligible(entry);
      });
      if (usable) return lease;
      rejected.add(lease.id);
    }
    throw new PoolError('NO_AVAILABLE_KEY', '没有可用的 DeepSeek Key，请导入、启用或刷新 Key。');
  }

  private acquireCandidate(rejected: ReadonlySet<string>): Promise<AcquiredKey> {
    return this.serial(async () => {
      const next = clone(this.state);
      let missingCredential = false;
      const active = next.keys.find((entry) => entry.id === next.activeId);
      const candidates = next.settings.autoSwitch
        ? [active, ...next.keys.filter((entry) => entry.id !== next.activeId)].filter((entry): entry is KeyMetadata => !!entry && eligible(entry) && !rejected.has(entry.id))
        : active && eligible(active) && !rejected.has(active.id) ? [active] : [];
      for (const entry of candidates) {
        let key: string | undefined;
        try { key = await this.options.credentials.resolve(entry.credentialRef); }
        catch { throw new PoolError('STORAGE_ERROR', '无法读取 Key 凭据。'); }
        if (!key || /\s/u.test(key)) {
          missingCredential = true;
          entry.status = 'invalid';
          entry.lastError = '本地凭据不存在，请重新导入。';
          this.bump(entry.id);
          continue;
        }
        if (next.activeId !== entry.id || missingCredential) {
          next.activeId = entry.id;
          await this.commit(next);
        }
        return { id: entry.id, key };
      }
      if (missingCredential) await this.commit(next);
      if (!next.settings.autoSwitch && next.activeId) {
        throw new PoolError('ACTIVE_KEY_UNAVAILABLE', '当前 Key 不可用，自动切换已关闭。');
      }
      throw new PoolError('NO_AVAILABLE_KEY', '没有可用的 DeepSeek Key，请导入、启用或刷新 Key。');
    });
  }

  async reportFailure(id: string, status: number): Promise<void> {
    await this.init();
    if (status !== 401 && status !== 402) return;
    return this.serial(async () => {
      const current = this.state.keys.find((entry) => entry.id === id);
      if (!current) return; // An in-flight request may finish after the user removes its key.
      const next = clone(this.state);
      const entry = next.keys.find((candidate) => candidate.id === id)!;
      entry.status = status === 401 ? 'invalid' : 'exhausted';
      entry.lastError = status === 401 ? '认证失败（401）。' : '账户余额不足（402）。';
      this.selectFallback(next);
      await this.commit(next);
      this.bump(id);
    });
  }

  markExhausted(id: string): Promise<void> { return this.reportFailure(id, 402); }

  async refresh(id?: string): Promise<void> {
    await this.init();
    return this.refreshIds(id === undefined ? undefined : [id], { allowRecovery: true });
  }

  /**
   * Best-effort targeted checks after imports or requests. Calls for the same key
   * coalesce; a request ending during a check schedules one bounded follow-up.
   * These checks never revive rejected keys from a potentially lagging balance response.
   */
  scheduleRefresh(ids: readonly string[]): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return this.init().then(async () => {
      if (this.stopped) return;
      const pending = [...new Set(ids)].filter(id => this.state.keys.some(entry => entry.id === id)).map(id => {
        let job = this.scheduledRefreshes.get(id);
        if (!job) {
          job = { busy: false, pending: [], running: [] };
          this.scheduledRefreshes.set(id, job);
        }
        const completion = new Promise<void>(resolve => job!.pending.push(resolve));
        if (!job.timer && !job.busy) this.armRefresh(id, job, this.refreshTiming.afterRequestDelayMs);
        return completion;
      });
      await Promise.all(pending);
    }).catch(() => undefined);
  }

  private async refreshIds(ids: readonly string[] | undefined, options: RefreshOptions): Promise<void> {
    const tasks = await this.serial(async () => {
      if (options.signal?.aborted) return [];
      if (ids !== undefined) for (const id of ids) this.find(id);
      return this.state.keys.filter((entry) => ids === undefined || ids.includes(entry.id)).map((entry) => ({
        id: entry.id, credentialRef: entry.credentialRef, generation: this.bump(entry.id), started: false,
      }));
    });
    await Promise.all(tasks.map(task => {
      const running = this.withRefreshSlot(async () => {
        task.started = true;
        await this.refreshOne(task, options);
      }, options.priority);
      const tracked = { task, promise: running };
      this.refreshTasks.set(task.id, tracked);
      return running.finally(() => {
        if (this.refreshTasks.get(task.id) === tracked) this.refreshTasks.delete(task.id);
      });
    }));
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const job of this.scheduledRefreshes.values()) {
      if (job.timer) clearTimeout(job.timer);
      for (const complete of [...job.pending, ...job.running]) complete();
    }
    this.scheduledRefreshes.clear();
    for (const controller of this.controllers) controller.abort();
  }

  private async refreshOne(task: RefreshTask, options: RefreshOptions): Promise<void> {
    if (this.stopped || options.signal?.aborted || this.generations.get(task.id) !== task.generation) return;
    this.refreshAttemptAt.set(task.id, performance.now());
    const controller = new AbortController();
    this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let update: {
      status: KeyStatus; lastError: string | null; balanceCny?: string | null;
      balanceObservationSource?: BalanceObservationSource | null;
    };
    let observation: BalanceObservation | null = null;
    try {
      const key = await this.options.credentials.resolve(task.credentialRef);
      if (!key || /\s/u.test(key)) {
        update = { status: 'invalid', lastError: '本地凭据不存在，请重新导入。' };
      } else {
        const response = await this.fetcher('https://api.deepseek.com/user/balance', {
          method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${key}` },
          signal: options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal,
        });
        if (response.status === 401) update = { status: 'invalid', lastError: '认证失败（401）。' };
        else if (response.status === 402) update = { status: 'exhausted', lastError: '账户余额不足（402）。' };
        else if (!response.ok) update = { status: 'error', lastError: `余额查询失败（HTTP ${response.status}）。` };
        else {
          const parsed = parseBalance(await response.json());
          observation = parsed.statisticsObservation;
          update = {
            status: parsed.available ? 'ready' : 'exhausted', balanceCny: parsed.balanceCny,
            balanceObservationSource: parsed.statisticsObservation?.source ?? null,
            lastError: parsed.available ? null : '账户当前余额不可用于 API 调用。',
          };
        }
        if (!response.ok) {
          // Release the connection without reading or retaining a potentially sensitive error body.
          await response.body?.cancel().catch(() => undefined);
        }
      }
    } catch {
      // Do not expose exception text or upstream response bodies; they may contain secrets.
      update = { status: 'error', lastError: controller.signal.aborted || options.signal?.aborted ? '余额查询超时。' : '余额查询失败，请稍后重试。' };
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(controller);
    }
    if (this.stopped) return;
    await this.serial(async () => {
      if (this.generations.get(task.id) !== task.generation || !this.state.keys.some((entry) => entry.id === task.id)) return;
      const next = clone(this.state);
      const entry = next.keys.find((candidate) => candidate.id === task.id)!;
      // A failed check is not evidence that a previously rejected credential recovered.
      if ((update.status === 'error' || !options.allowRecovery && update.status === 'ready') &&
          (entry.status === 'exhausted' || entry.status === 'invalid')) {
        update = { ...update, status: entry.status };
        if (update.lastError === null) update.lastError = entry.lastError;
      }
      const checkedAt = this.now();
      Object.assign(entry, update, { lastCheckedAt: checkedAt });
      if (update.balanceObservationSource !== undefined) entry.balanceObservedAt = observation !== null ? checkedAt : null;
      if (observation !== null) entry.statistics = observeStatistics(entry.statistics, observation, checkedAt);
      this.selectFallback(next);
      await this.commit(next);
    });
  }

  private async withRefreshSlot(work: () => Promise<void>, priority = false): Promise<void> {
    if (this.refreshRunning >= 3) await new Promise<void>((resolve) => {
      if (priority) this.refreshWaiters.unshift(resolve);
      else this.refreshWaiters.push(resolve);
    });
    else this.refreshRunning++;
    try { await work(); }
    finally {
      const next = this.refreshWaiters.shift();
      if (next) next();
      else this.refreshRunning--;
    }
  }

  /** First-use observation is shared and bounded even when the global refresh queue is busy. */
  private ensureBaseline(id: string): Promise<void> {
    const entry = this.state.keys.find(candidate => candidate.id === id);
    if (!entry || entry.statistics.startedAt !== null || this.stopped) return Promise.resolve();
    const shared = this.baselineChecks.get(id);
    if (shared) return shared;
    const now = performance.now();
    const previous = this.baselineAttemptAt.get(id);
    if (previous !== undefined && now - previous < this.refreshTiming.minimumRefreshIntervalMs) return Promise.resolve();
    this.baselineAttemptAt.set(id, now);
    const controller = new AbortController();
    this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), this.refreshTiming.baselineTimeoutMs);
    const current = this.refreshTasks.get(id);
    const query = current?.task.started ? current.promise : this.refreshIds([id], {
      allowRecovery: false, priority: true, signal: controller.signal,
    });
    const completion = withSignal(query, controller.signal).catch(() => undefined).finally(() => {
      clearTimeout(timeout);
      this.controllers.delete(controller);
      if (this.baselineChecks.get(id) === completion) this.baselineChecks.delete(id);
    });
    this.baselineChecks.set(id, completion);
    return completion;
  }

  private armRefresh(id: string, job: ScheduledRefresh, minimumDelay: number): void {
    if (this.stopped || this.scheduledRefreshes.get(id) !== job) return;
    const elapsed = performance.now() - (this.refreshAttemptAt.get(id) ?? -Infinity);
    const delay = Math.max(minimumDelay, this.refreshTiming.minimumRefreshIntervalMs - elapsed);
    job.timer = setTimeout(() => {
      job.timer = undefined;
      void this.runScheduledRefresh(id, job);
    }, delay);
  }

  private async runScheduledRefresh(id: string, job: ScheduledRefresh): Promise<void> {
    if (this.stopped || this.scheduledRefreshes.get(id) !== job) return;
    job.busy = true;
    const inFlight = this.refreshTasks.get(id);
    if (inFlight?.task.started) {
      await inFlight.promise.catch(() => undefined);
      job.busy = false;
      this.armRefresh(id, job, 0);
      return;
    }
    const elapsed = performance.now() - (this.refreshAttemptAt.get(id) ?? -Infinity);
    if (elapsed < this.refreshTiming.minimumRefreshIntervalMs) {
      job.busy = false;
      this.armRefresh(id, job, 0);
      return;
    }
    job.running = job.pending.splice(0);
    try {
      if (this.state.keys.some(entry => entry.id === id)) await this.refreshIds([id], { allowRecovery: false, priority: true });
    } catch { /* A background balance check must never replace a model response or rejection. */ }
    finally {
      for (const complete of job.running) complete();
      job.running = [];
      job.busy = false;
      if (this.stopped || this.scheduledRefreshes.get(id) !== job) return;
      if (job.pending.length) this.armRefresh(id, job, this.refreshTiming.afterRequestDelayMs);
      else this.scheduledRefreshes.delete(id);
    }
  }

  private selectFallback(state: PoolMetadata): void {
    if (!state.settings.autoSwitch) return;
    if (!state.keys.some((entry) => entry.id === state.activeId && eligible(entry))) {
      state.activeId = state.keys.find(eligible)?.id ?? null;
    }
  }

  private find(id: string): KeyMetadata {
    const entry = this.state.keys.find((candidate) => candidate.id === id);
    if (!entry) throw new PoolError('NOT_FOUND', '找不到该 Key。');
    return entry;
  }

  private bump(id: string): number {
    const generation = (this.generations.get(id) ?? 0) + 1;
    this.generations.set(id, generation);
    return generation;
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.mutations.then(async () => { this.assertRunning(); return work(); });
    this.mutations = pending.catch(() => undefined);
    return pending;
  }

  private async commit(next: PoolMetadata): Promise<void> {
    this.assertRunning();
    try { await this.options.metadata.save(clone(next)); }
    catch { throw new PoolError('STORAGE_ERROR', '无法保存 Key 配置。'); }
    for (const entry of next.keys) {
      const previous = this.state.keys.find((candidate) => candidate.id === entry.id);
      if (!previous || previous.status === entry.status) continue;
      if (entry.status === 'invalid') this.record('invalid', `${entry.label}：${entry.lastError ?? '凭据不可用。'}`);
      else if (entry.status === 'exhausted') this.record('exhausted', `${entry.label}：${entry.lastError ?? '余额不足。'}`);
      else if (entry.status === 'ready' && (previous.status === 'invalid' || previous.status === 'exhausted')) {
        this.record('recovered', `${entry.label}：已恢复可用。`);
      }
    }
    if (next.activeId !== this.state.activeId) {
      const from = this.state.keys.find((entry) => entry.id === this.state.activeId)?.label ?? '无';
      const to = next.keys.find((entry) => entry.id === next.activeId)?.label ?? '无';
      this.record('switch', `当前 Key：${from} → ${to}`);
    }
    this.state = next;
  }

  private record(kind: PoolEvent['kind'], message: string): void {
    this.events.push({ id: randomUUID(), at: this.now(), kind, message });
    this.events = this.events.slice(-50);
  }

  private assertRunning(): void {
    if (this.stopped) throw new PoolError('POOL_STOPPED', 'Key 管理器已停止。');
  }

  private configureTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.stopped || this.state.settings.refreshIntervalSeconds === 0) return;
    this.timer = setInterval(() => {
      if (this.backgroundRefreshRunning) return;
      this.backgroundRefreshRunning = true;
      void this.refresh().catch(() => undefined).finally(() => { this.backgroundRefreshRunning = false; });
    }, this.state.settings.refreshIntervalSeconds * 1000);
    this.timer.unref?.();
  }
}

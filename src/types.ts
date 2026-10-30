/** The secret itself is only written to the host credential store. */
export interface CredentialStore {
  resolve(ref: string): Promise<string | undefined>;
  set(ref: string, value: string): Promise<void>;
  unset(ref: string): Promise<void>;
}

export type KeyStatus = 'unknown' | 'ready' | 'exhausted' | 'invalid' | 'error';

export type BalanceObservationSource = 'api' | 'unavailable-zero';

/** Cumulative changes observed since the first successful CNY observation. */
export interface KeyStatistics {
  initialBalanceCny: string | null;
  lastObservedCny: string | null;
  totalConsumedCny: string;
  totalAddedCny: string;
  startedAt: number | null;
  updatedAt: number | null;
  lastObservationSource: BalanceObservationSource | null;
}

export interface KeySnapshot {
  id: string;
  label: string;
  maskedKey: string;
  enabled: boolean;
  status: KeyStatus;
  /** Exact CNY decimal string from the API; null when unavailable. */
  balanceCny: string | null;
  /** Evidence behind the most recent successful CNY balance observation. */
  balanceObservationSource: BalanceObservationSource | null;
  /** Amount observation time; a failed refresh never advances this timestamp. */
  balanceObservedAt: number | null;
  /** Most recent balance-check attempt, including failed attempts. */
  lastCheckedAt: number | null;
  lastError: string | null;
  statistics: KeyStatistics;
}

export interface KeyMetadata extends KeySnapshot {
  credentialRef: string;
}

export interface PoolSettings {
  autoSwitch: boolean;
  /** 0 disables background refresh; otherwise 30–86400 seconds. */
  refreshIntervalSeconds: number;
}

export interface PoolMetadata {
  version: 2;
  keys: KeyMetadata[];
  activeId: string | null;
  settings: PoolSettings;
}

/** Prior persisted format: cached balances are not historical statistics. */
export interface LegacyPoolMetadata {
  version: 1;
  keys: Array<Omit<KeyMetadata, 'statistics' | 'balanceObservationSource' | 'balanceObservedAt'>>;
  activeId: string | null;
  settings: PoolSettings;
}

export type StoredPoolMetadata = PoolMetadata | LegacyPoolMetadata;

export interface PoolSnapshot {
  keys: KeySnapshot[];
  activeId: string | null;
  settings: PoolSettings;
  /** Most recent 50 status events from this process; never persisted. */
  events: PoolEvent[];
}

export interface PoolEvent {
  id: string;
  at: number;
  kind: 'switch' | 'exhausted' | 'invalid' | 'recovered';
  message: string;
}

export interface MetadataStore {
  load(): Promise<StoredPoolMetadata | undefined>;
  save(meta: PoolMetadata): Promise<void>;
}

export interface ImportKeyInput {
  label?: string;
  key: string;
}

export interface ImportKeysResult {
  addedIds: string[];
  duplicateCount: number;
}

export interface AcquiredKey {
  id: string;
  key: string;
}

export interface KeyPoolOptions {
  credentials: CredentialStore;
  metadata: MetadataStore;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  refreshTimeoutMs?: number;
}

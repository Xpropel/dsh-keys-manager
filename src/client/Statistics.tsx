import type { KeyView } from './types.ts'
import type { Translate } from './locales.ts'
import { displayBalance, timeLabel } from './format.ts'
import { summarizePoolBalance, summarizePoolConsumption } from '../pool-summary.ts'

/** A zero derived from a successful empty/unavailable response stays visibly distinct. */
export function balancePresentation(entry: KeyView): { amount: string | null; derivedZero: boolean } {
  if (entry.balanceCny !== null) return { amount: entry.balanceCny, derivedZero: false }
  if (entry.balanceObservationSource === 'unavailable-zero') {
    return { amount: '0.00', derivedZero: true }
  }
  return { amount: null, derivedZero: false }
}

function Money({ value, prominent = false }: { value: string | null; prominent?: boolean }) {
  return <div className={`dskp-amount${prominent ? ' dskp-metric-amount' : ''}`}>{value === null ? '—' : <><span className="dskp-currency-symbol">¥ </span>{displayBalance(value)}</>}</div>
}

/** Pool-wide balance is a transparent sum of confirmed usable query snapshots. */
export function PoolBalanceCard({ keys, t }: { keys: readonly KeyView[]; t: Translate }) {
  const summary = summarizePoolBalance(keys)
  const displayedTotal = summary.includedCount === 0 && summary.totalCny === '0' ? '0.00' : summary.totalCny
  return <section className="dskp-pool-summary" aria-label={t('poolBalanceTitle')}>
    <div className="dskp-pool-heading"><h3>{t('poolBalanceTitle')}</h3><span className="dskp-pool-currency">{t('currencyCny')}</span></div>
    <div className="dskp-pool-total-row"><Money value={displayedTotal} prominent/><span className="dskp-pool-coverage">{t('poolBalanceCoverage', { included: summary.includedCount, enabled: summary.enabledCount })}</span></div>
    {summary.missingCount > 0 && <div className="dskp-pool-incomplete"><strong>{t(summary.totalCny === null ? 'poolBalanceUnknown' : 'poolBalancePartial')}</strong><span>{t('poolBalanceMissing', { count: summary.missingCount })}</span></div>}
    <p className="dskp-pool-snapshot">{summary.oldestObservedAt !== null ? t('poolBalanceOldest', { time: timeLabel(summary.oldestObservedAt) })
      : summary.enabledCount === 0 ? t('poolBalanceNoEnabled')
        : summary.missingCount === 0 ? t('poolBalanceNoneAvailable') : null}</p>
    <p className="dskp-pool-rule">{t('poolBalanceRule')}</p>
  </section>
}

/** Historical consumption remains visible above the key list, even after the active key changes. */
export function PoolConsumptionCard({ keys, t }: { keys: readonly KeyView[]; t: Translate }) {
  const summary = summarizePoolConsumption(keys)
  const displayedTotal = summary.totalCny === '0' ? '0.00' : summary.totalCny
  return <section className="dskp-pool-summary dskp-pool-consumption" aria-label={t('poolConsumptionTitle')}>
    <div className="dskp-pool-heading"><h3>{t('poolConsumptionTitle')}</h3><span className="dskp-pool-currency">{t('currencyCny')}</span></div>
    <div className="dskp-pool-total-row"><Money value={displayedTotal} prominent/><span className="dskp-pool-coverage">{t('poolConsumptionCoverage', { tracked: summary.trackedCount, total: summary.totalCount })}</span></div>
    {summary.totalCny === null ? <div className="dskp-pool-incomplete"><strong>{t('poolConsumptionPending')}</strong></div>
      : summary.missingCount > 0 && <div className="dskp-pool-incomplete"><strong>{t('poolConsumptionPartial')}</strong></div>}
    {summary.missingCount > 0 && <p className="dskp-pool-missing">{t('poolConsumptionMissing', { count: summary.missingCount })}</p>}
    {summary.trackedCount > 0 && <p className="dskp-pool-snapshot">{summary.oldestUpdatedAt === null ? t('poolConsumptionSnapshot') : t('poolConsumptionOldest', { time: timeLabel(summary.oldestUpdatedAt) })}</p>}
    <p className="dskp-pool-rule">{t('poolConsumptionRule')}</p>
    <p className="dskp-pool-method">{t('poolConsumptionMethod')}</p>
  </section>
}

/** Exact remaining amount plus the source-specific caption visible to the user. */
export function BalanceValue({ entry, t, prominent = false }: { entry: KeyView; t: Translate; prominent?: boolean }) {
  const balance = balancePresentation(entry)
  const updated = entry.balanceObservedAt
  return <>
    <Money value={balance.amount} prominent={prominent}/>
    {balance.derivedZero && <div className="dskp-balance-source">{t('unavailableZero')}</div>}
    {balance.amount === null ? <div className="dskp-time">{t('noCnyBalance')}</div>
      : <div className="dskp-time">{updated === null ? t('savedBalance') : t('checkedAt', { time: timeLabel(updated) })}</div>}
  </>
}

/** The starting observation and accumulated increases never pretend to be a past bill. */
export function StatisticsDetails({ entry, t }: { entry: KeyView; t: Translate }) {
  const stats = entry.statistics
  const started = stats.startedAt !== null
  return <details className="dskp-statistics-details">
    <summary>{t('statisticsDetails')}</summary>
    {started ? <dl>
      <div><dt>{t('firstBalance')}</dt><dd>{stats.initialBalanceCny === null ? '—' : `¥ ${displayBalance(stats.initialBalanceCny)}`}</dd></div>
      <div><dt>{t('totalAdded')}</dt><dd>¥ {displayBalance(stats.totalAddedCny)}</dd></div>
      <div><dt>{t('statisticsStartedAt')}</dt><dd>{timeLabel(stats.startedAt!)}</dd></div>
      <div><dt>{t('statisticsUpdatedAt')}</dt><dd>{stats.updatedAt === null ? '—' : timeLabel(stats.updatedAt)}</dd></div>
    </dl> : <p>{t('initialQueryHint')}</p>}
  </details>
}

/** A pending first observation renders an em dash, not fabricated zero consumption. */
export function ConsumptionValue({ entry, t, prominent = false, details = false }: { entry: KeyView; t: Translate; prominent?: boolean; details?: boolean }) {
  const stats = entry.statistics
  const started = stats.startedAt !== null
  return <>
    <Money value={started ? stats.totalConsumedCny : null} prominent={prominent}/>
    <div className="dskp-time">{!started || stats.updatedAt === null ? t('statisticsPending') : t('statisticsCutoff', { time: timeLabel(stats.updatedAt) })}</div>
    {details && <StatisticsDetails entry={entry} t={t}/>}
  </>
}

/** Prominent summary is scoped to the current key; it never sums the whole pool. */
export function ActiveKeySummary({ entry, t }: { entry: KeyView | undefined; t: Translate }) {
  return <div className="dskp-active-summary">
    <div className="dskp-active-heading">
      <div><span className="dskp-stat-label">{t('activeKey')}</span><div className="dskp-active-name">{entry?.label || t('none')}</div>{entry && <div className="dskp-key-id">{entry.maskedKey}</div>}</div>
      {entry && <span className={`dskp-status ${entry.enabled ? entry.status : ''}`} title={entry.lastCheckedAt === null ? undefined : t('lastCheckAttempt', { time: timeLabel(entry.lastCheckedAt) })}>{t(entry.enabled ? entry.status : 'disabled')}</span>}
    </div>
    <div className="dskp-current-metrics">
      <div className="dskp-current-metric"><div className="dskp-metric-label">{t('currentBalance')}<span>{t('currencyCny')}</span></div>{entry ? <BalanceValue entry={entry} t={t} prominent/> : <Money value={null} prominent/>}</div>
      <div className="dskp-current-metric"><div className="dskp-metric-label">{t('consumed')}<span>{t('currencyCny')}</span></div>{entry ? <ConsumptionValue entry={entry} t={t} prominent/> : <Money value={null} prominent/>}</div>
    </div>
    {entry ? <div className="dskp-active-detail"><StatisticsDetails entry={entry} t={t}/>{entry.lastError && <p className="dskp-active-error">{entry.lastError}</p>}</div> : <p className="dskp-active-empty">{t('noActiveHint')}</p>}
  </div>
}

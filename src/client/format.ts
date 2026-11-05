/** Preserve the API's decimal string rather than converting money to a JS number. */
export function displayBalance(value: string): string {
  return value.replace(/^(-?\d+)(\.\d+)?$/, (_match, integer: string, fraction: string | undefined) => `${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction ?? ''}`)
}

/**
 * Timestamp copy follows the application locale, and always carries the year so
 * snapshots from a long-running pool stay unambiguous.
 */
export function timeLabel(value: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(value)
}

export function dateLabel(value: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(value)
}

export function clockLabel(value: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(value)
}

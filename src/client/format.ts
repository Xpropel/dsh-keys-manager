/** Preserve the API's decimal string rather than converting money to a JS number. */
export function displayBalance(value: string): string {
  return value.replace(/^(-?\d+)(\.\d+)?$/, (_match, integer: string, fraction: string | undefined) => `${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction ?? ''}`)
}

export function timeLabel(value: number): string {
  return new Intl.DateTimeFormat(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(value)
}

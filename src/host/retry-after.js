/**
 * Parse HTTP Retry-After hints without relying on permissive Date.parse().
 *
 * HTTP-date parsing validates the calendar fields and weekday, while
 * delay-seconds follows the RFC's decimal-only grammar. All returned delays
 * fit within Node's supported timer range.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/** HTTP-date month abbreviations indexed by their UTC month number. */
const HTTP_DATE_MONTHS = Object.freeze({
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
})
const HTTP_DATE_WEEKDAYS = Object.freeze({
  Sun: 0, Sunday: 0,
  Mon: 1, Monday: 1,
  Tue: 2, Tuesday: 2,
  Wed: 3, Wednesday: 3,
  Thu: 4, Thursday: 4,
  Fri: 5, Friday: 5,
  Sat: 6, Saturday: 6,
})
const IMF_FIXDATE_PATTERN =
  /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/
const RFC850_DATE_PATTERN =
  /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/
const ASCTIME_DATE_PATTERN =
  /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ( [1-9]|[12]\d|3[01]) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/

function makeHttpDateTimestamp(weekdayName, dayText, monthName, year, hourText, minuteText, secondText) {
  const month = HTTP_DATE_MONTHS[monthName]
  const expectedWeekday = HTTP_DATE_WEEKDAYS[weekdayName]
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)
  if (
    month === undefined ||
    expectedWeekday === undefined ||
    !Number.isInteger(year) ||
    day < 1 || day > 31 ||
    hour < 0 || hour > 23 ||
    minute < 0 || minute > 59 ||
    second < 0 || second > 59
  ) return undefined

  // Date.UTC() treats years 0..99 as 1900..1999. HTTP-date carries
  // an explicit four-digit year, so construct the UTC value without that
  // legacy offset (including for years before 0100).
  const date = new Date(0)
  date.setUTCFullYear(year, month, day)
  date.setUTCHours(hour, minute, second, 0)
  const timestamp = date.getTime()
  if (
    !Number.isFinite(timestamp) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second ||
    date.getUTCDay() !== expectedWeekday
  ) return undefined
  return timestamp
}

function parseHttpDate(value) {
  let match = IMF_FIXDATE_PATTERN.exec(value)
  if (match) {
    return makeHttpDateTimestamp(
      match[1], match[2], match[3], Number(match[4]), match[5], match[6], match[7],
    )
  }

  match = RFC850_DATE_PATTERN.exec(value)
  if (match) {
    const currentYear = new Date(Date.now()).getUTCFullYear()
    let year = Math.floor(currentYear / 100) * 100 + Number(match[4])
    const candidate = Date.UTC(
      year,
      HTTP_DATE_MONTHS[match[3]],
      Number(match[2]),
      Number(match[5]),
      Number(match[6]),
      Number(match[7]),
    )
    const fiftyYearsFromNow = new Date(Date.now())
    fiftyYearsFromNow.setUTCFullYear(fiftyYearsFromNow.getUTCFullYear() + 50)
    // RFC 850's obsolete two-digit year form means the most recent matching
    // past year when the initial interpretation would be over 50 years ahead.
    if (candidate > fiftyYearsFromNow.getTime()) year -= 100
    return makeHttpDateTimestamp(
      match[1], match[2], match[3], year, match[5], match[6], match[7],
    )
  }

  match = ASCTIME_DATE_PATTERN.exec(value)
  if (match) {
    return makeHttpDateTimestamp(
      match[1], match[3], match[2], Number(match[7]), match[4], match[5], match[6],
    )
  }
  return undefined
}

/**
 * Read a `Retry-After` header as a delay.
 * @param value - the raw header value.
 * @returns the delay in milliseconds, or `undefined` when absent or unusable.
 */
export function parseRetryAfter(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined

  // RFC delay-seconds is one or more decimal digits, not JavaScript's wider
  // Number() grammar (which also accepts signs, fractions and exponent/hex
  // notation). Keep large valid values finite; backoff() applies our cap.
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed)
    if (!Number.isFinite(seconds)) return Number.MAX_VALUE
    const milliseconds = seconds * 1000
    return Number.isFinite(milliseconds)
      ? Math.min(milliseconds, MAX_TIMER_DELAY_MS)
      : MAX_TIMER_DELAY_MS
  }

  const when = parseHttpDate(trimmed)
  if (when === undefined) return undefined
  return Math.min(Math.max(0, when - Date.now()), MAX_TIMER_DELAY_MS)
}

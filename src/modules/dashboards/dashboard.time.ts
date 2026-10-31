import { dhakaMidnight } from '../../http/list-query.js';

export function addCalendarDays(date: string, days: number) {
  const instant = new Date(`${date}T00:00:00Z`);
  instant.setUTCDate(instant.getUTCDate() + days);
  return instant.toISOString().slice(0, 10);
}
export function dashboardRange(
  query: { from?: string | undefined; to?: string | undefined },
  now = new Date(),
) {
  const to =
    query.to ??
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Dhaka',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(to) ||
    !Number.isFinite(Date.parse(`${to}T00:00:00Z`))
  )
    return null;
  const from = query.from ?? addCalendarDays(to, -29);
  const days =
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86_400_000 +
    1;
  if (!Number.isFinite(days) || days < 1 || days > 365 || from < '0001-01-01')
    return null;
  return {
    from,
    to,
    timezone: 'Asia/Dhaka' as const,
    interval: days <= 90 ? ('day' as const) : ('month' as const),
  };
}
export type DashboardRange = NonNullable<ReturnType<typeof dashboardRange>>;
export function trendMatch(range: DashboardRange) {
  return {
    $gte: dhakaMidnight(range.from),
    $lt: dhakaMidnight(range.to, true),
  };
}
export function zeroFill(
  range: DashboardRange,
  rows: { _id: string; count: number }[],
) {
  const counts = new Map(rows.map((row) => [row._id, row.count]));
  const buckets: { date: string; count: number }[] = [];
  let date =
    range.interval === 'day' ? range.from : `${range.from.slice(0, 7)}-01`;
  while (date <= range.to) {
    buckets.push({ date, count: counts.get(date) ?? 0 });
    if (
      date === range.to ||
      (range.interval === 'month' && date.slice(0, 7) === range.to.slice(0, 7))
    )
      break;
    if (range.interval === 'day') date = addCalendarDays(date, 1);
    else {
      const instant = new Date(`${date}T00:00:00Z`);
      instant.setUTCMonth(instant.getUTCMonth() + 1);
      date = instant.toISOString().slice(0, 10);
    }
  }
  return buckets;
}

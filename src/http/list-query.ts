import { z } from 'zod';
import { normalizeSearch } from '../database/schema-helpers.js';

export const calendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return (
      Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === value &&
      value >= '0001-01-01'
    );
  });
export const paginationFields = {
  page: z
    .string()
    .regex(/^[1-9]\d*$/)
    .pipe(z.coerce.number<string>().int().max(1_000_000))
    .prefault('1'),
  limit: z
    .string()
    .regex(/^[1-9]\d*$/)
    .pipe(z.coerce.number<string>().int().max(100))
    .prefault('20'),
};
export const paginationSchema = z.strictObject(paginationFields);
export const listFields = {
  ...paginationFields,
  search: z.string().trim().max(200).optional(),
  sort: z
    .enum(['createdAt', '-createdAt', 'name', '-name'])
    .default('-createdAt'),
  from: calendarDateSchema.optional(),
  to: calendarDateSchema.optional(),
};
export const validRange = (query: {
  from?: string | undefined;
  to?: string | undefined;
}) => !query.from || !query.to || query.from <= query.to;
export const listQuerySchema = z
  .strictObject(listFields)
  .refine(validRange, { path: ['to'], message: 'Reversed date range' });
export type ListQuery = z.infer<typeof listQuerySchema>;
const dhakaCalendar = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Dhaka',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
export function dhakaMidnight(value: string, nextDay = false) {
  const target = new Date(`${value}T00:00:00Z`);
  if (nextDay) target.setUTCDate(target.getUTCDate() + 1);
  let instant = target.getTime();
  // Resolve local midnight using IANA timezone data, including historical DST.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = Object.fromEntries(
      dhakaCalendar
        .formatToParts(new Date(instant))
        .map((part) => [part.type, part.value]),
    );
    const represented = new Date(0);
    represented.setUTCFullYear(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
    );
    represented.setUTCHours(
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
      0,
    );
    const difference = target.getTime() - represented.getTime();
    if (difference === 0) break;
    instant += difference;
  }
  return new Date(instant);
}
export function listSort(
  query: Pick<ListQuery, 'sort'>,
): Record<string, 1 | -1> {
  const direction = query.sort.startsWith('-') ? -1 : 1;
  return {
    [query.sort.replace(/^-/, '') === 'name' ? 'nameKey' : 'createdAt']:
      direction,
    _id: direction,
  };
}
export function listFilter(query: ListQuery): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  const search = normalizeSearch(query.search ?? '');
  if (search)
    filter.searchKeys = new RegExp(
      `^${search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
    );
  if (query.from || query.to) {
    filter.createdAt = {
      ...(query.from ? { $gte: dhakaMidnight(query.from) } : {}),
      ...(query.to
        ? {
            $lt: dhakaMidnight(query.to, true),
          }
        : {}),
    };
  }
  return filter;
}
export function listResult<T>(
  data: T[],
  total: number,
  query: { page: number; limit: number },
) {
  return {
    data,
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    },
  };
}

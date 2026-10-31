import { z } from 'zod';
import { paginationFields } from '../../http/list-query.js';

export const filterQuerySchema = z.strictObject({
  ...paginationFields,
  field: z
    .enum(['specialization', 'hospital', 'condition', 'status'])
    .default('condition'),
  search: z.string().trim().max(200).optional(),
});
export const filterResponseSchema = z.strictObject({
  data: z
    .array(z.strictObject({ value: z.string(), label: z.string() }))
    .max(100),
  meta: z.strictObject({
    page: z.number().int().min(1),
    limit: z.number().int().min(1).max(100),
    total: z.number().int().min(0),
    totalPages: z.number().int().min(0),
  }),
});

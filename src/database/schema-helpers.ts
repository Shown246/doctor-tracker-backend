import type { Schema } from 'mongoose';

export const schemaOptions = {
  timestamps: true,
  strict: 'throw' as const,
  autoIndex: false,
  autoCreate: false,
  optimisticConcurrency: true,
} as const;

export const boundedText = <const Required extends boolean = true>(
  maxLength: number,
  required: Required = true as Required,
) => ({
  type: String,
  trim: true,
  required,
  minLength: 1,
  maxLength,
});

export const normalizeEmail = (value: unknown) =>
  typeof value === 'string' ? value.trim().toLowerCase() || undefined : value;

export const emailField = <const Required extends boolean>(
  required: Required,
) => ({
  type: String,
  required,
  maxLength: 254,
  set: normalizeEmail,
  match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
});

export function normalizeSearch(value: string) {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

export function searchKeys(values: (string | null | undefined)[]) {
  return [
    ...new Set(
      values.flatMap((value) => {
        if (!value) return [];
        const normalized = normalizeSearch(value);
        return [normalized, ...normalized.split(/[^\p{L}\p{N}@+]+/u)].filter(
          Boolean,
        );
      }),
    ),
  ];
}

export function isValidBirthDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value)
    return false;
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return value >= '1900-01-01' && value <= today;
}

// Profile services must load/edit/save documents. Query updates bypass derived fields,
// document validation and cross-field invariants, so reject them explicitly.
export function requireDocumentWrites(schema: Schema) {
  schema.pre(
    [
      'updateOne',
      'updateMany',
      'findOneAndUpdate',
      'replaceOne',
      'findOneAndReplace',
    ],
    function () {
      throw new Error('Use document.save() for validated model updates');
    },
  );
  schema.pre('insertMany', function () {
    throw new Error('Use model.create() for validated model inserts');
  });
  schema.pre('bulkWrite', function () {
    throw new Error('Use validated document writes instead of bulkWrite()');
  });
}

export function addProfileIndexes(schema: Schema) {
  schema.index({ createdAt: -1, _id: -1 });
  schema.index({ nameKey: 1, _id: 1 });
  schema.index({ searchKeys: 1 });
}

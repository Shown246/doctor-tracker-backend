import { model, Schema } from 'mongoose';
import {
  addProfileIndexes,
  boundedText,
  emailField,
  isValidBirthDate,
  normalizeSearch,
  requireDocumentWrites,
  schemaOptions,
  searchKeys,
} from '../../database/schema-helpers.js';

export const patientStatuses = [
  'unassessed',
  'under_treatment',
  'stable',
  'critical',
  'recovered',
] as const;
export const genders = ['female', 'male', 'other', 'undisclosed'] as const;

const patientSchema = new Schema(
  {
    name: boundedText(120),
    dateOfBirth: { type: String, required: true, validate: isValidBirthDate },
    gender: { type: String, enum: genders, required: true },
    phone: boundedText(32),
    email: emailField(false),
    address: boundedText(500, false),
    condition: boundedText(2000, false),
    status: {
      type: String,
      enum: patientStatuses,
      default: 'unassessed',
      required: true,
    },
    revision: {
      type: Number,
      min: 0,
      default: 0,
      required: true,
      validate: Number.isSafeInteger,
    },
    lastClinicalEditor: { type: Schema.Types.ObjectId, ref: 'User' },
    lastClinicalUpdateAt: Date,
    nameKey: { type: String, select: false },
    conditionKey: { type: String, select: false },
    searchKeys: { type: [String], select: false },
  },
  { ...schemaOptions, collection: 'patients' },
);

patientSchema.pre('validate', function () {
  this.nameKey = normalizeSearch(this.name ?? '');
  this.conditionKey = normalizeSearch(this.condition ?? '');
  this.searchKeys = searchKeys([
    this.name,
    this.email,
    this.phone,
    this.condition,
    this.address,
  ]);
});
patientSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { email: { $type: 'string' } } },
);
addProfileIndexes(patientSchema);
patientSchema.index({ conditionKey: 1, createdAt: -1, _id: -1 });
patientSchema.index({ status: 1, createdAt: -1, _id: -1 });
requireDocumentWrites(patientSchema);

export const Patient = model('Patient', patientSchema);

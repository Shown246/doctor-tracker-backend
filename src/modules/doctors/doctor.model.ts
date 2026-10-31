import { model, Schema } from 'mongoose';
import {
  addProfileIndexes,
  boundedText,
  emailField,
  normalizeSearch,
  requireDocumentWrites,
  schemaOptions,
  searchKeys,
} from '../../database/schema-helpers.js';

const doctorSchema = new Schema(
  {
    name: boundedText(120),
    specialization: boundedText(120),
    hospital: boundedText(200),
    phone: boundedText(32),
    email: emailField(true),
    nameKey: { type: String, select: false },
    specializationKey: { type: String, select: false },
    hospitalKey: { type: String, select: false },
    searchKeys: { type: [String], select: false },
  },
  { ...schemaOptions, collection: 'doctors' },
);

doctorSchema.pre('validate', function () {
  this.nameKey = normalizeSearch(this.name ?? '');
  this.specializationKey = normalizeSearch(this.specialization ?? '');
  this.hospitalKey = normalizeSearch(this.hospital ?? '');
  this.searchKeys = searchKeys([
    this.name,
    this.email,
    this.phone,
    this.specialization,
    this.hospital,
  ]);
});
doctorSchema.index({ email: 1 }, { unique: true });
addProfileIndexes(doctorSchema);
doctorSchema.index({ specializationKey: 1, createdAt: -1, _id: -1 });
doctorSchema.index({ hospitalKey: 1, createdAt: -1, _id: -1 });
requireDocumentWrites(doctorSchema);

export const Doctor = model('Doctor', doctorSchema);

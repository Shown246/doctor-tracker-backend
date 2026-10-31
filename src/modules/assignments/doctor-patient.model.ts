import { model, Schema } from 'mongoose';
import {
  boundedText,
  requireDocumentWrites,
  schemaOptions,
} from '../../database/schema-helpers.js';

const doctorPatientSchema = new Schema(
  {
    doctorId: {
      type: Schema.Types.ObjectId,
      ref: 'Doctor',
      required: true,
      immutable: true,
    },
    patientId: {
      type: Schema.Types.ObjectId,
      ref: 'Patient',
      required: true,
      immutable: true,
    },
    assignedAt: {
      type: Date,
      default: Date.now,
      required: true,
      immutable: true,
    },
    privateNote: { ...boundedText(20_000, false), select: false },
    noteRevision: {
      type: Number,
      default: 0,
      min: 0,
      required: true,
      validate: Number.isSafeInteger,
    },
    noteUpdatedAt: Date,
  },
  { ...schemaOptions, collection: 'doctorPatients' },
);

doctorPatientSchema.index({ doctorId: 1, patientId: 1 }, { unique: true });
doctorPatientSchema.index({ patientId: 1, doctorId: 1 });
doctorPatientSchema.index({ doctorId: 1, assignedAt: -1, _id: -1 });
doctorPatientSchema.index({ assignedAt: -1, _id: -1 });
requireDocumentWrites(doctorPatientSchema);

export const DoctorPatient = model('DoctorPatient', doctorPatientSchema);

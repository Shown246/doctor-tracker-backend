import { model, Schema } from 'mongoose';
import {
  boundedText,
  emailField,
  isValidBirthDate,
  requireDocumentWrites,
  schemaOptions,
} from '../../database/schema-helpers.js';
import { genders } from '../patients/patient.model.js';

const pendingRegistrationSchema = new Schema(
  {
    doctor: {
      type: new Schema(
        {
          specialization: boundedText(120),
          hospital: boundedText(200),
          phone: boundedText(32),
        },
        { _id: false, strict: 'throw' },
      ),
      default: undefined,
    },
    patient: {
      type: new Schema(
        {
          dateOfBirth: {
            type: String,
            required: true,
            validate: isValidBirthDate,
          },
          gender: { type: String, enum: genders, required: true },
          phone: boundedText(32),
          address: boundedText(500, false),
        },
        { _id: false, strict: 'throw' },
      ),
      default: undefined,
    },
  },
  { _id: false, strict: 'throw' },
);

const userSchema = new Schema(
  {
    name: boundedText(120),
    email: emailField(true),
    passwordHash: {
      type: String,
      required: true,
      maxLength: 512,
      match: /^\$argon2id\$/,
      select: false,
    },
    role: {
      type: String,
      enum: ['admin', 'doctor', 'patient'],
      required: true,
      immutable: true,
    },
    status: {
      type: String,
      enum: ['pending', 'active', 'rejected', 'disabled'],
      default: 'pending',
      required: true,
    },
    doctorId: { type: Schema.Types.ObjectId, ref: 'Doctor' },
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient' },
    pendingRegistration: { type: pendingRegistrationSchema, select: false },
    rejectionReason: { ...boundedText(1000, false), select: false },
  },
  { ...schemaOptions, collection: 'users' },
);

userSchema.pre('validate', function () {
  if (this.role === 'admin') {
    if (
      !['active', 'disabled'].includes(this.status) ||
      this.doctorId ||
      this.patientId ||
      this.pendingRegistration
    ) {
      this.invalidate(
        'role',
        'Admin accounts cannot have profiles or registration details',
      );
    }
  } else {
    if (
      (this.role === 'doctor' && this.patientId) ||
      (this.role === 'patient' && this.doctorId)
    ) {
      this.invalidate('role', 'Profile must match the account role');
    }
    if (
      this.status === 'active' &&
      !(this.role === 'doctor' ? this.doctorId : this.patientId)
    ) {
      this.invalidate('status', 'Active accounts require a profile');
    }
    if (
      ['pending', 'rejected'].includes(this.status) &&
      (this.doctorId || this.patientId)
    ) {
      this.invalidate('status', 'Unapproved accounts cannot have profiles');
    }
    if (
      this.isNew &&
      ['pending', 'rejected'].includes(this.status) &&
      !this.pendingRegistration
    ) {
      this.invalidate(
        'pendingRegistration',
        'Registration details are required',
      );
    }
    if (
      this.pendingRegistration &&
      (this.role === 'doctor'
        ? !this.pendingRegistration.doctor || this.pendingRegistration.patient
        : !this.pendingRegistration.patient || this.pendingRegistration.doctor)
    ) {
      this.invalidate(
        'pendingRegistration',
        'Registration details must match the role',
      );
    }
  }
});
userSchema.index({ email: 1 }, { unique: true });
userSchema.index(
  { doctorId: 1 },
  {
    unique: true,
    partialFilterExpression: { doctorId: { $type: 'objectId' } },
  },
);
userSchema.index(
  { patientId: 1 },
  {
    unique: true,
    partialFilterExpression: { patientId: { $type: 'objectId' } },
  },
);
userSchema.index({ createdAt: -1, _id: -1 });
userSchema.index({ status: 1, createdAt: -1, _id: -1 });
userSchema.index({ role: 1, status: 1, createdAt: -1, _id: -1 });
requireDocumentWrites(userSchema);

export const User = model('User', userSchema);

import { User } from '../modules/auth/user.model.js';
import { Doctor } from '../modules/doctors/doctor.model.js';
import { Patient } from '../modules/patients/patient.model.js';
import { DoctorPatient } from '../modules/assignments/doctor-patient.model.js';

export async function setupIndexes() {
  // createIndexes is repeatable and never drops existing indexes or user data.
  // Do not use syncIndexes here: it can remove indexes added by later releases.
  for (const model of [User, Doctor, Patient, DoctorPatient]) {
    await model.createIndexes();
  }
}

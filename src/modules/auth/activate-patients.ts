import mongoose from 'mongoose';
import { ApiError } from '../../errors/api-error.js';
import { Patient } from '../patients/patient.model.js';
import { User } from './user.model.js';

// Only pending patients qualify; rejected/disabled accounts retain their status.
export async function activatePendingPatient(id: string) {
  return mongoose.connection.transaction(async (session) => {
    const user = await User.findOne({
      _id: id,
      role: 'patient',
      status: 'pending',
    })
      .select('+pendingRegistration')
      .session(session);
    if (!user) return false;
    if (!user.pendingRegistration?.patient || user.patientId || user.doctorId)
      throw new ApiError(
        409,
        'REGISTRATION_CONFLICT',
        'Invalid pending patient',
      );
    const submitted = user.pendingRegistration.patient;
    const patient = new Patient({
      name: user.name,
      email: user.email,
      dateOfBirth: submitted.dateOfBirth,
      gender: submitted.gender,
      phone: submitted.phone,
      address: submitted.address,
      status: 'unassessed',
    });
    await patient.save({ session });
    user.patientId = patient._id;
    user.status = 'active';
    user.set('pendingRegistration', undefined);
    await user.save({ session });
    return true;
  });
}

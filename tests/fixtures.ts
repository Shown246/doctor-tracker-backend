export const validEnvironment = {
  NODE_ENV: 'test',
  PORT: '4000',
  MONGODB_URI: 'mongodb://127.0.0.1:27017/',
  MONGODB_DATABASE: 'doctor_tracker_test',
  SESSION_SECRET: 'test-session-secret-at-least-32-characters',
  FRONTEND_ORIGIN: 'http://localhost:3000',
  TRUST_PROXY: 'false',
  LOG_LEVEL: 'silent',
};

export const doctorInput = {
  name: 'Dr Example',
  specialization: 'Cardiology',
  hospital: 'Example Hospital',
  phone: '+8801700000000',
  email: 'doctor@example.test',
};
export const patientInput = {
  name: 'Example Patient',
  dateOfBirth: '1995-02-28',
  gender: 'undisclosed' as const,
  phone: '+8801800000000',
  condition: 'Routine Observation',
};

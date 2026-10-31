import { Router } from 'express';
import {
  allowRoles,
  requireActiveAccount,
  requireAuthentication,
} from '../auth/access.js';
import {
  clearNote,
  clinical,
  contact,
  doctors,
  note,
  patient,
  patients,
  profile,
  putNote,
} from './profile.controller.js';

export function profileRoutes() {
  const router = Router();
  router.use(requireAuthentication, requireActiveAccount);
  router.get('/profile', allowRoles('doctor', 'patient'), profile);
  router.patch('/profile', allowRoles('patient'), contact);
  router.get('/doctors', allowRoles('patient'), doctors);
  router.get('/patients', allowRoles('doctor'), patients);
  router.get('/patients/:patientId', allowRoles('doctor'), patient);
  router.patch('/patients/:patientId/clinical', allowRoles('doctor'), clinical);
  router
    .route('/patients/:patientId/note')
    .all(allowRoles('doctor'))
    .get(note)
    .put(putNote)
    .delete(clearNote);
  return router;
}

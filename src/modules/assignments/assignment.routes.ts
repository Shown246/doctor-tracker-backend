import { Router } from 'express';
import {
  allowRoles,
  requireActiveAccount,
  requireAuthentication,
} from '../auth/access.js';
import { link, notes, patients, unlink } from './assignment.controller.js';

export function assignmentRoutes() {
  const router = Router();
  router.use(
    ['/doctors/:doctorId/patients', '/patients/:patientId/doctor-notes'],
    requireAuthentication,
    requireActiveAccount,
    allowRoles('admin'),
  );
  router.get('/doctors/:doctorId/patients', patients);
  router
    .route('/doctors/:doctorId/patients/:patientId')
    .put(link)
    .delete(unlink);
  router.get('/patients/:patientId/doctor-notes', notes);
  return router;
}

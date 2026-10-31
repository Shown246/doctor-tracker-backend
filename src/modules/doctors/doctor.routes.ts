import { Router } from 'express';
import {
  allowRoles,
  requireActiveAccount,
  requireAuthentication,
} from '../auth/access.js';
import { create, detail, edit, list } from './doctor.controller.js';

export function doctorRoutes() {
  const router = Router();
  router.use(requireAuthentication, requireActiveAccount, allowRoles('admin'));
  router.route('/').get(list).post(create);
  router.route('/:id').get(detail).patch(edit);
  return router;
}

import { Router } from 'express';
import {
  allowRoles,
  requireActiveAccount,
  requireAuthentication,
} from '../auth/access.js';
import { decision, detail, list } from './registration.controller.js';

export function registrationRoutes() {
  const router = Router();
  router.use(requireAuthentication, requireActiveAccount, allowRoles('admin'));
  router.get('/', list);
  router.get('/:id', detail);
  router.put('/:id/decision', decision);
  return router;
}

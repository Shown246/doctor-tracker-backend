import { Router } from 'express';
import {
  requireAuthentication,
  requireActiveAccount,
  allowRoles,
} from '../auth/access.js';
import { getDashboard, getFilters } from './dashboard.controller.js';

export function dashboardRoutes() {
  const router = Router();
  router.get(
    '/dashboard',
    requireAuthentication,
    requireActiveAccount,
    getDashboard,
  );
  router.get(
    '/filters',
    requireAuthentication,
    requireActiveAccount,
    allowRoles('admin', 'doctor'),
    getFilters,
  );
  return router;
}

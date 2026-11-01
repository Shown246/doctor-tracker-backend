import { Router } from 'express';
import type { Environment } from '../../config/environment.js';
import {
  csrfToken,
  currentUser,
  login,
  logout,
  registerAccount,
} from './auth.controller.js';
import { requireAuthentication } from './access.js';
import { authThrottle } from './throttle.js';
import {
  googleStart,
  googleCallback,
  googlePending,
  googleRegister,
  googleLink,
} from './google.js';

export function authRoutes(config: Environment) {
  const router = Router();
  router.get('/csrf', csrfToken);
  router.post(
    '/google/start',
    authThrottle(config, 'loginIp'),
    googleStart(config),
  );
  router.get('/google/callback', googleCallback(config));
  router.get('/google/pending', googlePending);
  router.post(
    '/google/register',
    authThrottle(config, 'registration'),
    googleRegister,
  );
  router.post(
    '/google/link',
    authThrottle(config, 'loginIp'),
    authThrottle(config, 'loginAccountIp'),
    googleLink,
  );
  router.post(
    '/register',
    authThrottle(config, 'registration'),
    registerAccount,
  );
  router.post(
    '/login',
    authThrottle(config, 'loginIp'),
    authThrottle(config, 'loginAccountIp'),
    login,
  );
  router.get('/me', requireAuthentication, currentUser);
  router.post('/logout', logout(config));
  return router;
}

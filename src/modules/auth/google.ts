import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { OAuth2Client } from 'google-auth-library';
import type { Environment } from '../../config/environment.js';
import { ApiError } from '../../errors/api-error.js';
import { authenticate, findCurrentUser, register } from './auth.service.js';
import { currentUserResponseSchema } from './auth.schemas.js';
import {
  googleLinkSchema,
  googleRegistrationSchema,
} from './google.schemas.js';
import { regenerateSession, saveSession, startSession } from './session.js';
import { User } from './user.model.js';

const lifetime = 10 * 60 * 1000;
function client(config: Environment) {
  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET)
    throw new ApiError(
      503,
      'GOOGLE_NOT_CONFIGURED',
      'Google Sign-In is not configured. Please use email and password.',
    );
  return new OAuth2Client({
    clientId: config.GOOGLE_CLIENT_ID,
    clientSecret: config.GOOGLE_CLIENT_SECRET,
    redirectUri: `${config.FRONTEND_ORIGIN}/api/v1/auth/google/callback`,
    transporterOptions: { timeout: 12_000, retry: false },
  });
}
function pending(request: Request) {
  const identity = request.session.googleIdentity;
  if (!identity || identity.expiresAt <= Date.now())
    throw new ApiError(
      401,
      'GOOGLE_IDENTITY_EXPIRED',
      'Google verification expired. Please continue with Google again.',
    );
  return identity;
}
async function signIn(request: Request, id: string) {
  const account = await findCurrentUser(id);
  if (!account || account.status === 'disabled')
    throw new ApiError(
      401,
      'GOOGLE_SIGN_IN_FAILED',
      'Unable to sign in with this Google account.',
    );
  await regenerateSession(request);
  startSession(request, id);
  await saveSession(request);
  return account;
}
export function googleStart(config: Environment): RequestHandler {
  return async (request, response) => {
    const oauth = client(config);
    if (!request.session.csrfToken) startSession(request);
    delete request.session.googleIdentity;
    const state = randomBytes(32).toString('hex');
    const nonce = randomBytes(32).toString('hex');
    const verifier = randomBytes(32).toString('base64url');
    request.session.googleOAuth = {
      state,
      nonce,
      verifier,
      expiresAt: Date.now() + lifetime,
    };
    await saveSession(request);
    const url = new URL(
      oauth.generateAuthUrl({
        scope: ['openid', 'email', 'profile'],
        state,
        prompt: 'select_account',
      }),
    );
    url.searchParams.set('nonce', nonce);
    url.searchParams.set(
      'code_challenge',
      createHash('sha256').update(verifier).digest('base64url'),
    );
    url.searchParams.set('code_challenge_method', 'S256');
    response.json({ data: { url: url.toString() } });
  };
}
export function googleCallback(config: Environment): RequestHandler {
  return async (request, response) => {
    const transaction = request.session.googleOAuth;
    delete request.session.googleOAuth;
    await saveSession(request);
    const state = request.query.state;
    if (
      !transaction ||
      transaction.expiresAt <= Date.now() ||
      typeof state !== 'string' ||
      !/^[a-f\d]{64}$/.test(state) ||
      !timingSafeEqual(Buffer.from(state), Buffer.from(transaction.state))
    ) {
      response.redirect(`${config.FRONTEND_ORIGIN}/login?googleError=state`);
      return;
    }
    if (request.query.error || typeof request.query.code !== 'string') {
      response.redirect(
        `${config.FRONTEND_ORIGIN}/login?googleError=cancelled`,
      );
      return;
    }
    // Provider errors can include tokens and secrets. Never forward or log them.
    let identity: {
      sub: string;
      email: string;
      name: string;
      expiresAt: number;
    };
    try {
      const oauth = client(config);
      const { tokens } = await oauth.getToken({
        code: request.query.code,
        codeVerifier: transaction.verifier,
      });
      if (!tokens.id_token) throw new Error('Missing identity token');
      const ticket = await oauth.verifyIdToken({
        idToken: tokens.id_token,
        audience: config.GOOGLE_CLIENT_ID!,
      });
      const payload = ticket.getPayload();
      if (
        !payload?.sub ||
        !payload.email ||
        payload.email_verified !== true ||
        payload.nonce !== transaction.nonce
      )
        throw new Error('Invalid identity');
      identity = {
        sub: payload.sub,
        email: payload.email.trim().toLowerCase(),
        name: (payload.name || payload.email).trim().slice(0, 120),
        expiresAt: Date.now() + lifetime,
      };
    } catch {
      response.redirect(`${config.FRONTEND_ORIGIN}/login?googleError=failed`);
      return;
    }
    const user = await User.findOne({ googleSubject: identity.sub });
    if (user) {
      if (user.status === 'disabled') {
        response.redirect(`${config.FRONTEND_ORIGIN}/login?googleError=failed`);
        return;
      }
      const account = await signIn(request, user.id);
      response.redirect(
        `${config.FRONTEND_ORIGIN}${account.status === 'active' ? `/${account.role}` : '/status'}`,
      );
      return;
    }
    await regenerateSession(request);
    startSession(request);
    request.session.googleIdentity = identity;
    await saveSession(request);
    response.redirect(`${config.FRONTEND_ORIGIN}/register?google=1`);
  };
}
export const googlePending: RequestHandler = async (request, response) => {
  const identity = pending(request);
  const existing = await User.exists({ email: identity.email });
  response.json({
    data: {
      name: identity.name,
      email: identity.email,
      existingAccount: Boolean(existing),
    },
  });
};
export const googleRegister: RequestHandler = async (request, response) => {
  const identity = pending(request);
  const input = googleRegistrationSchema.parse(request.body);
  if (await User.exists({ email: identity.email }))
    throw new ApiError(
      409,
      'GOOGLE_ACCOUNT_EXISTS',
      'Sign in with your existing password to link Google.',
    );
  // Keep the existing password-hash invariant with an unguessable, discarded password.
  const account = await register(
    {
      ...input,
      name: identity.name,
      email: identity.email,
      password: randomBytes(48).toString('base64url'),
    },
    identity.sub,
  );
  const signedIn = await signIn(request, account.id);
  response
    .status(201)
    .json(currentUserResponseSchema.parse({ data: signedIn }));
};
export const googleLink: RequestHandler = async (request, response) => {
  const identity = pending(request);
  const { password } = googleLinkSchema.parse(request.body);
  const id = await authenticate(identity.email, password);
  const user = await User.findById(id).select('+googleSubject');
  if (!user || (user.googleSubject && user.googleSubject !== identity.sub))
    throw new ApiError(
      409,
      'GOOGLE_ALREADY_LINKED',
      'This account is already linked to a different Google account.',
    );
  user.googleSubject = identity.sub;
  await user.save();
  response.json(
    currentUserResponseSchema.parse({ data: await signIn(request, id) }),
  );
};

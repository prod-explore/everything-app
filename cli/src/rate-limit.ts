import { rateLimit, type RateLimitRequestHandler } from 'express-rate-limit';

export interface ApiRateLimitOptions {
  /** Requests allowed per client IP per window. Default 1200 per minute. */
  limit?: number;
  windowMs?: number;
}

/**
 * Per-client-IP request ceiling for the HTTP API and the web app files.
 *
 * This is a backstop against runaway clients and floods, not an access control: the owner of this self-hosted app
 * (a browser with a few SSE streams and polling) stays far below 1200 requests a minute, so it never notices it.
 * Login brute-forcing and device pairing keep their own, much stricter throttles (LoginLimiter, PairingManager).
 * The client IP comes from `req.ip`, which honours the app's `trust proxy` setting (one proxy hop), so behind nginx
 * every visitor is counted separately instead of all sharing the proxy's address. The 429 body uses the app's
 * usual `{ error }` shape.
 */
export function createApiRateLimiter(opts: ApiRateLimitOptions = {}): RateLimitRequestHandler {
  return rateLimit({
    windowMs: opts.windowMs ?? 60_000,
    limit: opts.limit ?? 1200,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'too many requests — slow down and try again in a moment' },
  });
}

import { Context, Next } from 'hono';
import { Env, AgentRow } from '../types';

// In-memory sliding window rate limiter
// Resets on Worker restart (fine for poker — not high-stakes billing)
const windows = new Map<string, { count: number; resetAt: number }>();

interface RateLimitConfig {
  windowMs: number;   // time window in ms
  maxRequests: number; // max requests per window
  keyFn: (c: Context) => string; // how to identify the client
}

const DEFAULTS: Record<string, RateLimitConfig> = {
  // Authenticated routes: 60 req/min per agent (generous for poker pace)
  authenticated: {
    windowMs: 60_000,
    maxRequests: 60,
    keyFn: (c) => {
      const agent = (c as any).get('agent') as AgentRow | undefined;
      return agent ? `agent:${agent.id}` : `ip:${c.req.header('cf-connecting-ip') || 'unknown'}`;
    },
  },
  // Registration: 5 per minute per IP (prevent spam)
  register: {
    windowMs: 60_000,
    maxRequests: 5,
    keyFn: (c) => `register:${c.req.header('cf-connecting-ip') || 'unknown'}`,
  },
  // Chat: 10 per minute per agent (prevent spam)
  chat: {
    windowMs: 60_000,
    maxRequests: 10,
    keyFn: (c) => {
      const agent = (c as any).get('agent') as AgentRow | undefined;
      return agent ? `chat:${agent.id}` : `chat:ip:${c.req.header('cf-connecting-ip') || 'unknown'}`;
    },
  },
  // Public endpoints: 30 per minute per IP
  public: {
    windowMs: 60_000,
    maxRequests: 30,
    keyFn: (c) => `public:${c.req.header('cf-connecting-ip') || 'unknown'}`,
  },
};

function checkLimit(key: string, config: RateLimitConfig): { allowed: boolean; remaining: number; resetIn: number } {
  const now = Date.now();
  let window = windows.get(key);

  // Expired or new window
  if (!window || now >= window.resetAt) {
    window = { count: 0, resetAt: now + config.windowMs };
    windows.set(key, window);
  }

  window.count++;

  // Periodic cleanup (every 100th check, prune expired entries)
  if (Math.random() < 0.01) {
    for (const [k, v] of windows) {
      if (now >= v.resetAt) windows.delete(k);
    }
  }

  return {
    allowed: window.count <= config.maxRequests,
    remaining: Math.max(0, config.maxRequests - window.count),
    resetIn: Math.ceil((window.resetAt - now) / 1000),
  };
}

function createRateLimiter(configName: keyof typeof DEFAULTS) {
  const config = DEFAULTS[configName];
  return async (c: Context, next: Next) => {
    const key = config.keyFn(c);
    const result = checkLimit(key, config);

    // Set rate limit headers
    c.header('X-RateLimit-Limit', String(config.maxRequests));
    c.header('X-RateLimit-Remaining', String(result.remaining));
    c.header('X-RateLimit-Reset', String(result.resetIn));

    if (!result.allowed) {
      return c.json({
        error: 'Rate limit exceeded',
        retryAfter: result.resetIn,
      }, 429);
    }

    await next();
  };
}

export const rateLimitRegister = createRateLimiter('register');
export const rateLimitAuth = createRateLimiter('authenticated');
export const rateLimitChat = createRateLimiter('chat');
export const rateLimitPublic = createRateLimiter('public');

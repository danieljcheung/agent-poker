import { Context, Next } from 'hono';
import { Env, AgentRow } from '../types';
import { hashApiKey } from '../security/sanitizer';

export async function authMiddleware(c: Context<{ Bindings: Env; Variables: { agent: AgentRow } }>, next: Next) {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Missing Authorization header. Use: Bearer <api_key>' }, 401);
  }

  const apiKey = authHeader.slice(7);
  const keyHash = await hashApiKey(apiKey);

  const agent = await c.env.DB.prepare(
    'SELECT * FROM agents WHERE api_key_hash = ?'
  ).bind(keyHash).first<AgentRow>();

  if (!agent) {
    return c.json({ error: 'Invalid API key' }, 401);
  }

  if (agent.banned) {
    return c.json({ error: 'Agent is banned' }, 403);
  }

  c.set('agent', agent);
  await next();
}

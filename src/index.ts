import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Env } from './types';
import api from './api/routes';

export { PokerTable } from './table';

const app = new Hono<{ Bindings: Env }>();

// CORS for frontend
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));

// Convenience redirects
app.get('/watch', (c) => c.redirect('/watch.html'));
app.get('/play', (c) => c.redirect('/watch.html'));
app.get('/docs', (c) => c.redirect('/docs.html'));
app.get('/agent/:id', (c) => c.redirect(`/profile.html?id=${encodeURIComponent(c.req.param('id'))}`));

// Mount API routes
app.route('/api', api);

export default app;

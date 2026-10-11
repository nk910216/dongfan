import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { APP_VERSION } from '@dongfan/shared';
import { fail } from './lib/errors.js';
import { requireSession } from './middleware/auth.js';
import { authRoutes } from './routes/auth.js';
import { babyRoutes } from './routes/babies.js';
import { babyEventRoutes, eventRoutes } from './routes/events.js';
import { exportRoutes } from './routes/export.js';
import { meRoutes } from './routes/me.js';
import { tagRoutes } from './routes/tags.js';
import type { Env } from './lib/types.js';

const app = new Hono<Env>();

app.use('/api/*', async (c, next) => {
  c.set('db', drizzle(c.env.DB));
  await next();
});

// What the client compares its own build against. A published app can be
// older than the API it is talking to for as long as it stays open, so it
// has to be able to ask (spec 2.1).
app.get('/api/version', (c) => c.json({ version: APP_VERSION }));

app.route('/api/auth', authRoutes);

// Everything past this point needs a session.
app.use('/api/me', requireSession);
app.use('/api/babies/*', requireSession);
app.use('/api/events/*', requireSession);

app.route('/api/me', meRoutes);
// Several routers share the /api/babies prefix. Keeping events and tags in
// their own files stops one router growing into everything the app can do.
app.route('/api/babies', babyRoutes);
app.route('/api/babies', babyEventRoutes);
app.route('/api/babies', tagRoutes);
app.route('/api/babies', exportRoutes);
app.route('/api/events', eventRoutes);

app.notFound((c) => (c.req.path.startsWith('/api/') ? fail(c, 'NOT_FOUND') : c.text('Not found', 404)));

app.onError((error, c) => {
  console.error('Unhandled error', error);
  return fail(c, 'INTERNAL');
});

export default app;

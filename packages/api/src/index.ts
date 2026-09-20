import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { fail } from './lib/errors.js';
import { requireSession } from './middleware/auth.js';
import { authRoutes } from './routes/auth.js';
import { babyRoutes } from './routes/babies.js';
import { meRoutes } from './routes/me.js';
import type { Env } from './lib/types.js';

const app = new Hono<Env>();

app.use('/api/*', async (c, next) => {
  c.set('db', drizzle(c.env.DB));
  await next();
});

app.get('/api/version', (c) => c.json({ version: '0.0.0' }));

app.route('/api/auth', authRoutes);

// Everything past this point needs a session.
app.use('/api/me', requireSession);
app.use('/api/babies/*', requireSession);
app.use('/api/events/*', requireSession);

app.route('/api/me', meRoutes);
app.route('/api/babies', babyRoutes);

app.notFound((c) => (c.req.path.startsWith('/api/') ? fail(c, 'NOT_FOUND') : c.text('Not found', 404)));

app.onError((error, c) => {
  console.error('Unhandled error', error);
  return fail(c, 'INTERNAL');
});

export default app;

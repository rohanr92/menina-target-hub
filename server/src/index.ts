// MeninaTargetHub server: API under /api, React app served from /public.
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { env } from './lib/env.js';
import { runMigrations } from './db/index.js';
import { sign, unsign, safeEqual } from './lib/crypto.js';
import { registerRoutes } from './routes/index.js';
import { seedScenarios } from './services/testplan.js';
import { startScheduler } from './jobs/scheduler.js';

const SESSION_COOKIE = 'mth_session';
const SESSION_DAYS = 14;

async function main() {
  await runMigrations();
  await seedScenarios();

  const app = Fastify({ logger: { level: env.isProd ? 'info' : 'warn' }, disableRequestLogging: true, bodyLimit: 25 * 1024 * 1024, trustProxy: true });

  // keep the raw body (needed to verify Shopify webhook signatures)
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    (req as any).rawBody = body;
    if (!body.length) return done(null, {});
    try { done(null, JSON.parse(body.toString('utf8'))); } catch (e: any) { e.statusCode = 400; done(e, undefined); }
  });

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } });

  // ---- auth (single team password from APP_PASSWORD) ----
  const open = ['/api/auth/login', '/api/health', '/api/webhooks/'];
  app.addHook('onRequest', async (req, reply) => {
    // Use the route Fastify actually matched (or the decoded path when nothing matched),
    // never the raw URL: /%61pi/... must not slip past the check.
    let path = req.routeOptions?.url;
    if (!path) {
      try { path = decodeURIComponent(req.url.split('?')[0]); } catch { return reply.code(400).send({ error: 'Bad URL' }); }
    }
    path = path.replace(/\/{2,}/g, '/').toLowerCase();
    if (!path.startsWith('/api')) return;
    if (open.some((p) => path!.startsWith(p))) return;
    const raw = unsign(req.cookies[SESSION_COOKIE]);
    const exp = raw ? Number(raw.split(':')[1]) : 0;
    if (!raw || !exp || exp < Date.now()) return reply.code(401).send({ error: 'Not signed in' });
  });

  app.post('/api/auth/login', async (req, reply) => {
    const { password } = (req.body ?? {}) as { password?: string };
    if (!password || !safeEqual(password, env.appPassword)) {
      await new Promise((r) => setTimeout(r, 600));
      return reply.code(401).send({ error: 'Wrong password' });
    }
    const exp = Date.now() + SESSION_DAYS * 864e5;
    reply.setCookie(SESSION_COOKIE, sign(`team:${exp}`), {
      path: '/', httpOnly: true, sameSite: 'lax', secure: env.isProd, maxAge: SESSION_DAYS * 86400,
    });
    return { ok: true };
  });
  app.post('/api/auth/logout', async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
  app.get('/api/auth/me', async () => ({ ok: true }));
  app.get('/api/health', async () => ({ ok: true, time: new Date().toISOString() }));

  app.setErrorHandler((err: any, _req, reply) => {
    // Target/Shopify errors carry .status; validation errors from services are plain Errors (400);
    // programming / database errors (TypeError, pg errors with .code) stay 500.
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode
      : err.status && err.status >= 400 && err.status < 600 ? (err.status >= 500 ? 502 : 400)
      : err instanceof TypeError || err instanceof ReferenceError || err.code ? 500 : 400;
    if (status >= 500) app.log.error(err);
    reply.code(status).send({ error: err.message ?? 'Error', details: err.body ?? err.details ?? undefined });
  });

  await registerRoutes(app);


  // ---- web app ----
  const here = path.dirname(fileURLToPath(import.meta.url));
  const publicDir = path.resolve(here, '../public');
  if (fs.existsSync(publicDir)) {
    await app.register(fastifyStatic, { root: publicDir, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
      return reply.sendFile('index.html');
    });
  }

  if (!env.disableJobs) startScheduler();
  await app.listen({ port: env.port, host: '0.0.0.0' });
  console.log(`MeninaTargetHub listening on :${env.port}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

'use strict';

const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { authMiddleware } = require('./auth');
const { createServices } = require('./services');
const { HttpError } = require('./util');

/**
 * Builds the Express app. Everything environment-specific is injected so tests can
 * use an in-memory DB and a fake clock.
 */
function createApp({ db, clock = () => new Date(), jwtSecret, rateLimiting = true } = {}) {
  if (!db) throw new Error('createApp needs a db');
  if (!jwtSecret) throw new Error('createApp needs a jwtSecret');

  const svc = createServices(db, clock);
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
    })
  );
  app.use(express.json({ limit: '50kb' }));
  app.use('/api', authMiddleware(db, jwtSecret));

  const limiter = rateLimiting
    ? rateLimit({ windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts. Please try again in a few minutes.' } })
    : null;

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/auth', require('./routes/auth')({ db, secret: jwtSecret, limiter }));
  app.use('/api', require('./routes/public')({ svc }));
  app.use('/api', require('./routes/patient')({ svc }));
  app.use('/api', require('./routes/clinic')({ db, svc }));

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large.' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our side.' });
  });

  app.locals.svc = svc;
  return app;
}

module.exports = { createApp };

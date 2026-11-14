'use strict';

const { openDb } = require('./db');
const { createApp } = require('./app');

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '0.0.0.0';
const dbPath = process.env.DB_PATH || './data/clinicq.db';

let jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
  if (process.env.NODE_ENV === 'production') {
    console.error('JWT_SECRET must be set when NODE_ENV=production');
    process.exit(1);
  }
  jwtSecret = 'dev-only-secret-change-me';
  console.warn('! JWT_SECRET not set, using an insecure development secret.');
}

const db = openDb(dbPath);
const app = createApp({ db, jwtSecret });
const svc = app.locals.svc;

const server = app.listen(port, host, () => {
  console.log(`ClinicQ running at http://localhost:${port}  (db: ${dbPath})`);
});

// Keeps proxies and phones from dropping idle live-queue connections.
const heartbeat = setInterval(() => svc.heartbeat(), 25000);
heartbeat.unref();

function shutdown() {
  clearInterval(heartbeat);
  svc.closeStreams();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { closeDb, getDb } from './db/index.ts';
import { migrate } from './db/migrate.ts';
import { env, repoRoot } from './env.ts';
import { errorHandler, notFoundHandler } from './middleware/error.ts';
import { authRouter } from './routes/auth.ts';
import { calendarRouter } from './routes/calendar.ts';
import { contactsRouter } from './routes/contacts.ts';
import { dashboardRouter } from './routes/dashboard.ts';
import { documentsRouter } from './routes/documents.ts';
import { eventsRouter } from './routes/events.ts';
import { notesRouter } from './routes/notes.ts';
import { organizationsRouter } from './routes/organizations.ts';
import { searchRouter } from './routes/search.ts';
import { settingsRouter } from './routes/settings.ts';
import { tasksRouter } from './routes/tasks.ts';

export const app = express();

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(
  cors({
    origin: (origin, callback) => {
      // Same-origin requests (the built client served below) send no Origin header.
      if (!origin || env.corsOrigins.includes(origin)) return callback(null, true);
      callback(new Error(`Origin ${origin} is not allowed.`));
    },
    credentials: true,
  }),
);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, database: env.dbDriver, storage: env.storageDriver });
});

app.use('/api/auth', authRouter);
app.use('/api/contacts', contactsRouter);
app.use('/api/notes', notesRouter);
app.use('/api/tasks', tasksRouter);
app.use('/api/organizations', organizationsRouter);
app.use('/api/events', eventsRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/search', searchRouter);
app.use('/api/documents', documentsRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/calendar', calendarRouter);

// In production the API also serves the built client, so one process covers both.
const clientDist = path.join(repoRoot, 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

app.use('/api', notFoundHandler);
app.use(errorHandler);

const isEntrypoint = !process.env.ECENTER_TEST_MODE;

if (isEntrypoint) {
  // Schema application is idempotent, so booting a fresh environment just works.
  migrate()
    .then(() => getDb())
    .then(() => {
      const server = app.listen(env.port, () => {
        console.log(`ECenter CRM API listening on http://localhost:${env.port}`);
        console.log(`  database: ${env.dbDriver}   storage: ${env.storageDriver}`);
      });

      const shutdown = (signal: string) => {
        console.log(`\n${signal} received, shutting down.`);
        server.close(() => {
          closeDb()
            .catch(() => {})
            .finally(() => process.exit(0));
        });
      };
      process.on('SIGINT', () => shutdown('SIGINT'));
      process.on('SIGTERM', () => shutdown('SIGTERM'));
    })
    .catch((error: unknown) => {
      console.error('Failed to start:', error);
      process.exit(1);
    });
}

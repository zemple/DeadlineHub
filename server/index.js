import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import express from 'express';
import { OAuth2Client } from 'google-auth-library';
import { createApp } from './app.js';
import { openStore } from './store.js';
import { createSyllabusExtractor } from './syllabus.js';

const origin = new URL(process.env.APP_ORIGIN || 'http://localhost:3000');
const appOrigin = origin.origin;
const local = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
const port = Number(process.env.PORT || origin.port || (origin.protocol === 'https:' ? 443 : 80));
const dbFile = resolve(process.env.DATABASE_PATH || 'data/deadlinehub.sqlite');

if (!local && origin.protocol !== 'https:') throw new Error('A public APP_ORIGIN must use HTTPS.');
const googleClientId = process.env.GOOGLE_CLIENT_ID;
const google = googleClientId && process.env.GOOGLE_CLIENT_SECRET
  ? new OAuth2Client(googleClientId, process.env.GOOGLE_CLIENT_SECRET, appOrigin + '/auth/google/callback')
  : null;
mkdirSync(dirname(dbFile), { recursive: true, mode: 0o700 });
const store = openStore(dbFile);
const app = createApp({
  store,
  appOrigin,
  google,
  googleClientId,
  demoEnabled: local && process.env.DEMO_MODE === 'true',
  extractSyllabus: createSyllabusExtractor({
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || undefined,
  }),
});

app.use(express.static(resolve('dist')));

const bind = local ? (origin.hostname === '[::1]' ? '::1' : '127.0.0.1') : '0.0.0.0';
app.listen(port, bind, () => console.log('DeadlineHub is running at ' + appOrigin));

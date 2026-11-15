import { createHash, randomBytes, randomUUID } from 'node:crypto';
import express from 'express';
import { campusDateTime, getSampleDeadlines, maxDeadlines, normalizeCourse, parseQuickAdd, RequestError, validateDeadline } from './deadlines.js';
import { sessionLifetime } from './store.js';

const domain = 'illinois.edu';
const callbackPath = '/auth/google/callback';
const oauthLifetime = 10 * 60 * 1000;
const maxText = 45_000;
const token = () => randomBytes(32).toString('base64url');
const sessionFingerprint = (sid) => createHash('sha256').update('deadlinehub view:' + sid).digest('hex');

function readCookie(req, name) {
  return req.headers.cookie?.split(/;\s*/).find((cookie) => cookie.startsWith(name + '='))?.slice(name.length + 1);
}

function oauthAttempt(req, name) {
  try {
    const raw = readCookie(req, name);
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof parsed.state === 'string' && typeof parsed.nonce === 'string' &&
        typeof parsed.verifier === 'string' && parsed.expires > Date.now()) return parsed;
  } catch {
    // Missing or malformed OAuth flow cookie.
  }
  return null;
}

export function createApp({
  store, appOrigin, google, googleClientId, demoEnabled = false,
  extractSyllabus, now = () => new Date(),
}) {
  const app = express();
  const secure = new URL(appOrigin).protocol === 'https:';
  const sessionCookie = secure ? '__Host-dh_session' : 'dh_session';
  const flowCookie = secure ? '__Host-dh_oauth' : 'dh_oauth';
  const cookieOptions = { secure, httpOnly: true, sameSite: 'lax', path: '/' };
  const json = express.json({ limit: '200kb' });
  const pdfBody = express.raw({ type: 'application/pdf', limit: '5mb' });
  app.disable('x-powered-by');

  function requireSameOrigin(req, _res, next) {
    if (req.get('origin') !== appOrigin) return next(new RequestError(403, 'Open DeadlineHub at its configured address.'));
    next();
  }

  function session(req) {
    const sid = readCookie(req, sessionCookie);
    const user = store.getUser(sid);
    return user && { ...user, sessionId: sessionFingerprint(sid) };
  }

  function requireCurrentSession(req, user) {
    if (req.get('X-DeadlineHub-Session') !== user.sessionId) {
      throw new RequestError(409, 'This tab’s sign-in changed. Reload your agenda and try again.');
    }
  }

  function startSession(req, res, user) {
    store.endSession(readCookie(req, sessionCookie));
    const sid = store.startSession(user);
    res.cookie(sessionCookie, sid, { ...cookieOptions, maxAge: sessionLifetime });
    return { ...user, sessionId: sessionFingerprint(sid) };
  }

  function profile(user) {
    return user && { name: user.name, email: user.email, demo: Boolean(user.demo), sessionId: user.sessionId };
  }

  app.use(['/api', '/auth'], (req, res, next) => {
    res.set('Cache-Control', 'no-store').set('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'GET' && req.method !== 'HEAD') return requireSameOrigin(req, res, next);
    next();
  });

  app.get('/api/session', (req, res) => {
    res.json({ user: profile(session(req)), googleEnabled: Boolean(google), demoEnabled });
  });

  app.get('/auth/google', (req, res) => {
    if (!google) return res.redirect('/?login=setup');
    const attempt = { state: token(), nonce: token(), verifier: token(), expires: Date.now() + oauthLifetime };
    const cookie = Buffer.from(JSON.stringify(attempt)).toString('base64url');
    res.cookie(flowCookie, cookie, { ...cookieOptions, maxAge: oauthLifetime });
    res.redirect(google.generateAuthUrl({
      scope: ['openid', 'email', 'profile'],
      hd: domain,
      prompt: 'select_account',
      state: attempt.state,
      nonce: attempt.nonce,
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(attempt.verifier).digest('base64url'),
    }));
  });

  app.get(callbackPath, async (req, res) => {
    if (!google) return res.redirect('/?login=setup');
    const attempt = oauthAttempt(req, flowCookie);
    res.clearCookie(flowCookie, cookieOptions);
    if (!attempt || req.query.state !== attempt.state) return res.redirect('/?login=state');
    if (req.query.error || typeof req.query.code !== 'string') return res.redirect('/?login=cancelled');

    try {
      const { tokens } = await google.getToken({ code: req.query.code, codeVerifier: attempt.verifier });
      if (!tokens.id_token) return res.redirect('/?login=google');
      const ticket = await google.verifyIdToken({ idToken: tokens.id_token, audience: googleClientId });
      const claims = ticket.getPayload();
      if (!claims || claims.nonce !== attempt.nonce) return res.redirect('/?login=state');
      if (claims.hd !== domain || claims.email_verified !== true ||
          !/^[^@\s]+@illinois\.edu$/i.test(claims.email ?? '') || !claims.sub) {
        return res.redirect('/?login=domain');
      }
      startSession(req, res, {
        subject: 'google:' + claims.sub,
        email: claims.email,
        name: claims.name || claims.email.split('@')[0],
        demo: false,
      });
      res.redirect('/?login=success');
    } catch {
      res.redirect('/?login=google');
    }
  });

  app.post('/auth/demo', (req, res) => {
    if (!demoEnabled) throw new RequestError(404, 'Demo sign-in is unavailable.');
    const user = { subject: 'demo:' + randomUUID(), name: 'Demo student', email: '', demo: true };
    res.json({ user: profile(startSession(req, res, user)) });
  });

  app.post('/auth/logout', (req, res) => {
    const user = session(req);
    if (user) requireCurrentSession(req, user);
    store.endSession(readCookie(req, sessionCookie));
    res.clearCookie(sessionCookie, cookieOptions);
    res.sendStatus(204);
  });

  const api = express.Router();
  api.use((req, _res, next) => {
    req.user = session(req);
    if (!req.user) return next(new RequestError(401, 'Sign in to view your deadlines.'));
    requireCurrentSession(req, req.user);
    next();
  });

  api.get('/deadlines', (req, res) => {
    res.json({ deadlines: store.listDeadlines(req.user.subject) });
  });

  api.post('/deadlines', json, (req, res) => {
    const items = req.body?.items;
    if (!Array.isArray(items) || items.length < 1 || items.length > maxDeadlines) {
      throw new RequestError(400, 'Select between 1 and ' + maxDeadlines + ' deadlines to save.');
    }
    const added = store.saveDeadlines(req.user.subject, items.map(validateDeadline));
    res.status(201).json({ added, deadlines: store.listDeadlines(req.user.subject) });
  });

  api.post('/quick-add/preview', json, (req, res) => {
    res.json({ items: [parseQuickAdd(req.body?.text, now())] });
  });

  api.get('/syllabus/sample', (_req, res) => {
    res.json({ items: getSampleDeadlines(now()) });
  });

  function syllabusDetails(input) {
    const course = normalizeCourse(input?.course);
    const year = Number(input?.year ?? campusDateTime(now()).date.slice(0, 4));
    if (!Number.isInteger(year) || year < 1900 || year > 2200) {
      throw new RequestError(400, 'Enter a valid academic year.');
    }
    return { course, year };
  }

  function preview(getSource) {
    return async (req, res, next) => {
      try {
        const items = await extractSyllabus(getSource(req));
        res.json({ items });
      } catch (error) {
        next(error);
      }
    };
  }

  api.post('/syllabus/preview/text', json, preview((req) => {
    const text = typeof req.body?.text === 'string' && req.body.text.trim();
    if (!text || text.length > maxText) throw new RequestError(400, 'Paste syllabus text up to 45,000 characters.');
    return { ...syllabusDetails(req.body), text };
  }));

  api.post('/syllabus/preview/pdf', pdfBody, preview((req) => {
    if (!Buffer.isBuffer(req.body) || req.body.subarray(0, 5).toString('ascii') !== '%PDF-') {
      throw new RequestError(400, 'Choose a valid PDF file.');
    }
    return { ...syllabusDetails(req.query), pdf: req.body };
  }));

  app.use('/api', api);
  app.use(['/api', '/auth'], (_req, _res, next) => next(new RequestError(404, 'This endpoint does not exist.')));
  app.use((error, _req, res, _next) => {
    if (error instanceof RequestError) return res.status(error.status).json({ error: error.message });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'The upload is too large. PDFs can be up to 5 MB.' });
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request contains invalid JSON.' });
    console.error('Request failed:', error.name);
    res.status(500).json({ error: 'Something went wrong. Try again in a moment.' });
  });

  return app;
}

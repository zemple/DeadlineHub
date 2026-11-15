import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createApp } from '../server/app.js';
import { parseQuickAdd } from '../server/deadlines.js';
import { createSyllabusExtractor } from '../server/syllabus.js';
import { openStore } from '../server/store.js';

const date = new Date('2026-11-15T20:00:00Z');
const task = { course: 'CS 409', title: 'MP 4', kind: 'assignment', date: '2026-11-20', time: '23:59' };
const googleUser = (sub, nonce) => ({ sub, nonce, hd: 'illinois.edu', email_verified: true, email: sub + '@illinois.edu' });

test('quick add resolves the assignment example in Chicago and rejects missing or invalid dates', () => {
  assert.deepEqual(parseQuickAdd('CS 409 MP due next Friday 11:59pm', date), { ...task, title: 'MP' });
  assert.equal(parseQuickAdd('CS409 Reading due tomorrow', new Date('2026-11-30T03:00:00Z')).date, '2026-11-30');
  assert.equal(parseQuickAdd('CS 409 Reading due 2026-12-04', date).time, null);
  assert.throws(() => parseQuickAdd('CS 409 MP due 11:59pm', date), /date/i);
  assert.throws(() => parseQuickAdd('CS 409 MP due February 30, 2027', date), /date/i);
});

test('Google OAuth validates state, nonce and hosted domain before granting private sessions', async (t) => {
  const google = {
    generateAuthUrl(params) { return 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams(params); },
    async getToken({ code }) { return { tokens: { id_token: code } }; },
    async verifyIdToken({ idToken }) {
      return { getPayload: () => claims.get(idToken) };
    },
  };
  const claims = new Map();
  const { request, beginGoogle, finishGoogle } = await fixture(t, { google, googleClientId: 'test-client' });
  assert.equal((await request('/api/deadlines')).status, 401);

  const invalid = await beginGoogle();
  assert.match((await finishGoogle(invalid, 'anything', 'wrong')).headers.get('location'), /state/);
  const unverified = await beginGoogle();
  claims.set('bad-domain', { ...googleUser('a', unverified.nonce), hd: undefined });
  assert.match((await finishGoogle(unverified, 'bad-domain')).headers.get('location'), /domain/);
  const replay = await beginGoogle();
  claims.set('bad-nonce', googleUser('a', 'incorrect'));
  assert.match((await finishGoogle(replay, 'bad-nonce')).headers.get('location'), /state/);

  async function signIn(sub) {
    const attempt = await beginGoogle();
    assert.equal(attempt.url.searchParams.get('hd'), 'illinois.edu');
    assert.equal(attempt.url.searchParams.get('code_challenge_method'), 'S256');
    claims.set(sub, googleUser(sub, attempt.nonce));
    const response = await finishGoogle(attempt, sub);
    assert.equal(response.headers.get('location'), '/?login=success');
    assert.match(response.headers.get('set-cookie'), /HttpOnly/);
    return response.headers.getSetCookie().find((entry) => entry.startsWith('dh_session=')).split(';')[0];
  }

  const a = await signIn('student-a');
  const b = await signIn('student-b');
  assert.notEqual(a, b);
  const aSession = (await (await request('/api/session', { cookie: a })).json()).user.sessionId;
  const bSession = (await (await request('/api/session', { cookie: b })).json()).user.sessionId;
  assert.match(aSession, /^[a-f0-9]{64}$/);
  assert.notEqual(aSession, bSession);
  const stale = await request('/api/deadlines', { cookie: b, sessionId: aSession, body: { items: [task] } });
  assert.equal(stale.status, 409);
  const saved = await request('/api/deadlines', { cookie: a, sessionId: aSession, body: { items: [task], owner: 'student-b' } });
  assert.equal(saved.status, 201);
  assert.equal((await (await request('/api/deadlines', { cookie: a, sessionId: aSession })).json()).deadlines[0].title, task.title);
  assert.deepEqual((await (await request('/api/deadlines', { cookie: b, sessionId: bSession })).json()).deadlines, []);
  assert.equal((await request('/auth/logout', { cookie: a, sessionId: aSession, body: {} })).status, 204);
  assert.equal((await request('/api/deadlines', { cookie: a })).status, 401);
});

test('text and PDF imports preview only, then save edited rows as an atomic, retryable batch', async (t) => {
  const seen = [];
  const { request, demo } = await fixture(t, {
    demoEnabled: true,
    async extractSyllabus(source) {
      seen.push(source);
      return [task, { ...task, title: 'Final exam', kind: 'exam' }];
    },
  });
  const cookie = await demo();
  const text = await request('/api/syllabus/preview/text', { cookie, body: { text: 'MP 4 due November 20', course: 'CS 409', year: 2026 } });
  assert.equal(text.status, 200);
  assert.equal((await text.json()).items.length, 2);
  const pdf = await request('/api/syllabus/preview/pdf?course=CS%20409&year=2026', { cookie, pdf: '%PDF-1.7\nexample' });
  assert.equal(pdf.status, 200);
  assert.ok(Buffer.isBuffer(seen[1].pdf));
  assert.equal(seen[0].year, 2026);
  assert.equal((await request('/api/syllabus/preview/pdf?course=CS%20409&year=2026', { cookie, pdf: 'not a PDF' })).status, 400);
  assert.equal((await request('/api/deadlines', { cookie, body: { items: [task, { ...task, date: '2026-11-31' }] } })).status, 400);
  assert.deepEqual((await (await request('/api/deadlines', { cookie })).json()).deadlines, []);
  const edited = { ...task, title: 'MP 4 revised', date: '2026-11-22' };
  for (const expected of [1, 0]) {
    const response = await request('/api/deadlines', { cookie, body: { items: [edited] } });
    assert.equal((await response.json()).added, expected);
  }
  const list = (await (await request('/api/deadlines', { cookie })).json()).deadlines;
  assert.deepEqual(list.map(({ title, date }) => ({ title, date })), [{ title: edited.title, date: edited.date }]);
  const parsed = await request('/api/quick-add/preview', { cookie, body: { text: 'CS 409 MP due next Friday 11:59pm' } });
  assert.equal((await parsed.json()).items[0].time, '23:59');
  assert.equal((await request('/api/deadlines', { cookie, body: { items: [task] }, origin: 'https://another.example' })).status, 403);
});

test('extractor sends structured PDF input, and invalid model rows fail validation', async () => {
  let sent;
  let modelResult = { items: [{ title: task.title, kind: task.kind, date: task.date, time: task.time }] };
  const extract = createSyllabusExtractor({
    apiKey: 'fixture',
    model: 'fixture-model',
    async fetchImpl(_url, options) {
      sent = JSON.parse(options.body);
      return Response.json({
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(modelResult) }] }],
      });
    },
  });
  assert.deepEqual(await extract({ pdf: Buffer.from('%PDF-1.7\nexample'), course: task.course, year: 2026 }), [task]);
  assert.equal(sent.store, false);
  assert.equal(sent.text.format.strict, true);
  assert.match(sent.input[0].content[1].file_data, /^data:application\/pdf;base64,/);
  modelResult = { items: [{ title: task.title, kind: task.kind, date: '2026-17-01', time: null }] };
  await assert.rejects(extract({ text: 'A deadline', course: task.course, year: 2026 }), /invalid/i);
});

async function fixture(t, options) {
  const store = openStore(':memory:');
  const app = createApp({ store, appOrigin: 'http://localhost:3000', now: () => date, ...options });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(() => { store.close(); resolve(); })));
  const url = 'http://127.0.0.1:' + server.address().port;
  const sessions = new Map();

  function request(path, { cookie, body, pdf, origin = 'http://localhost:3000', sessionId = sessions.get(cookie) } = {}) {
    const post = body !== undefined || pdf !== undefined;
    return fetch(url + path, {
      redirect: 'manual',
      method: post ? 'POST' : 'GET',
      headers: {
        ...(cookie && { cookie }),
        ...(sessionId && { 'X-DeadlineHub-Session': sessionId }),
        ...(post && { origin, 'content-type': pdf === undefined ? 'application/json' : 'application/pdf' }),
      },
      body: post ? pdf ?? JSON.stringify(body) : undefined,
    });
  }

  async function beginGoogle() {
    const response = await request('/auth/google');
    const url = new URL(response.headers.get('location'));
    return { url, state: url.searchParams.get('state'), nonce: url.searchParams.get('nonce'), cookie: response.headers.get('set-cookie').split(';')[0] };
  }

  function finishGoogle(attempt, code, state = attempt.state) {
    return request('/auth/google/callback?' + new URLSearchParams({ code, state }), { cookie: attempt.cookie });
  }

  async function demo() {
    const response = await request('/auth/demo', { body: {} });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie').split(';')[0];
    sessions.set(cookie, (await response.json()).user.sessionId);
    return cookie;
  }

  return { request, demo, beginGoogle, finishGoogle };
}

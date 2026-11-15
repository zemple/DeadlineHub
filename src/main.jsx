import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { request } from './api.js';
import { EntryDialog } from './EntryDialog.jsx';
import './styles.css';

const authChange = 'deadlinehub-auth-change';
function announceSessionChange() {
  try {
    localStorage.setItem(authChange, crypto.randomUUID());
  } catch {
    // The tab will still recheck the session when it gains focus.
  }
}

const loginErrors = {
  domain: 'Use a verified University of Illinois Google account ending in @illinois.edu.',
  state: 'This sign-in attempt expired. Start again.',
  cancelled: 'Sign-in was canceled. You can try again whenever you’re ready.',
  google: 'Google sign-in could not finish. Try again or check the OAuth configuration.',
  setup: 'Google sign-in needs the app’s OAuth credentials.',
};

const month = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' });
const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' });
const dateTime = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: 'numeric', timeZone: 'UTC' });

function Brand() {
  return (
    <span className="brand">
      <span className="brand-mark" aria-hidden="true"><span /><span /><span /></span>
      DeadlineHub
    </span>
  );
}

function Login({ session, onSignedIn }) {
  const [error, setError] = useState(() => {
    const code = new URLSearchParams(window.location.search).get('login');
    return loginErrors[code] || '';
  });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (new URLSearchParams(location.search).has('login')) window.history.replaceState({}, '', '/');
  }, []);

  async function demo() {
    setBusy(true);
    setError('');
    try {
      const { user } = await request('/auth/demo', { json: {} });
      onSignedIn(user);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <div className="login-main">
        <Brand />
        <div className="login-content">
          <h1>All your course deadlines in one place.</h1>
          <p>Import a syllabus or add a due date in one line. Sign in with your Illinois Google account to open your private agenda.</p>
          {session.googleEnabled
            ? <a className="button primary google" href="/auth/google"><span aria-hidden="true" className="google-mark">G</span> Sign in with Google</a>
            : <p className="error" role="status">Google sign-in isn’t configured on this server.</p>}
          <p className="login-domain">@illinois.edu accounts</p>
          {session.demoEnabled && <button type="button" className="text-button demo-button" disabled={busy} onClick={demo}>{busy ? 'Opening demo…' : 'Open local demo'}</button>}
          {error && <p className="error" role="alert">{error}</p>}
        </div>
      </div>
      <div className="login-preview" aria-hidden="true">
        <div className="preview-paper">
          <div className="paper-heading">Sample agenda</div>
          <div className="paper-row"><span>20 <small>NOV</small></span><div><b>MP 4: React application</b><small>CS 409 · 11:59 PM</small></div></div>
          <div className="paper-row"><span>23 <small>NOV</small></span><div><b>Transformer report</b><small>CS 447 · 5:00 PM</small></div></div>
          <div className="paper-row"><span>04 <small>DEC</small></span><div><b>Final project prototype</b><small>CS 409 · 5:00 PM</small></div></div>
        </div>
      </div>
    </main>
  );
}

function Agenda({ deadlines, filter, changeFilter, onImport }) {
  const filtered = filter === 'all' ? deadlines : deadlines.filter((row) => row.course === filter);
  const grouped = Map.groupBy(filtered, (row) => row.date);
  const courses = [...new Set(deadlines.map((item) => item.course))].sort();
  return (
    <section className="agenda" aria-labelledby="agenda-title">
      <div className="agenda-head">
        <div>
          <h2 id="agenda-title">Your deadlines</h2>
          <p>{filtered.length} {filtered.length === 1 ? 'deadline' : 'deadlines'} · Central Time</p>
        </div>
        {courses.length > 0 && (
          <select aria-label="Filter by course" value={filter} onChange={(event) => changeFilter(event.target.value)}>
            <option value="all">All courses</option>
            {courses.map((course) => <option key={course}>{course}</option>)}
          </select>
        )}
      </div>
      {filtered.length === 0 ? (
        <div className="empty">
          <span className="empty-mark" aria-hidden="true">＋</span>
          <h3>No deadlines yet</h3>
          <p>Import a syllabus or use Quick add to put your first deadline here.</p>
          <button className="text-button" onClick={onImport}>Import a syllabus <span aria-hidden="true">↗</span></button>
        </div>
      ) : (
        <ol className="day-groups">
          {[...grouped].map(([day, rows]) => {
            const date = new Date(day + 'T00:00:00Z');
            const dayOfWeek = weekday.format(date);
            return (
              <li key={day} className="day-group">
                <div className="date-block">
                  <time dateTime={day} aria-label={day}>{Number(day.slice(-2))} <span>{month.format(date)}</span></time>
                  <span>{dayOfWeek}</span>
                </div>
                <ul className="deadline-rows">
                  {rows.map((row) => (
                    <li className="deadline-row" key={row.id}>
                      <div>
                        <h3>{row.title}</h3>
                        <div className="row-meta"><span className="course-chip">{row.course}</span><span>{row.kind}</span></div>
                      </div>
                      <span className="due-time">{row.time ? dateTime.format(new Date(day + 'T' + row.time + ':00Z')) : 'Time unspecified'}</span>
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function Dashboard({ user, onSignOut, onExpired }) {
  const [deadlines, setDeadlines] = useState(null);
  const [filter, setFilter] = useState('all');
  const [mode, setMode] = useState(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const api = React.useCallback((path, options) => request(path, { ...options, sessionId: user.sessionId }), [user.sessionId]);

  useEffect(() => {
    let active = true;
    api('/api/deadlines').then((result) => { if (active) setDeadlines(result.deadlines); })
      .catch((failure) => {
        if (!active) return;
        if ([401, 409].includes(failure.status)) onExpired();
        else setError(failure.message);
      });
    return () => { active = false; };
  }, [api, onExpired]);

  async function logout() {
    setError('');
    try {
      await api('/auth/logout', { json: {} });
      onSignOut();
    } catch (failure) {
      if ([401, 409].includes(failure.status)) onExpired();
      else setError(failure.message);
    }
  }

  function imported(result) {
    setDeadlines(result.deadlines);
    setFilter('all');
    setMode(null);
    setNotice(result.added ? 'Saved ' + result.added + (result.added === 1 ? ' deadline.' : ' deadlines.') : 'These deadlines are already in your agenda.');
  }

  return (
    <>
      <header className="topbar">
        <div className="topbar-content">
          <Brand />
          <div className="account">
            <span className="avatar" aria-hidden="true">{user.name.charAt(0).toUpperCase()}</span>
            <div className="account-name"><b>{user.name}</b>{user.email && <span>{user.email}</span>}</div>
            <button type="button" className="text-button" onClick={logout}>Sign out</button>
          </div>
        </div>
      </header>
      <main className="workspace">
        <div className="workspace-heading">
          <div>
            <h1>Course agenda</h1>
            <p>All your assignments and exams, by due date.</p>
          </div>
          <div className="header-actions">
            <button className="button secondary" onClick={() => setMode('quick')}><span aria-hidden="true">＋</span> Quick add</button>
            <button className="button primary" onClick={() => setMode('import')}><span aria-hidden="true">↑</span> Import syllabus</button>
          </div>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        {notice && <p className="notice" role="status">{notice}</p>}
        {deadlines !== null && <Agenda deadlines={deadlines} filter={filter} changeFilter={setFilter} onImport={() => setMode('import')} />}
        {deadlines === null && !error && <p role="status">Loading deadlines…</p>}
      </main>
      {mode && <EntryDialog api={api} mode={mode} onClose={() => setMode(null)} onSaved={imported} onSessionExpired={onExpired} />}
    </>
  );
}

function App() {
  const [session, setSession] = useState(null);
  const [error, setError] = useState('');
  const latestCheck = React.useRef(0);

  const refreshSession = React.useCallback(async () => {
    const check = ++latestCheck.current;
    try {
      const next = await request('/api/session');
      if (check !== latestCheck.current) return;
      setSession(next);
      setError('');
    } catch (failure) {
      if (check === latestCheck.current) {
        setSession(null);
        setError(failure.message);
      }
    }
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('login') === 'success') {
      window.history.replaceState({}, '', '/');
      announceSessionChange();
    }
    function onStorage(event) {
      if (event.key !== authChange) return;
      setSession(null);
      refreshSession();
    }
    function onVisibility() {
      if (document.visibilityState === 'visible') refreshSession();
    }
    refreshSession();
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', refreshSession);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', refreshSession);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refreshSession]);

  function changeUser(user) {
    ++latestCheck.current;
    setSession((current) => ({ ...current, user }));
    announceSessionChange();
  }

  const onExpired = React.useCallback(() => {
    setSession(null);
    refreshSession();
  }, [refreshSession]);

  if (!session) return <main className="loading"><Brand /><p role="status">{error || 'Opening DeadlineHub…'}</p></main>;
  if (!session.user) return <Login session={session} onSignedIn={changeUser} />;
  return <Dashboard key={session.user.sessionId} user={session.user} onSignOut={() => changeUser(null)} onExpired={onExpired} />;
}

createRoot(document.getElementById('root')).render(<App />);

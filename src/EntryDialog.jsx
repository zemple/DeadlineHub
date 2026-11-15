import React, { useEffect, useRef, useState } from 'react';

const labels = { assignment: 'Assignment', exam: 'Exam', project: 'Project', other: 'Other' };
const campusYear = () => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric' }).format();

export function EntryDialog({ mode, api, onClose, onSaved, onSessionExpired }) {
  const dialog = useRef(null);
  const inputHeading = useRef(null);
  const [method, setMethod] = useState('pdf');
  const [course, setCourse] = useState('');
  const [year, setYear] = useState(campusYear);
  const [text, setText] = useState('');
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [sample, setSample] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const quick = mode === 'quick';

  useEffect(() => {
    const element = dialog.current;
    element.showModal();
    return () => element.close();
  }, []);

  const isReviewing = preview !== null;
  useEffect(() => {
    if (isReviewing) inputHeading.current?.focus();
  }, [isReviewing]);

  async function run(action) {
    setError('');
    setBusy(true);
    try {
      await action();
    } catch (failure) {
      if ([401, 409].includes(failure.status)) onSessionExpired();
      else setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  function updatePreview(items, example = false) {
    setSample(example);
    setPreview(items.map((item, index) => ({ ...item, key: index })));
  }

  function extract(event) {
    event.preventDefault();
    run(async () => {
      let result;
      if (quick) {
        result = await api('/api/quick-add/preview', { json: { text } });
      } else if (method === 'pdf') {
        if (!file) throw new Error('Choose a PDF to continue.');
        if (file.size > 5 * 1024 * 1024) throw new Error('Choose a PDF up to 5 MB.');
        const params = new URLSearchParams({ course, year });
        result = await api('/api/syllabus/preview/pdf?' + params, { pdf: file });
      } else {
        result = await api('/api/syllabus/preview/text', { json: { text, course, year } });
      }
      updatePreview(result.items);
    });
  }

  function loadSample() {
    run(async () => {
      const result = await api('/api/syllabus/sample');
      updatePreview(result.items, true);
    });
  }

  function update(key, field, value) {
    setPreview((items) => items.map((item) => item.key === key ? { ...item, [field]: value } : item));
  }

  function save(event) {
    event.preventDefault();
    run(async () => {
      const items = preview.map(({ key, ...item }) => ({ ...item, time: item.time || null }));
      const result = await api('/api/deadlines', { json: { items } });
      onSaved(result);
    });
  }

  function back() {
    setPreview(null);
    setError('');
  }

  return (
    <dialog ref={dialog} className="entry-dialog" aria-labelledby="dialog-title"
      onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
      <div className="dialog-head">
        <h2 id="dialog-title">{quick ? 'Quick add' : 'Import syllabus'}</h2>
        <button type="button" className="icon-button" aria-label="Close" disabled={busy} onClick={onClose}>×</button>
      </div>
      {preview === null ? (
        <form className="dialog-form" onSubmit={extract}>
          {quick ? (
            <>
              <label className="field">
                Describe your deadline
                <input autoFocus required value={text} onChange={(event) => setText(event.target.value)}
                  placeholder="CS 409 MP due next Friday 11:59pm" maxLength={400} />
              </label>
              <p className="hint">Include the course, a title and a due date. Times are in Central Time.</p>
            </>
          ) : (
            <>
              <div className="field-pair">
                <label className="field">
                  Course code
                  <input autoFocus required placeholder="CS 409" value={course} maxLength={20} onChange={(event) => setCourse(event.target.value)} />
                </label>
                <label className="field">
                  Year for dates without one
                  <input required aria-label="Academic year" type="number" min={1900} max={2200} value={year} onChange={(event) => setYear(event.target.value)} />
                </label>
              </div>
              <div className="segmented" aria-label="Syllabus format">
                <button type="button" aria-pressed={method === 'pdf'} onClick={() => setMethod('pdf')}>Upload PDF</button>
                <button type="button" aria-pressed={method === 'text'} onClick={() => setMethod('text')}>Paste text</button>
              </div>
              {method === 'pdf' ? (
                <label className="field file-field">
                  Choose syllabus PDF
                  <input type="file" accept=".pdf,application/pdf" required={!file} onChange={(event) => setFile(event.target.files[0] ?? null)} />
                  <span className="hint">{file ? 'Selected: ' + file.name : 'PDF up to 5 MB'}</span>
                </label>
              ) : (
                <label className="field">
                  Syllabus text
                  <textarea required rows={6} maxLength={45000} value={text} placeholder="Paste the course schedule or syllabus here…" onChange={(event) => setText(event.target.value)} />
                </label>
              )}
              <p className="hint">Your syllabus is sent to OpenAI for deadline extraction.</p>
            </>
          )}
          {error && <p className="error" role="alert">{error}</p>}
          <div className="dialog-actions">
            {!quick && <button type="button" className="text-button" disabled={busy} onClick={loadSample}>Try sample syllabus</button>}
            <button className="button primary" disabled={busy}>{busy ? (quick ? 'Checking date…' : 'Reading syllabus…') : (quick ? 'Preview deadline' : 'Extract deadlines')}</button>
          </div>
        </form>
      ) : (
        <form className="dialog-form" onSubmit={save}>
          <div className="preview-intro">
            <h3 ref={inputHeading} tabIndex={-1}>{sample ? 'Sample syllabus preview' : 'Review deadlines'}</h3>
            <p className="hint">{preview.length ? 'Check the dates and edit or remove entries before saving. Times are in Central Time.' : 'No dated entries to save. Go back and try a syllabus section with explicit dates.'}</p>
          </div>
          <div className="review-list">
            {preview.map((item, index) => (
              <fieldset className="review-item" key={item.key}>
                <legend>Deadline {index + 1}</legend>
                <div className="review-top">
                  <label className="field">
                    Title
                    <input required value={item.title} maxLength={160} onChange={(event) => update(item.key, 'title', event.target.value)} />
                  </label>
                  <button type="button" className="text-button remove" aria-label={'Remove ' + item.title}
                    disabled={busy} onClick={() => setPreview((items) => items.filter(({ key }) => key !== item.key))}>Remove</button>
                </div>
                <div className="review-fields">
                  <label className="field">
                    Course
                    <input required value={item.course} maxLength={20} onChange={(event) => update(item.key, 'course', event.target.value)} />
                  </label>
                  <label className="field">
                    Type
                    <select value={item.kind} onChange={(event) => update(item.key, 'kind', event.target.value)}>
                      {Object.entries(labels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                    </select>
                  </label>
                  <label className="field">
                    Date
                    <input required type="date" value={item.date} onChange={(event) => update(item.key, 'date', event.target.value)} />
                  </label>
                  <label className="field">
                    Time
                    <input type="time" value={item.time ?? ''} onChange={(event) => update(item.key, 'time', event.target.value)} />
                  </label>
                </div>
              </fieldset>
            ))}
          </div>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="dialog-actions">
            <button type="button" className="button secondary" disabled={busy} onClick={back}>Back</button>
            <button className="button primary" disabled={busy || !preview.length}>
              {busy ? 'Saving…' : ('Save ' + preview.length + (preview.length === 1 ? ' deadline' : ' deadlines'))}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}

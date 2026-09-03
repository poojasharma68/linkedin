'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { parseUrlList } from '@/lib/validate';

// Kept out of the <form> element on purpose: a nested form is invalid HTML and
// the inner button would submit the outer one.
function AddOption({ kind, label, onAdd }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!name.trim() || busy) return;
    setBusy(true);
    const ok = await onAdd(kind, name.trim());
    setBusy(false);
    if (ok) {
      setName('');
      setOpen(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="link" onClick={() => setOpen(true)}>
        + {label}
      </button>
    );
  }

  return (
    <span className="add-option">
      <input
        value={name}
        autoFocus
        placeholder={label}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            submit();
          }
          if (event.key === 'Escape') setOpen(false);
        }}
      />
      <button type="button" onClick={submit} disabled={busy}>
        {busy ? 'Adding…' : 'Add'}
      </button>
      <button type="button" className="link" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </span>
  );
}

function CheckboxGroup({ options, selected, onToggle }) {
  return (
    <div className="options">
      {options.map((option) => (
        <label key={option.id} className={selected.includes(option.id) ? 'on' : ''}>
          <input
            type="checkbox"
            checked={selected.includes(option.id)}
            onChange={() => onToggle(option.id)}
          />
          {option.name}
        </label>
      ))}
    </div>
  );
}

// One row of the session list. The screenshot is behind a toggle rather than
// shown outright: this page is for filing posts, and the image is only needed
// when you want to check a capture came out right.
function SessionEntry({ entry }) {
  const [showing, setShowing] = useState(false);

  // A batch reports its failures here rather than only in the summary line:
  // with twelve URLs in one run, "3 failed" is no use without saying which.
  if (entry.error) {
    return (
      <li className="failed">
        <span className="session-url">{entry.url}</span>
        <span className="session-error">{entry.error}</span>
      </li>
    );
  }

  return (
    <li>
      <span className="session-url">{entry.url}</span>
      <span className="session-places">{entry.places.join('  |  ')}</span>
      <span className="session-actions">
        {entry.captured ? 'Captured' : 'Reused existing screenshot'}
        {' · '}
        <button type="button" className="link" onClick={() => setShowing((on) => !on)}>
          {showing ? 'Hide screenshot' : 'See screenshot'}
        </button>
        {' · '}
        <a href={entry.screenshotUrl} target="_blank" rel="noreferrer">
          Open in new tab
        </a>
      </span>
      {showing && <img className="session-shot" src={entry.screenshotUrl} alt="" />}
    </li>
  );
}

export default function PostForm({ programmes: seedProgrammes, tabs: seedTabs, links: seedLinks }) {
  const router = useRouter();
  const [programmes, setProgrammes] = useState(seedProgrammes);
  const [tabs, setTabs] = useState(seedTabs);
  const [links, setLinks] = useState(seedLinks);
  const [programmeIds, setProgrammeIds] = useState([]);
  const [tabIds, setTabIds] = useState([]);
  const [urlText, setUrlText] = useState('');
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [recapture, setRecapture] = useState(false);
  // What this session has filed. Held in component state on purpose: a refresh
  // wipes it, because the page never reads filed posts back from the server.
  const [added, setAdded] = useState([]);
  // Two rows of one batch can finish in the same millisecond, so a timestamp
  // is not a safe React key here.
  const nextEntryId = useRef(0);

  // Parsed on every keystroke so the count under the box is exactly what a
  // click will submit — the same function the submit handler uses, rather than
  // a second rule that could drift from it.
  const parsed = parseUrlList(urlText);

  // Only the tabs the ticked programmes actually have — plus anything already
  // ticked, so changing programmes never leaves a selection you can't see.
  // With no programme ticked yet there is nothing to narrow by, so show all.
  const visibleTabs = programmeIds.length
    ? tabs.filter(
        (tab) =>
          tabIds.includes(tab.id) ||
          links.some((link) => programmeIds.includes(link.programme_id) && link.tab_id === tab.id)
      )
    : tabs;

  function toggle(setter) {
    return (id) =>
      setter((ids) => (ids.includes(id) ? ids.filter((each) => each !== id) : [...ids, id]));
  }

  function record(entry) {
    setAdded((current) => [{ ...entry, key: (nextEntryId.current += 1) }, ...current]);
  }

  async function addOption(kind, name) {
    setError('');
    const response = await fetch('/api/taxonomy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // A new tab belongs to the programmes being filed right now; a new
      // programme starts with the full tab list, which the server decides.
      body: JSON.stringify({ kind, name, programme_ids: programmeIds }),
    });
    const body = await response.json();

    if (!response.ok) {
      setError(body.error);
      return false;
    }

    setLinks((current) => [...current, ...body.links]);

    // Tick the new one straight away — you only add it because this post
    // belongs there.
    if (kind === 'programme') {
      setProgrammes((current) => [...current, body]);
      setProgrammeIds((ids) => [...ids, body.id]);
    } else {
      setTabs((current) => [...current, body]);
      setTabIds((ids) => [...ids, body.id]);
    }
    router.refresh();
    return true;
  }

  // One URL, one request. The fan-out over a pasted list runs here in the
  // browser rather than sending the whole list to the route, because a single
  // capture can take most of a minute and /api/posts is capped at 60s — a
  // batch of twelve in one request would be killed part-way through with no
  // way to tell which posts had made it. A request each also means a dead URL
  // costs only itself, and every screenshot appears as it lands instead of
  // the whole run arriving at the end.
  async function fileOne(postUrl) {
    try {
      const response = await fetch('/api/posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: postUrl,
          programme_ids: programmeIds,
          tab_ids: tabIds,
          recapture,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) return { error: body.error ?? `Request failed (${response.status})` };
      return { body };
    } catch (err) {
      // A capture that outruns the platform's limit drops the connection
      // rather than returning a status, so it arrives here as a network error.
      return { error: err.message };
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (saving) return;

    setError('');
    setNotice('');

    const { urls, invalid } = parsed;

    if (!urls.length) {
      setError(
        invalid.length
          ? `No LinkedIn post URLs in that list. Check: ${invalid.join(', ')}`
          : 'Paste at least one LinkedIn post URL.'
      );
      return;
    }
    if (!programmeIds.length || !tabIds.length) {
      setError('Tick at least one programme and one tab.');
      return;
    }

    // Every post in the run is filed in the same places, so build the label
    // once rather than per post.
    const places = programmeIds.flatMap((programmeId) =>
      tabIds.map(
        (tabId) =>
          `${programmes.find((p) => p.id === programmeId)?.name} · ${
            tabs.find((t) => t.id === tabId)?.name
          }`
      )
    );

    setSaving(true);
    setProgress({ done: 0, total: urls.length });

    // Anything that does not get filed goes back in the box, so a second click
    // retries what is left instead of re-capturing what already worked.
    const remaining = [...invalid];
    for (const entry of invalid) record({ url: entry, error: 'Not a LinkedIn post URL.' });

    let filed = 0;
    for (const [index, postUrl] of urls.entries()) {
      setProgress({ done: index, total: urls.length });
      const result = await fileOne(postUrl);

      if (result.error) {
        remaining.push(postUrl);
        record({ url: postUrl, error: result.error });
      } else {
        filed += 1;
        record({
          url: postUrl,
          places,
          captured: result.body.captured,
          screenshotUrl: result.body.screenshot_url,
        });
      }
    }

    setUrlText(remaining.join('\n'));

    if (filed) {
      setNotice(
        `Filed ${filed} post${filed === 1 ? '' : 's'} in ${places.length} place${
          places.length === 1 ? '' : 's'
        } each.`
      );
      // Only a clean run clears the ticks: if something is going back in the
      // box to be retried, that retry needs the same programmes and tabs still
      // selected.
      if (!remaining.length) {
        setProgrammeIds([]);
        setTabIds([]);
      }
      router.refresh();
    }

    if (remaining.length) {
      setError(
        `${remaining.length} not filed — left in the box to try again. Each one's reason is below.`
      );
    }

    setProgress(null);
    setSaving(false);
  }

  const count = parsed.urls.length;

  return (
    <>
    <form onSubmit={handleSubmit}>
      <label className="field">
        <span>Post URLs</span>
        <textarea
          required
          rows={5}
          value={urlText}
          disabled={saving}
          onChange={(event) => setUrlText(event.target.value)}
          placeholder={'https://www.linkedin.com/posts/...\nhttps://www.linkedin.com/posts/...'}
        />
        <span className="hint">
          One per line. {count} link{count === 1 ? '' : 's'} ready
          {parsed.invalid.length > 0 && `, ${parsed.invalid.length} not recognised`}. Duplicates and
          tracking parameters are ignored.
        </span>
      </label>

      <div className="field">
        <span>
          Programmes <AddOption kind="programme" label="New programme" onAdd={addOption} />
        </span>
        <CheckboxGroup
          options={programmes}
          selected={programmeIds}
          onToggle={toggle(setProgrammeIds)}
        />
      </div>

      <div className="field">
        <span>
          Tabs <AddOption kind="tab" label="New tab" onAdd={addOption} />
        </span>
        <CheckboxGroup options={visibleTabs} selected={tabIds} onToggle={toggle(setTabIds)} />
      </div>

      <label className="checkline">
        <input
          type="checkbox"
          checked={recapture}
          onChange={(event) => setRecapture(event.target.checked)}
        />
        Take a fresh screenshot even if this URL is already saved
      </label>

      <p className="hint">
        Every post in the list is filed under every ticked programme paired with every ticked tab. A
        programme that doesn&apos;t have one of these tabs yet gains it.
      </p>

      <button disabled={saving}>
        {saving
          ? `Capturing ${progress.done + 1} of ${progress.total}…`
          : `Add ${count > 1 ? `${count} posts` : 'post'}`}
      </button>

      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}
    </form>

    {added.length > 0 && (
      <section className="session">
        <p className="hint">Added in this session. Refreshing clears this list.</p>
        <ul>
          {added.map((entry) => (
            <SessionEntry key={entry.key} entry={entry} />
          ))}
        </ul>
      </section>
    )}
    </>
  );
}

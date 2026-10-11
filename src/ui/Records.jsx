import React, { useEffect, useRef, useState } from 'react';
import { Check, Cpu, Download, Play, Trash2, Upload, UserRound } from 'lucide-react';
import { TOOLS } from '../sim/tools.mjs';
import { ROLE_COPY, displaySpeech, outcomeSummary, recordPerspective } from './play.mjs';
import { Button, IconButton, Segmented } from './kit.jsx';
import { Drawer } from './Overlays.jsx';

function TranscriptEvent({ event: ev, previous, humanName = 'You' }) {
  const human = ev.kind === 'human',
    system = ev.kind === 'system',
    speech = Boolean(ev.speech),
    tool = TOOLS.find((t) => t.name === ev.action);
  return (
    <>
      {ev.turn !== previous?.turn && <div className="log-turn">Turn {ev.turn}</div>}
      <div
        className={`log-event ${human ? 'is-human' : system ? 'is-system' : 'is-robot'} ${
          ev.valid === false ? 'is-failed' : ''
        } ${ev.unseen ? 'is-unseen' : ''}`}
      >
        <span className="log-avatar" aria-hidden="true">
          {human ? <UserRound size={14} /> : <Cpu size={14} />}
        </span>
        <div className="log-content">
          <div className="log-meta">
            <strong>{human ? humanName : system ? 'Room' : 'G-01'}</strong>
            {ev.unseen ? (
              <span>Unseen</span>
            ) : (
              !speech && !human && !system && <span>{tool?.label || ev.action}</span>
            )}
            {ev.timing?.fallback && <span className="log-fallback">no valid action · held</span>}
            {ev.timing && Number.isFinite(ev.timing.decisionMs) && (
              <span className="log-timing">
                {(ev.timing.decisionMs / 1000).toFixed(1)}s
                {Number.isFinite(ev.timing.reactionMs)
                  ? ` · reaction ${(ev.timing.reactionMs / 1000).toFixed(1)}s`
                  : ''}
              </span>
            )}
          </div>
          <p className={speech ? 'log-speech' : ''}>
            {speech ? `“${displaySpeech(ev.text)}”` : ev.text}
          </p>
        </div>
      </div>
    </>
  );
}

export function LogDrawer({ events, thinking, observation, onClose, onExport, humanName }) {
  const [view, setView] = useState('log');
  const scroll = useRef(null);
  useEffect(() => {
    scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' });
  }, [events.length, thinking, view]);
  return (
    <Drawer
      title="Log"
      onClose={onClose}
      className="log-drawer"
      actions={
        onExport && (
          <Button
            variant="ghost"
            size="sm"
            icon={Download}
            onClick={onExport}
            disabled={!events.length}
          >
            Export
          </Button>
        )
      }
    >
      {observation && (
        <Segmented
          size="sm"
          label="Log view"
          value={view}
          onChange={setView}
          options={[
            { value: 'log', label: 'What happened' },
            { value: 'sensors', label: 'What G-01 senses' },
          ]}
        />
      )}
      <div className="log-scroll" ref={scroll}>
        {view === 'sensors' && observation ? (
          <>
            <p className="muted small">
              The guard gets this snapshot each turn. Your role isn’t in it.
            </p>
            <pre className="code-block">{JSON.stringify(observation, null, 2)}</pre>
          </>
        ) : events.length === 0 ? (
          <p className="log-empty">Nothing has happened yet.</p>
        ) : (
          events.map((ev, i) => (
            <TranscriptEvent
              key={ev.id || i}
              event={ev}
              previous={events[i - 1]}
              humanName={humanName}
            />
          ))
        )}
        {view === 'log' && thinking && (
          <div className="log-thinking">
            <span className="thinking-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            G-01 is thinking
          </div>
        )}
      </div>
    </Drawer>
  );
}

function recordTitle(record) {
  if (record.mode === 'showcase') return 'All tools & animations';
  if (!record.state?.ended) return 'Unfinished game';
  return outcomeSummary(record.state, {
    perspective: recordPerspective(record),
    role: record.role,
  }).title;
}

// Opening a record mid-game (confirmOpen) and deleting one each take a second click.
export function PastGames({ records, onOpen, onImport, onClose, onDelete, confirmOpen }) {
  const input = useRef(null);
  const [armed, setArmed] = useState(null);
  return (
    <Drawer
      title="Past games"
      onClose={onClose}
      className="records-drawer"
      actions={
        <Button variant="ghost" size="sm" icon={Upload} onClick={() => input.current?.click()}>
          Import
        </Button>
      }
    >
      <input
        ref={input}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(e) => {
          onImport(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      {records.length === 0 ? (
        <p className="log-empty">Finished games show up here.</p>
      ) : (
        <ul className="record-list">
          {records.map((record) => {
            const showcase = record.mode === 'showcase';
            const date = record.createdAt ? new Date(record.createdAt) : null;
            const opening = armed === 'open:' + record.id,
              deleting = armed === 'delete:' + record.id;
            return (
              <li key={record.id} className="record-row">
                <button
                  type="button"
                  className={`record ${opening ? 'is-armed' : ''}`}
                  onClick={() => {
                    if (confirmOpen && !opening) setArmed('open:' + record.id);
                    else onOpen(record);
                  }}
                >
                  <span className="record-main">
                    <strong>{recordTitle(record)}</strong>
                    <span>
                      {opening
                        ? confirmOpen
                        : showcase
                          ? 'A guided tour of every guard tool'
                          : [
                              ROLE_COPY[record.role]?.name,
                              `${record.state?.turn ?? 0} turn${record.state?.turn === 1 ? '' : 's'}`,
                              date && !Number.isNaN(date.getTime())
                                ? date.toLocaleDateString(undefined, {
                                    month: 'short',
                                    day: 'numeric',
                                  })
                                : null,
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                    </span>
                  </span>
                  <Play size={16} strokeWidth={1.75} aria-hidden="true" />
                </button>
                {onDelete && showcase && <span className="record-delete" aria-hidden="true" />}
                {onDelete && !showcase && (
                  <IconButton
                    icon={deleting ? Check : Trash2}
                    label={deleting ? 'Click again to delete' : 'Delete this game'}
                    className={`record-delete ${deleting ? 'is-armed' : ''}`}
                    onClick={() => {
                      if (!deleting) setArmed('delete:' + record.id);
                      else {
                        setArmed(null);
                        onDelete(record);
                      }
                    }}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Drawer>
  );
}

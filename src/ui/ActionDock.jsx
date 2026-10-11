import React, { useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  Ellipsis,
  Hourglass,
  Map as MapIcon,
  MessageSquare,
  Send,
  X,
} from 'lucide-react';
import { humanDock, ZONE_INFO } from './play.mjs';
import { actionIcon, ITEM_ICONS } from './icons.jsx';
import { Button, Popover } from './kit.jsx';
import { MiniMap } from './MiniMap.jsx';
import { isTyping } from './hooks.mjs';
import { submitSpeechOnEnter } from './keyboard.mjs';

function DockButton({ item, disabled, onAct, onKeypad }) {
  const Icon = actionIcon(item.icon);
  return (
    <Button
      variant={item.primary ? 'primary' : item.tone === 'danger' ? 'danger' : 'secondary'}
      icon={Icon}
      disabled={disabled || item.disabled}
      title={item.title}
      onClick={() => (item.keypad ? onKeypad() : onAct(item.action, item.args))}
    >
      {item.label}
    </Button>
  );
}

export function SayBox({ value, onChange, onSend, onClose, canSend, placeholder, extra }) {
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <form
      className="say-box"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSend && value.trim()) onSend(value.trim());
      }}
    >
      <textarea
        ref={ref}
        rows={1}
        maxLength={2000}
        aria-label="What to say"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          } else submitSpeechOnEnter(e);
        }}
      />
      {extra}
      <Button type="submit" variant="primary" icon={Send} disabled={!canSend || !value.trim()}>
        {canSend ? 'Send' : 'Wait…'}
      </Button>
      <button type="button" className="say-close" aria-label="Close" onClick={onClose}>
        <X size={16} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </form>
  );
}

function Keypad({ onSubmit, onClose }) {
  const [code, setCode] = useState('');
  return (
    <form
      className="keypad"
      onSubmit={(e) => {
        e.preventDefault();
        if (code.length === 4) onSubmit(code);
      }}
    >
      <label className="keypad-label" htmlFor="safe-code">
        Safe code
      </label>
      <input
        id="safe-code"
        autoFocus
        inputMode="numeric"
        autoComplete="off"
        maxLength={4}
        placeholder="••••"
        value={code}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 4))}
      />
      <Button type="submit" variant="primary" disabled={code.length !== 4}>
        Try code
      </Button>
    </form>
  );
}

export function ActionDock({
  state,
  role,
  yourTurn,
  canDraft,
  onAct,
  panel,
  onPanel,
  draft,
  onDraft,
  talkHint,
}) {
  const dock = humanDock(state, role);
  const [run, setRun] = useState(false);
  const off = !yourTurn;
  const act = (action, args) => {
    onPanel(null);
    onAct(action, args);
  };
  const move = (zone) => act(run ? 'run' : 'move', { zone });
  const toggle = (name) => onPanel(panel === name ? null : name);
  const handlers = useRef({});
  handlers.current = { dock, off, panel, move, toggle, act, canDraft };
  useEffect(() => {
    const key = (event) => {
      const { dock, off, panel, move, toggle, act, canDraft } = handlers.current;
      if (isTyping(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      if (event.key === 'Escape' && panel) {
        event.preventDefault();
        onPanel(null);
        return;
      }
      if (event.repeat) return;
      if (event.code === 'KeyT' && canDraft) {
        event.preventDefault();
        onPanel('say');
      } else if (event.code === 'KeyW' && !off && dock.canWait) {
        event.preventDefault();
        act('wait');
      } else if (event.code === 'KeyM' && dock.canMove) {
        event.preventDefault();
        toggle('map');
      } else if (panel === 'map' && !off && dock.canMove && /^Digit[1-5]$/.test(event.code)) {
        const zone = ZONE_INFO.find((z) => z.key === event.code.slice(5));
        if (zone && zone.id !== state.human.zone) {
          event.preventDefault();
          move(zone.id);
        }
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [state.human.zone]);
  const ItemIcon = dock.item ? ITEM_ICONS[dock.item.icon] || actionIcon('hand') : null;
  const single = dock.item?.actions.length === 1 ? dock.item.actions[0] : null;
  return (
    <div className="dock-area">
      {panel === 'say' && (
        <SayBox
          value={draft}
          onChange={onDraft}
          canSend={yourTurn}
          placeholder="Say something to the guard…"
          onClose={() => onPanel(null)}
          onSend={(message) => {
            onDraft('');
            act('talk', { message });
          }}
        />
      )}
      {panel === 'map' && (
        <Popover className="dock-popover map-popover" label="Move">
          <MiniMap
            zone={state.human.zone}
            disabled={off}
            onMove={move}
            run={run}
            onRun={setRun}
            hasItem={state.human.hasItem}
          />
        </Popover>
      )}
      {panel === 'keypad' && (
        <Popover className="dock-popover" label="Enter the safe code">
          <Keypad onClose={() => onPanel(null)} onSubmit={(code) => act('combination', { code })} />
        </Popover>
      )}
      {panel === 'item' && dock.item && (
        <Popover className="dock-popover menu-popover" label={dock.item.label}>
          {dock.item.actions.map((a) => (
            <DockButton key={a.id} item={a} disabled={off} onAct={act} />
          ))}
        </Popover>
      )}
      {panel === 'more' && (
        <Popover className="dock-popover menu-popover" label="More actions">
          {dock.more.map((a) => (
            <DockButton key={a.id} item={a} disabled={off} onAct={act} />
          ))}
        </Popover>
      )}
      <div className={`dock ${off ? 'is-waiting' : ''}`} role="toolbar" aria-label="Your actions">
        {dock.stunned > 0 && (
          <span className="chip chip-danger">Stunned · talk only · {dock.stunned}</span>
        )}
        {dock.context.map((item) => (
          <DockButton
            key={item.id}
            item={item}
            disabled={off}
            onAct={act}
            onKeypad={() => toggle('keypad')}
          />
        ))}
        {dock.item &&
          (single ? (
            <DockButton item={{ ...single, icon: dock.item.icon }} disabled={off} onAct={act} />
          ) : (
            <Button
              icon={ItemIcon}
              iconRight={ChevronDown}
              disabled={off}
              className={panel === 'item' ? 'is-open' : ''}
              aria-expanded={panel === 'item'}
              onClick={() => toggle('item')}
            >
              {dock.item.label}
            </Button>
          ))}
        {dock.canMove && (
          <Button
            icon={MapIcon}
            disabled={off}
            hint="M"
            className={panel === 'map' ? 'is-open' : ''}
            aria-expanded={panel === 'map'}
            onClick={() => toggle('map')}
          >
            Move
          </Button>
        )}
        <Button
          icon={MessageSquare}
          disabled={!canDraft}
          hint={talkHint}
          className={`talk-button ${panel === 'say' ? 'is-open' : ''}`}
          aria-expanded={panel === 'say'}
          onClick={() => toggle('say')}
        >
          Talk
        </Button>
        {dock.more.length > 0 && (
          <button
            type="button"
            className={`icon-btn dock-more ${panel === 'more' ? 'is-active' : ''}`}
            aria-label="More actions"
            title="More actions"
            disabled={off}
            onClick={() => toggle('more')}
          >
            <Ellipsis size={18} strokeWidth={1.75} aria-hidden="true" />
          </button>
        )}
        {dock.canWait && (
          <Button
            variant="ghost"
            icon={Hourglass}
            disabled={off}
            hint="W"
            onClick={() => act('wait')}
          >
            Wait
          </Button>
        )}
      </div>
    </div>
  );
}

export function TurnState({ phase, onPause, onResume, label }) {
  if (!phase) return null;
  return (
    <div className={`turn-state turn-${phase}`} role="status" aria-live="polite">
      {phase === 'thinking' ? (
        <>
          <span className="thinking-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          {label || 'G-01 is thinking'}
          {onPause && (
            <button type="button" className="turn-action" onClick={onPause}>
              Pause
            </button>
          )}
        </>
      ) : phase === 'paused' ? (
        <>
          {label || 'G-01 hasn’t answered'}
          {onResume && (
            <button type="button" className="turn-action" onClick={onResume}>
              Resume
            </button>
          )}
        </>
      ) : (
        <>
          <i className="turn-dot" aria-hidden="true" />
          {label}
        </>
      )}
    </div>
  );
}

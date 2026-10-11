import React, { useEffect, useRef, useState } from 'react';
import { Menu, ScrollText, Settings, Volume2, VolumeX } from 'lucide-react';
import { RULES } from '../sim/rules.mjs';
import { Hearts, IconButton } from './kit.jsx';
import { useDismiss } from './hooks.mjs';

export function GoalChip({ goal, turn, tag }) {
  return (
    <div className="hud-goal">
      {goal && (
        <span className="goal-chip">
          <i className="dot dot-accent" aria-hidden="true" />
          <span className="goal-prefix">Goal:</span> {goal}
        </span>
      )}
      {tag && <span className="goal-chip goal-tag">{tag}</span>}
      {turn !== undefined && <span className="hud-turn">Turn {turn}</span>}
    </div>
  );
}

function useFlash(value) {
  const previous = useRef(value);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (value < previous.current) {
      setFlash(true);
      const timer = setTimeout(() => setFlash(false), 700);
      previous.current = value;
      return () => clearTimeout(timer);
    }
    previous.current = value;
  }, [value]);
  return flash;
}

function Vital({ name, value, max, known, accent }) {
  const flash = useFlash(known ? value : max);
  return (
    <span className={`vital ${accent ? 'vital-guard' : ''} ${flash ? 'is-hit' : ''}`}>
      <span className="vital-name">{name}</span>
      <Hearts value={value} max={max} known={known} label={name} />
    </span>
  );
}

export function Vitals({ state, humanKnown = true, robotKnown = true, humanName = 'You' }) {
  const h = state.human,
    r = state.robot;
  return (
    <div className="vitals">
      <Vital
        name={humanName}
        value={h.hearts ?? (h.health / 100) * RULES.humanHearts}
        max={RULES.humanHearts}
        known={humanKnown}
      />
      <Vital
        name="G-01"
        value={r.hearts ?? (r.health / 100) * RULES.robotHearts}
        max={RULES.robotHearts}
        known={robotKnown}
        accent
      />
    </div>
  );
}

export function HudMenu({ items }) {
  const [open, setOpen] = useState(false);
  // An item with `confirm` asks for a second click (leaving a game in progress).
  const [armed, setArmed] = useState(null);
  const root = useRef(null);
  useDismiss(open, () => setOpen(false));
  useEffect(() => {
    if (!open) setArmed(null);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (event) => {
      if (!root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  return (
    <div className="hud-menu" ref={root}>
      <IconButton
        icon={Menu}
        label="Menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      />
      {open && (
        <div className="menu" role="menu">
          {items.filter(Boolean).map((item) =>
            item.separator ? (
              <hr key={item.key} />
            ) : (
              <button
                type="button"
                role="menuitem"
                key={item.label}
                disabled={item.disabled}
                className={item.tone === 'danger' || armed === item.label ? 'is-danger' : ''}
                onClick={() => {
                  if (item.confirm && armed !== item.label) {
                    setArmed(item.label);
                    return;
                  }
                  setOpen(false);
                  item.onSelect();
                }}
              >
                {item.icon && <item.icon size={16} strokeWidth={1.75} aria-hidden="true" />}
                {armed === item.label ? item.confirm : item.label}
                {item.hint && <kbd className="kbd">{item.hint}</kbd>}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

export function HudButtons({ audio, onAudio, onLog, onSettings, menu, children }) {
  return (
    <div className="hud-buttons">
      {children}
      {onLog && <IconButton icon={ScrollText} label="Log" onClick={onLog} />}
      <IconButton
        icon={audio ? Volume2 : VolumeX}
        label={audio ? 'Mute sound' : 'Unmute sound'}
        onClick={onAudio}
      />
      <IconButton icon={Settings} label="Settings" onClick={onSettings} />
      {menu && <HudMenu items={menu} />}
    </div>
  );
}

export function StatusChips({ chips }) {
  const shown = chips.filter(Boolean);
  if (!shown.length) return null;
  return (
    <div className="status-chips">
      {shown.map((chip) => (
        <span key={chip.text} className={`chip chip-${chip.tone || 'muted'}`}>
          {chip.text}
        </span>
      ))}
    </div>
  );
}

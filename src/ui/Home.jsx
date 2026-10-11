import React from 'react';
import { ArrowRight, BadgeCheck, Check, ChevronRight, Cpu, VenetianMask } from 'lucide-react';
import { ITEMS } from '../sim/items.mjs';
import { ITEM_COPY, ITEM_NAMES, ROLE_COPY, roleDetail } from './play.mjs';
import { ITEM_ICONS } from './icons.jsx';
import { Button, Dot, Segmented, Toggle } from './kit.jsx';

const ROLE_ICONS = { 'employee-pass': BadgeCheck, 'thief-uniform': VenetianMask };

export function RoleCards({ role, onChange, compact, credential = true }) {
  return (
    <div
      className={`role-cards ${compact ? 'is-compact' : ''}`}
      role="radiogroup"
      aria-label="Role"
    >
      {Object.entries(ROLE_COPY).map(([id, copy]) => {
        const Icon = ROLE_ICONS[id];
        const selected = role === id;
        return (
          <button
            type="button"
            key={id}
            role="radio"
            aria-checked={selected}
            className={`choice-card role-card ${selected ? 'is-selected' : ''}`}
            onClick={() => onChange(id)}
          >
            <span className="role-card-head">
              <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
              <strong>{copy.name}</strong>
              {selected && (
                <span className="choice-check">
                  <Check size={14} strokeWidth={2.5} aria-hidden="true" />
                </span>
              )}
            </span>
            <span className="role-goal">{copy.goal}</span>
            {!compact && <span className="role-detail">{roleDetail(id, credential)}</span>}
          </button>
        );
      })}
    </div>
  );
}

// Always present, so switching objective never shifts the panel. Transit always has a pass.
export function CredentialPicker({ role, config, onChange }) {
  const heist = role === 'thief-uniform';
  return (
    <div className="credential-choice" title={heist ? undefined : 'Transit always carries one'}>
      <Toggle
        label="Carry a valid transit pass"
        checked={heist ? Boolean(config.credential) : true}
        disabled={!heist}
        onChange={(credential) => onChange({ credential })}
      />
    </div>
  );
}

export function GuardChip({ label, tone, onClick, prefix = 'Guard' }) {
  return (
    <button type="button" className="guard-chip" onClick={onClick} title="Change in Settings">
      <Cpu size={16} strokeWidth={1.75} aria-hidden="true" />
      <span className="guard-chip-prefix">{prefix}</span>
      <span className="guard-chip-label">{label}</span>
      <Dot tone={tone} />
      <ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" className="guard-chip-arrow" />
    </button>
  );
}

export function Home({
  role,
  config,
  onRole,
  onConfig,
  guard,
  onGuard,
  onStart,
  onAlternate,
  starting,
}) {
  const chosen = ITEMS.find((i) => i.id === config.item) || ITEMS[0];
  return (
    <section className="home-panel" aria-label="New game">
      <div className="home-step">
        <div className="step-head">
          <h2>Your private objective</h2>
          <Segmented
            size="sm"
            label="Appearance"
            value={config.appearance}
            onChange={(appearance) => onConfig({ appearance })}
            options={[
              { value: 'male', label: 'Man' },
              { value: 'female', label: 'Woman' },
            ]}
          />
        </div>
        <RoleCards role={role} onChange={onRole} credential={config.credential} />
        <CredentialPicker role={role} config={config} onChange={onConfig} />
        <p className="home-note">The guard can’t see your role. It decides what to believe.</p>
      </div>
      <div className="home-step">
        <h2>Bring one item</h2>
        <div className="item-grid" role="radiogroup" aria-label="Item">
          {ITEMS.map((item) => {
            const Icon = ITEM_ICONS[item.icon];
            const selected = chosen.id === item.id;
            return (
              <button
                type="button"
                key={item.id}
                role="radio"
                aria-checked={selected}
                title={item.description}
                className={`choice-card item-tile ${selected ? 'is-selected' : ''}`}
                onClick={() => onConfig({ item: item.id })}
              >
                <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
                <span>{ITEM_NAMES[item.id] || item.label}</span>
              </button>
            );
          })}
        </div>
        <p className="item-line" title={chosen.description}>
          {ITEM_COPY[chosen.id]}
        </p>
      </div>
      <div className="home-start">
        <GuardChip label={guard.label} tone={guard.tone} onClick={onGuard} />
        <Button
          variant="primary"
          size="lg"
          className="start-button"
          onClick={onStart}
          disabled={starting}
          iconRight={ArrowRight}
        >
          Start
        </Button>
        <p className="home-modes">
          Other modes:
          <button type="button" className="link" onClick={() => onAlternate('duel')}>
            Watch AI vs AI
          </button>
          <span aria-hidden="true">·</span>
          <button type="button" className="link" onClick={() => onAlternate('guard')}>
            Play as the guard
          </button>
        </p>
      </div>
    </section>
  );
}

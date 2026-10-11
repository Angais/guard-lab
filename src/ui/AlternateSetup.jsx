import React from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { Button, Segmented } from './kit.jsx';
import { GuardChip, RoleCards, RulesPicker, CredentialPicker } from './Home.jsx';
import { ApiSettings, GUARD_MODES, ModeHelp } from './SettingsDrawer.jsx';

const MODES = {
  duel: {
    title: 'Watch AI vs AI',
    line: 'Two AIs play. One guards the safe; the other has a secret role.',
  },
  guard: {
    title: 'Play as the guard',
    line: 'You are G-01. Protect the item in the safe. An AI plays the visitor.',
  },
};

export function AlternateSetup({
  config,
  desktop,
  role,
  onRole,
  onChange,
  apiKey,
  onKey,
  guard,
  onGuard,
  onBack,
  onStart,
}) {
  const sessionType = config.sessionType === 'guard' ? 'guard' : 'duel';
  const human = config.humanAI || {
    mode: 'demo',
    endpoint: 'http://localhost:11434/v1',
    model: '',
  };
  const update = (patch) => onChange({ humanAI: { ...human, ...patch } });
  const mode = desktop ? human.mode : 'demo';
  return (
    <section className="home-panel alternate-panel" aria-label="Other modes">
      <button type="button" className="link back-link" onClick={onBack}>
        <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
        Back
      </button>
      <div className="home-step">
        <Segmented
          label="Mode"
          value={sessionType}
          onChange={(value) => onChange({ sessionType: value })}
          options={[
            { value: 'duel', label: MODES.duel.title },
            { value: 'guard', label: MODES.guard.title },
          ]}
        />
        <p className="home-lead">{MODES[sessionType].line}</p>
      </div>
      <div className="home-step">
        <h2>The visitor’s private objective</h2>
        <RoleCards role={role} onChange={onRole} compact />
        <CredentialPicker role={role} config={config} onChange={onChange} />
        <p className="home-note">The visitor picks its own item.</p>
      </div>
      <div className="home-step">
        <h2>Who plays the visitor?</h2>
        <Segmented
          label="Visitor controller"
          value={mode}
          onChange={(mode) => update({ mode })}
          options={GUARD_MODES.map((m) => ({
            ...m,
            disabled: !desktop && m.value !== 'demo',
            title: !desktop && m.value !== 'demo' ? 'Desktop app only' : undefined,
          }))}
        />
        {mode === 'api' && (
          <ApiSettings
            actor="human"
            endpoint={human.endpoint}
            model={human.model}
            apiKey={apiKey}
            onApiKey={onKey}
            onChange={update}
          />
        )}
        {mode === 'live' && (
          <p className="setting-help">
            Advanced. Run <code>node scripts/robot-link.mjs listen --actor=human</code> in a
            separate terminal agent.
          </p>
        )}
        {mode === 'demo' && <ModeHelp mode="demo" />}
        {mode === 'codex' && (
          <p className="setting-help">Uses the Codex model from Settings, in its own session.</p>
        )}
      </div>
      <RulesPicker config={config} onChange={onChange} />
      <div className="home-start">
        {sessionType === 'duel' && (
          <GuardChip label={guard.label} tone={guard.tone} onClick={onGuard} />
        )}
        <Button
          variant="primary"
          size="lg"
          className="start-button"
          onClick={onStart}
          iconRight={ArrowRight}
        >
          {sessionType === 'duel' ? 'Start watching' : 'Start as G-01'}
        </Button>
      </div>
    </section>
  );
}

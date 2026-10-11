import React, { useState } from 'react';
import { ChevronDown, Play, Radio, RotateCcw, WandSparkles } from 'lucide-react';
import { TOOLS, DEFAULT_PROMPT } from '../sim/tools.mjs';
import { DEFAULT_VOICES, voiceInfo } from '../../shared/voice-catalog.mjs';
import { OllamaPicker } from './OllamaPicker.jsx';
import { Button, Field, Segmented, Spinner, Toggle } from './kit.jsx';
import { Drawer } from './Overlays.jsx';
import {
  CodexActions,
  CodexStatusLine,
  LicenseLink,
  MicTest,
  Status,
  VoiceModelActions,
  VoiceModelStatus,
  micBlockedText,
} from './SetupParts.jsx';
import {
  PUSH_TO_TALK_KEYS,
  connectionError,
  effortLabel,
  isOllamaEndpoint,
  resolveCodexSettings,
} from './config.mjs';

export const GUARD_MODES = [
  { value: 'codex', label: 'Codex' },
  { value: 'api', label: 'Your model' },
  { value: 'demo', label: 'Practice' },
  { value: 'live', label: 'Terminal agent' },
];
const PRESETS = [
  ['Ollama', 'http://localhost:11434/v1'],
  ['LM Studio', 'http://localhost:1234/v1'],
  ['OpenAI', 'https://api.openai.com/v1'],
  ['OpenRouter', 'https://openrouter.ai/api/v1'],
];

export function ModeHelp({ mode }) {
  if (mode === 'demo')
    return <p className="setting-help">Fixed rules, no AI. Good for learning the controls.</p>;
  if (mode === 'live')
    return (
      <p className="setting-help">
        Advanced. An agent in your terminal plays the guard through the bridge. Start with{' '}
        <code>npm run live</code>.
      </p>
    );
  return null;
}

export function CodexSettings({ codex, value, onChange, onCopyFix }) {
  const models = codex.models;
  const settings = resolveCodexSettings(value, models);
  const model = models.find((m) => m.id === settings.model);
  const ready = codex.status?.state === 'ready';
  return (
    <div className="settings-group">
      <div className="setting-status">
        <CodexStatusLine codex={codex} config={{ codex: value }} />
        <span className="setting-status-actions">
          <CodexActions codex={codex} onCopyFix={onCopyFix} />
        </span>
      </div>
      {ready && (
        <>
          <Field label="Model">
            {models.length ? (
              <select
                className="select"
                value={settings.model}
                onChange={(e) => {
                  const next = models.find((m) => m.id === e.target.value);
                  onChange({
                    model: e.target.value,
                    effort: next?.efforts?.includes(value.effort)
                      ? value.effort
                      : next?.defaultEffort,
                  });
                }}
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name || m.id}
                  </option>
                ))}
              </select>
            ) : (
              <Status busy>Loading models…</Status>
            )}
          </Field>
          {model?.efforts?.length > 0 && (
            <Field label="Reasoning">
              <Segmented
                size="sm"
                label="Reasoning effort"
                value={settings.effort}
                onChange={(effort) => onChange({ effort })}
                options={model.efforts.map((effort) => ({
                  value: effort,
                  label: effortLabel(effort),
                }))}
              />
            </Field>
          )}
          <Toggle
            label="Fast mode"
            description={
              model && !model.fast
                ? 'This model has no fast tier.'
                : 'Faster replies, uses more of your plan.'
            }
            checked={settings.fast}
            disabled={Boolean(model && !model.fast)}
            onChange={(fast) => onChange({ fast })}
          />
        </>
      )}
    </div>
  );
}

export function ApiSettings({ endpoint, model, apiKey, onChange, onApiKey, actor = 'guard' }) {
  const [test, setTest] = useState(null);
  const [testing, setTesting] = useState(false);
  async function check() {
    setTesting(true);
    setTest(null);
    try {
      const result = await window.desktop.testModel({ endpoint, apiKey });
      setTest({ ok: true, models: result.models || [] });
    } catch (error) {
      setTest({ ok: false, message: connectionError(error, endpoint) });
    } finally {
      setTesting(false);
    }
  }
  return (
    <div className="settings-group">
      <div className="preset-row">
        {PRESETS.map(([label, url]) => (
          <button
            type="button"
            key={label}
            className={`chip chip-button ${endpoint === url ? 'is-selected' : ''}`}
            onClick={() => {
              onChange({ endpoint: url });
              setTest(null);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {isOllamaEndpoint(endpoint) && (
        <OllamaPicker
          endpoint={endpoint}
          model={model}
          actor={actor}
          onSelect={(name) => onChange({ model: name })}
        />
      )}
      <Field label="API base URL">
        <input
          className="input"
          value={endpoint}
          placeholder="http://localhost:11434/v1"
          onChange={(e) => {
            onChange({ endpoint: e.target.value });
            setTest(null);
          }}
        />
      </Field>
      <div className="field-pair">
        <Field label="Model name">
          <input
            className="input"
            list={`${actor}-model-options`}
            value={model}
            placeholder="Your installed model"
            onChange={(e) => onChange({ model: e.target.value })}
          />
          <datalist id={`${actor}-model-options`}>
            {test?.models?.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </Field>
        <Field label="API key" hint="Kept in memory only.">
          <input
            className="input"
            type="password"
            value={apiKey}
            placeholder="Optional for local models"
            onChange={(e) => onApiKey(e.target.value)}
          />
        </Field>
      </div>
      <div className="connection-row">
        <Button size="sm" icon={testing ? undefined : Radio} disabled={testing} onClick={check}>
          {testing && <Spinner size={14} />}
          Test connection
        </Button>
        {test && (
          <span className={`status-line ${test.ok ? 'is-ok' : 'is-danger'}`}>
            {test.ok ? `Connected · ${test.models.length} models` : test.message}
          </span>
        )}
      </div>
      <p className="setting-help">Any OpenAI-compatible endpoint with tool calling.</p>
    </div>
  );
}

function Advanced({ config, onConfig, onCodex, onPathCommit }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`advanced ${open ? 'is-open' : ''}`}>
      <button
        type="button"
        className="advanced-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Advanced
        <ChevronDown size={16} strokeWidth={1.75} aria-hidden="true" />
      </button>
      {open && (
        <div className="advanced-body">
          <Field label="Guard instructions">
            <textarea
              className="input textarea"
              rows={7}
              value={config.prompt}
              onChange={(e) => onConfig({ prompt: e.target.value })}
            />
          </Field>
          <Button
            variant="ghost"
            size="sm"
            icon={RotateCcw}
            disabled={config.prompt === DEFAULT_PROMPT}
            onClick={() => onConfig({ prompt: DEFAULT_PROMPT })}
          >
            Restore default instructions
          </Button>
          <div className="field-pair">
            <Field label="Safe code" hint="Blank picks a new code each game.">
              <input
                className="input"
                inputMode="numeric"
                maxLength={4}
                placeholder="Random"
                value={config.combination}
                onChange={(e) => onConfig({ combination: e.target.value.replace(/\D/g, '') })}
              />
            </Field>
            {config.mode === 'api' && (
              <Field label="Temperature">
                <input
                  className="input"
                  type="number"
                  min="0"
                  max="2"
                  step="0.1"
                  value={config.temperature}
                  onChange={(e) =>
                    onConfig({ temperature: Math.max(0, Math.min(2, Number(e.target.value) || 0)) })
                  }
                />
              </Field>
            )}
            {config.mode === 'codex' && (
              <Field label="Codex executable" hint="Leave blank to find it automatically.">
                <input
                  className="input"
                  value={config.codex.path || ''}
                  placeholder="codex"
                  spellCheck={false}
                  onChange={(e) => onCodex({ path: e.target.value.trim() })}
                  onBlur={onPathCommit}
                />
              </Field>
            )}
          </div>
          <div className="tool-list" role="group" aria-label="Guard tools">
            <span className="field-label">Guard tools</span>
            {TOOLS.map((tool) => {
              const locked = ['speak', 'hold_position'].includes(tool.name);
              return (
                <label
                  key={tool.name}
                  className={`tool-row tool-${tool.category}`}
                  title={tool.description}
                >
                  <input
                    type="checkbox"
                    checked={config.enabled.includes(tool.name)}
                    disabled={locked}
                    onChange={(e) =>
                      onConfig({
                        enabled: e.target.checked
                          ? [...config.enabled, tool.name]
                          : config.enabled.filter((n) => n !== tool.name),
                      })
                    }
                  />
                  <span className="tool-name">{tool.label}</span>
                  <span className="tool-category">{tool.category}</span>
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// Lists the voices the voice layer reports; `standard` marks the game's default for this actor.
function VoiceSelect({ value, voices, onChange, onPreview, auto, label, standard }) {
  return (
    <Field label={label}>
      <span className="select-row">
        <select className="select" value={value} onChange={(e) => onChange(e.target.value)}>
          {auto && <option value="">{auto}</option>}
          {voices.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
              {v.accent ? ` · ${v.accent}` : ''}
              {standard?.includes(v.id) ? ' · default' : ''}
            </option>
          ))}
          {value && !voices.some((v) => v.id === value) && (
            <option value={value}>{voiceInfo(value)?.name || value}</option>
          )}
        </select>
        <button
          type="button"
          className="icon-btn"
          aria-label={`Preview ${label.toLowerCase()}`}
          title="Preview"
          onClick={onPreview}
        >
          <Play size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </span>
    </Field>
  );
}

export function SettingsDrawer({
  section,
  onSection,
  onClose,
  config,
  onConfig,
  desktop,
  codex,
  voice,
  apiKey,
  onApiKey,
  onCopyFix,
  onCopyLink,
  onPreviewVoice,
  onMicError,
  onRunSetup,
  platform,
}) {
  const updateCodex = (patch) => onConfig({ codex: { ...config.codex, ...patch } });
  const updateVoice = (patch) => onConfig({ voice: { ...config.voice, ...patch } });
  const tts = voice.status?.tts,
    stt = voice.status?.stt;
  const micDenied = voice.status?.microphone === 'denied';
  return (
    <Drawer title="Settings" onClose={onClose} className="settings-drawer">
      <Segmented
        variant="tabs"
        label="Settings section"
        value={section}
        onChange={onSection}
        options={[
          { value: 'guard', label: 'Guard' },
          { value: 'voice', label: 'Voice' },
          { value: 'game', label: 'Game' },
        ]}
      />
      {section === 'guard' && (
        <section className="settings-section">
          <h3>Who controls the guard?</h3>
          <Segmented
            label="Guard controller"
            value={desktop ? config.mode : 'demo'}
            onChange={(mode) => onConfig({ mode })}
            options={GUARD_MODES.map((m) => ({
              ...m,
              disabled: !desktop && m.value !== 'demo',
              title: !desktop && m.value !== 'demo' ? 'Desktop app only' : undefined,
            }))}
          />
          {!desktop && (
            <p className="setting-help">
              Codex, your own model and terminal agents need the desktop app.
            </p>
          )}
          {desktop && config.mode === 'codex' && (
            <CodexSettings
              codex={codex}
              value={config.codex}
              onChange={updateCodex}
              onCopyFix={onCopyFix}
            />
          )}
          {desktop && config.mode === 'api' && (
            <ApiSettings
              endpoint={config.endpoint}
              model={config.model}
              apiKey={apiKey}
              onApiKey={onApiKey}
              onChange={onConfig}
            />
          )}
          <ModeHelp mode={config.mode} />
          <Advanced
            config={config}
            onConfig={onConfig}
            onCodex={updateCodex}
            onPathCommit={() => codex.refresh()}
          />
          <p className="setting-foot">A new controller takes over from your next game.</p>
        </section>
      )}
      {section === 'voice' && (
        <section className="settings-section">
          <h3>Voices</h3>
          <Toggle
            label="Spoken voices"
            description="Read the other side’s lines aloud. Subtitles always show. Voices are AI-generated."
            checked={config.voice.speech}
            onChange={(speech) => updateVoice({ speech })}
          />
          <div className="field-pair">
            <VoiceSelect
              label="Guard voice"
              value={config.voice.guardVoice}
              voices={voice.voices}
              standard={[DEFAULT_VOICES.robot]}
              onChange={(guardVoice) => updateVoice({ guardVoice })}
              onPreview={() => onPreviewVoice('robot', config.voice.guardVoice)}
            />
            <VoiceSelect
              label="Your voice"
              value={config.voice.humanVoice}
              voices={voice.voices}
              auto="Match appearance"
              standard={[DEFAULT_VOICES.male, DEFAULT_VOICES.female]}
              onChange={(humanVoice) => updateVoice({ humanVoice })}
              onPreview={() => onPreviewVoice('human', config.voice.humanVoice)}
            />
          </div>
          {voice.available && (
            <div className="model-row">
              <div>
                <strong>
                  {tts?.model || 'Voice model'} <span className="setup-tag">natural voices</span>
                </strong>
                <VoiceModelStatus
                  component={tts}
                  missingText={`Not installed${tts?.sizeLabel ? ` · ${tts.sizeLabel}` : ''}. Uses your system voice until then.`}
                />
              </div>
              <span className="model-actions">
                {tts?.state !== 'installing' && <LicenseLink component={tts} onCopy={onCopyLink} />}
                <VoiceModelActions
                  component={tts}
                  onInstall={() => voice.install('tts')}
                  onRemove={() => voice.remove('tts')}
                />
              </span>
            </div>
          )}
          <p className="setting-foot">Voices are AI-generated.</p>
          <h3>Voice input</h3>
          <Toggle
            label="Talk with your mic"
            description={`Hold ${PUSH_TO_TALK_KEYS.find((k) => k.code === config.voice.pushToTalkKey)?.label || 'Space'} to talk, release to send.`}
            checked={config.voice.input}
            onChange={(input) => updateVoice({ input })}
          />
          <Field label="Push-to-talk key">
            <Segmented
              size="sm"
              label="Push-to-talk key"
              value={config.voice.pushToTalkKey}
              onChange={(pushToTalkKey) => updateVoice({ pushToTalkKey })}
              options={PUSH_TO_TALK_KEYS.map((k) => ({ value: k.code, label: k.label }))}
            />
          </Field>
          {voice.available && (
            <div className="model-row">
              <div>
                <strong>
                  {stt?.model || 'Whisper'} <span className="setup-tag">speech to text</span>
                </strong>
                {stt?.state === 'ready' && micDenied ? (
                  <Status tone="danger">{micBlockedText(platform)}</Status>
                ) : (
                  <VoiceModelStatus
                    component={stt}
                    missingText={`Not installed${stt?.sizeLabel ? ` · ${stt.sizeLabel}` : ''}`}
                  />
                )}
              </div>
              <span className="model-actions">
                <VoiceModelActions
                  component={stt}
                  onInstall={() => voice.install('stt')}
                  onRemove={() => voice.remove('stt')}
                >
                  {!micDenied && <MicTest onError={onMicError} />}
                </VoiceModelActions>
              </span>
            </div>
          )}
          {!voice.available && (
            <p className="setting-help">Spoken voices and voice input need the desktop app.</p>
          )}
        </section>
      )}
      {section === 'game' && (
        <section className="settings-section">
          <Toggle
            label="Show hints"
            description="A short tip in your first turns, for your first few games."
            checked={config.showHints}
            onChange={(showHints) => onConfig({ showHints })}
          />
          {desktop && (
            <Button icon={WandSparkles} onClick={onRunSetup}>
              Run setup again
            </Button>
          )}
        </section>
      )}
    </Drawer>
  );
}

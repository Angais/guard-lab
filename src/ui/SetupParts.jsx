import React, { useState } from 'react';
import { Copy, Download, LogIn, Mic, Play, RefreshCw, Trash2 } from 'lucide-react';
import { Button, Dot, Progress, Spinner } from './kit.jsx';
import { useVoiceCapture } from './hooks.mjs';
import { guardLabel } from './config.mjs';

const mb = (bytes) => (bytes ? Math.max(1, Math.round(bytes / 1e6)) : 0);

export function accountLine(status) {
  const account = status?.account;
  if (!account) return 'Ready';
  if (account.type === 'apiKey') return 'Ready · using an API key';
  if (account.type === 'amazonBedrock') return 'Ready · using Amazon Bedrock';
  const plan = account.plan
    ? ` (${account.plan.charAt(0).toUpperCase()}${account.plan.slice(1)})`
    : '';
  return `Ready · signed in with ChatGPT${plan}`;
}

export function micBlockedText(platform) {
  const where =
    platform === 'darwin'
      ? 'System Settings'
      : platform === 'win32'
        ? 'Windows Settings'
        : 'your system settings';
  return `Microphone blocked — allow it in ${where}.`;
}

export function SetupRow({ icon: Icon, title, tag, status, children, tone }) {
  return (
    <div className={`setup-row ${tone ? 'is-' + tone : ''}`}>
      <span className="setup-icon" aria-hidden="true">
        <Icon size={20} strokeWidth={1.75} />
      </span>
      <div className="setup-text">
        <strong>
          {title}
          {tag && <span className="setup-tag">{tag}</span>}
        </strong>
        <div className="setup-status">{status}</div>
      </div>
      <div className="setup-actions">{children}</div>
    </div>
  );
}

export function Status({ tone, busy, children, extra, className = '' }) {
  return (
    <span className={`status-line ${className}`}>
      <span className="status-text">
        {busy ? <Spinner size={14} /> : tone ? <Dot tone={tone} /> : null}
        <span>{children}</span>
      </span>
      {extra}
    </span>
  );
}

export function CodexStatusLine({ codex, config, onModel }) {
  const status = codex.status;
  if (!codex.available) return <Status>Available in the desktop app.</Status>;
  if (!status || status.state === 'checking') return <Status busy>Looking for Codex…</Status>;
  if (status.state === 'ready')
    return (
      <Status
        tone="ok"
        extra={
          onModel && (
            <button type="button" className="chip chip-button" onClick={onModel}>
              {guardLabel({ ...config, mode: 'codex' }, codex.models)}
            </button>
          )
        }
      >
        {accountLine(status)}
      </Status>
    );
  if (status.login?.state === 'pending')
    return <Status busy>Finish signing in in your browser…</Status>;
  if (status.state === 'signed-out')
    return (
      <Status tone="warn">
        {status.login?.state === 'failed'
          ? status.login.error || 'Sign-in failed. Try again.'
          : 'Codex is installed but not signed in.'}
      </Status>
    );
  return <Status tone="danger">{status.message || 'Codex isn’t working.'}</Status>;
}

export function CodexActions({ codex, onCopyFix }) {
  const status = codex.status;
  if (!codex.available || !status || status.state === 'checking' || status.state === 'ready')
    return status?.state === 'ready' ? (
      <Button variant="ghost" size="sm" icon={RefreshCw} onClick={codex.refresh}>
        Check again
      </Button>
    ) : null;
  if (status.login?.state === 'pending')
    return (
      <Button variant="ghost" size="sm" onClick={codex.cancelLogin}>
        Cancel
      </Button>
    );
  if (status.state === 'signed-out')
    return (
      <>
        {status.fixPrompt && (
          <Button variant="ghost" size="sm" icon={Copy} onClick={() => onCopyFix(status.fixPrompt)}>
            Copy fix prompt
          </Button>
        )}
        <Button variant="primary" size="sm" icon={LogIn} onClick={codex.login}>
          Sign in with ChatGPT
        </Button>
      </>
    );
  return (
    <>
      <Button variant="ghost" size="sm" icon={RefreshCw} onClick={codex.refresh}>
        Check again
      </Button>
      {status.fixPrompt && (
        <Button variant="primary" size="sm" icon={Copy} onClick={() => onCopyFix(status.fixPrompt)}>
          Copy fix prompt
        </Button>
      )}
    </>
  );
}

export function ModelProgress({ component }) {
  const total = mb(component.totalBytes) || parseInt(component.sizeLabel, 10) || 0;
  const done = mb(component.bytes) || Math.round((component.progress || 0) * total);
  return (
    <span className="status-line progress-line">
      <Progress value={component.progress} label={`Downloading ${component.model || 'model'}`} />
      <span className="progress-count">
        {total ? `${done} / ${total} MB` : `${Math.round((component.progress || 0) * 100)}%`}
      </span>
    </span>
  );
}

// The downloaded weights keep their own license; the link sits next to Download. The desktop
// app opens no browser windows, so there a click copies the address and shows it instead.
export function LicenseLink({ component, onCopy }) {
  const license = component?.license;
  if (!license?.url) return null;
  const family = String(component.model || 'Voice').replace(/\s+[\d.]+$/, '');
  const text = `${family} voice model · license`;
  return (
    <a
      className="license-link"
      href={license.url}
      target="_blank"
      rel="noreferrer noopener"
      title={`${license.name ? license.name + ' · ' : ''}${license.url}`}
      onClick={(e) => {
        if (!window.desktop || !onCopy) return;
        e.preventDefault();
        onCopy(license.url);
      }}
    >
      {text}
    </a>
  );
}

// Status text for a voice model (Supertonic or Whisper).
export function VoiceModelStatus({ component, missingText }) {
  if (!component) return <Status busy>Checking…</Status>;
  if (component.state === 'installing') return <ModelProgress component={component} />;
  if (component.state === 'ready') return <Status tone="ok">Ready</Status>;
  if (component.state === 'error')
    return <Status tone="danger">{component.message || 'Download failed.'}</Status>;
  return <Status>{missingText}</Status>;
}

export function VoiceModelActions({ component, onInstall, onRemove, children, primary }) {
  if (!component || component.state === 'installing') return null;
  if (component.state === 'ready')
    return (
      <>
        {children}
        {onRemove && (
          <Button variant="ghost" size="sm" icon={Trash2} onClick={onRemove} title="Remove model">
            Remove
          </Button>
        )}
      </>
    );
  return (
    <Button
      variant={primary ? 'primary' : 'secondary'}
      size="sm"
      icon={component.state === 'error' ? RefreshCw : Download}
      onClick={onInstall}
    >
      {component.state === 'error' ? 'Retry' : 'Download'}
    </Button>
  );
}

export function TestVoiceButton({ onTest }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="secondary"
      size="sm"
      icon={busy ? undefined : Play}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await onTest();
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <Spinner size={14} /> : null}
      Test
    </Button>
  );
}

// Hold to record a short clip, release to see the transcript.
export function MicTest({ onError }) {
  const [heard, setHeard] = useState('');
  const capture = useVoiceCapture({
    onText: setHeard,
    onError: (error) => {
      setHeard('');
      onError?.(error);
    },
  });
  const stop = () => capture.phase === 'listening' && capture.end();
  return (
    <span className="mic-test">
      {heard && <span className="mic-heard">“{heard}”</span>}
      <Button
        size="sm"
        icon={Mic}
        className={capture.phase === 'listening' ? 'is-recording' : ''}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture?.(e.pointerId);
          setHeard('');
          capture.begin();
        }}
        onPointerUp={stop}
        onPointerCancel={() => capture.cancel()}
        onKeyDown={(e) => {
          if ((e.key === ' ' || e.key === 'Enter') && !e.repeat && capture.phase === 'idle') {
            e.preventDefault();
            setHeard('');
            capture.begin();
          }
        }}
        onKeyUp={(e) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            stop();
          }
        }}
      >
        {capture.phase === 'listening'
          ? 'Listening…'
          : capture.phase === 'transcribing'
            ? 'Transcribing…'
            : 'Hold to test mic'}
      </Button>
    </span>
  );
}

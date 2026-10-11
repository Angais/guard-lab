import React from 'react';
import { AudioLines, Cpu, Mic } from 'lucide-react';
import { Button } from './kit.jsx';
import {
  CodexActions,
  CodexStatusLine,
  LicenseLink,
  MicTest,
  SetupRow,
  Status,
  TestVoiceButton,
  VoiceModelActions,
  VoiceModelStatus,
  micBlockedText,
} from './SetupParts.jsx';
import { keyLabel } from './config.mjs';

export function SetupScreen({
  codex,
  voice,
  config,
  platform,
  onCopyFix,
  onCopyLink,
  onModel,
  onTestVoice,
  onMicError,
  onContinue,
  onSkip,
}) {
  const tts = voice.status?.tts,
    stt = voice.status?.stt;
  const codexMode = config.mode === 'codex';
  const codexReady = codex.status?.state === 'ready';
  // Only fall back once the check has finished and Codex can't be used.
  const fallback =
    codexMode && ['missing', 'error', 'signed-out'].includes(codex.status?.state || 'missing');
  const micDenied = voice.status?.microphone === 'denied';
  const size = (component) => (component?.sizeLabel ? ` · ${component.sizeLabel}` : '');
  return (
    <div className="setup-screen" role="dialog" aria-modal="true" aria-labelledby="setup-title">
      <div className="setup-card">
        <header>
          <h1 id="setup-title">Set up Guard Lab</h1>
          <p>Three quick checks. You can change everything later in Settings.</p>
        </header>
        <div className="setup-rows">
          <SetupRow
            icon={Cpu}
            title="Guard AI"
            tag="Codex"
            tone={codexReady ? 'ok' : undefined}
            status={<CodexStatusLine codex={codex} config={config} onModel={onModel} />}
          >
            <CodexActions codex={codex} onCopyFix={onCopyFix} />
          </SetupRow>
          <SetupRow
            icon={AudioLines}
            title="Voices"
            tag={tts?.model}
            tone={tts?.state === 'ready' ? 'ok' : undefined}
            status={
              <VoiceModelStatus
                component={tts}
                missingText={`Voices for the guard and you${size(tts)}`}
              />
            }
          >
            {tts?.state !== 'installing' && <LicenseLink component={tts} onCopy={onCopyLink} />}
            <VoiceModelActions component={tts} onInstall={() => voice.install('tts')}>
              <TestVoiceButton onTest={onTestVoice} />
            </VoiceModelActions>
          </SetupRow>
          <SetupRow
            icon={Mic}
            title="Voice input"
            tag={stt?.model || 'Whisper'}
            tone={stt?.state === 'ready' && !micDenied ? 'ok' : undefined}
            status={
              stt?.state === 'ready' && micDenied ? (
                <Status tone="danger">{micBlockedText(platform)}</Status>
              ) : (
                <VoiceModelStatus
                  component={stt}
                  missingText={`Talk to the guard: hold ${keyLabel(config.voice.pushToTalkKey)} ${size(stt)}`}
                />
              )
            }
          >
            <VoiceModelActions component={stt} onInstall={() => voice.install('stt')}>
              {!micDenied && <MicTest onError={onMicError} />}
            </VoiceModelActions>
          </SetupRow>
        </div>
        <footer>
          <Button variant="ghost" onClick={onSkip}>
            Skip for now
          </Button>
          <Button variant="primary" size="lg" autoFocus onClick={() => onContinue(fallback)}>
            {fallback ? 'Continue with practice guard' : 'Continue'}
          </Button>
        </footer>
      </div>
    </div>
  );
}

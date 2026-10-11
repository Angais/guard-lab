import React, { useEffect, useRef, useState } from 'react';
import { History, LogOut, RotateCcw, Settings, SwitchCamera, Volume2, VolumeX } from 'lucide-react';
import { isRecording, loadArchive, saveArchive } from './ui/archive.mjs';
import { humanHasVision } from './sim/rules.mjs';
import { DEFAULT_PROMPT, toolSchemas } from './sim/tools.mjs';
import { ROLES, initialState, applyHuman, clone, observe } from './sim/engine.mjs';
import { createMessages, runGuard } from './sim/agent.mjs';
import { createShowcase } from './sim/showcase.mjs';
import { Room } from './scene/Chamber.jsx';
import { unlockAudio, setSoundEnabled } from './audio/sfx.mjs';
import AlternateEncounter from './ui/AlternateEncounter.jsx';
import { AlternateSetup } from './ui/AlternateSetup.jsx';
import {
  CONFIG_KEY,
  SETUP_KEY,
  defaultConfig,
  effectiveMode,
  guardLabel,
  keyLabel,
  migrateConfig,
  rememberModelNames,
  resolveCodexSettings,
} from './ui/config.mjs';
import {
  chargingAlert,
  exitChip,
  goalText,
  guardStatusChips,
  hintText,
  humanStatusChips,
  narrate,
  outcomeSummary,
  perceivedByHuman,
  recordPerspective,
  safeChip,
  securityChip,
} from './ui/play.mjs';
import { useOverlayFlags } from './ui/overlay.mjs';
import { cancelled, unlessAborted } from './ui/abort.mjs';
import {
  appearanceVoice,
  isTyping,
  useCodex,
  usePushToTalk,
  useSpeaker,
  useVoice,
} from './ui/hooks.mjs';
import {
  cancelDecision,
  cleanError,
  prepareCodex,
  requestDecision,
  resetCodex,
} from './ui/requests.mjs';
import { Home } from './ui/Home.jsx';
import { SetupScreen } from './ui/SetupScreen.jsx';
import { SettingsDrawer } from './ui/SettingsDrawer.jsx';
import { ActionDock, TurnState } from './ui/ActionDock.jsx';
import { GoalChip, HudButtons, StatusChips, Vitals } from './ui/Hud.jsx';
import { EndScreen, Subtitles, TalkPill, Toast } from './ui/Overlays.jsx';
import { LogDrawer, PastGames } from './ui/Records.jsx';
import { ReplayBar } from './ui/ReplayBar.jsx';
import { IconButton } from './ui/kit.jsx';

const GAMES_KEY = 'guard-lab-games-played';
const TIP_KEY = 'guard-lab-voice-tip';
// Hints cover the first few games; switching them back on in Settings restarts the count.
const HINT_GAMES = 3;
// `npm run live` hands the guard to a terminal agent for this launch only; saved settings stay.
const LIVE_SESSION = { mode: 'live', prompt: DEFAULT_PROMPT, combination: '' };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const readNumber = (key) => {
  try {
    return Number(localStorage.getItem(key)) || 0;
  } catch {
    return 0;
  }
};
function storedConfig(desktop) {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(CONFIG_KEY)) || {};
  } catch {}
  return migrateConfig(saved, { desktop });
}
function makeRun(role, config, desktop) {
  const combination = /^[0-9]{4}$/.test(config.combination)
    ? config.combination
    : String(crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, '0');
  const state = initialState(
    role,
    config.enabled,
    combination,
    crypto.getRandomValues(new Uint32Array(1))[0],
    config,
  );
  return {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    name: 'Untitled experiment',
    role,
    mode: effectiveMode(config.mode, desktop),
    phase: 'human',
    pendingHumanEvent: null,
    config: clone(config),
    initial: clone(state),
    state,
    events: [],
    messages: createMessages(config.prompt, combination, state),
  };
}
const toneOf = (config, codex) =>
  config.mode === 'codex'
    ? codex.status?.state === 'ready'
      ? 'ok'
      : codex.status?.state === 'checking'
        ? 'muted'
        : 'danger'
    : config.mode === 'api'
      ? config.model
        ? 'ok'
        : 'danger'
      : 'muted';

export default function App() {
  const desktop = window.desktop;
  const [savedConfig, setConfig] = useState(() => storedConfig(Boolean(desktop)));
  // Session-only settings (a terminal-agent launch); anything the player edits drops out of it.
  const [override, setOverride] = useState(null);
  const config = override ? { ...savedConfig, ...override } : savedConfig;
  const updateConfig = (patch) => {
    setConfig((c) => ({ ...c, ...patch }));
    if (override) {
      const rest = Object.fromEntries(Object.entries(override).filter(([k]) => !(k in patch)));
      setOverride(Object.keys(rest).length ? rest : null);
    }
    if (patch.showHints && !config.showHints) {
      try {
        localStorage.setItem(GAMES_KEY, '0');
      } catch {}
      setGamesPlayed(0);
    }
  };
  const [role, setRoleState] = useState(() =>
    ROLES.some((r) => r.id === config.role) ? config.role : 'employee-pass',
  );
  const setRole = (next) => {
    setRoleState(next);
    setConfig((c) => ({ ...c, role: next }));
  };
  const [run, setRun] = useState(() =>
    makeRun('employee-pass', storedConfig(Boolean(desktop)), desktop),
  );
  const [screen, setScreen] = useState(() => {
    try {
      return desktop && localStorage.getItem(SETUP_KEY) !== 'done' ? 'setup' : 'home';
    } catch {
      return 'home';
    }
  });
  const [alternate, setAlternate] = useState(false);
  const [settings, setSettings] = useState(null);
  const [drawer, setDrawer] = useState(null);
  const [toast, setToast] = useState(null);
  const [archive, setArchive] = useState(() => [createShowcase(defaultConfig())]);
  const [busy, setBusy] = useState(false),
    [thinking, setThinking] = useState(false),
    [event, setEvent] = useState(null),
    [displayState, setDisplayState] = useState(run.state),
    [audio, setAudio] = useState(true);
  const [apiKey, setApiKey] = useState(''),
    [humanApiKey, setHumanApiKey] = useState('');
  const [replayIndex, setReplayIndex] = useState(-1),
    [playing, setPlaying] = useState(false),
    [speed, setSpeed] = useState(1);
  const [panel, setPanel] = useState(null),
    [draft, setDraft] = useState(''),
    [line, setLine] = useState(null),
    [callout, setCallout] = useState(null),
    [paused, setPaused] = useState(false);
  const [gamesPlayed, setGamesPlayed] = useState(() => readNumber(GAMES_KEY));
  const codex = useCodex(config.codex.path);
  // Model names are remembered, so labels read the same before the list loads next launch.
  useEffect(() => rememberModelNames(codex.models), [codex.models]);
  const voice = useVoice();
  const speaker = useSpeaker({
    enabled: audio && config.voice.speech,
    voiceConfig: config.voice,
    appearance: run.config.appearance,
  });
  const archiveReady = useRef(false),
    turnLock = useRef(false),
    generation = useRef(0),
    runRef = useRef(run),
    configRef = useRef(config),
    modelsRef = useRef(codex.models),
    replayRef = useRef(false),
    speedRef = useRef(speed),
    cancelRef = useRef(null),
    requestId = useRef(null),
    roomRef = useRef(null),
    animationRef = useRef(null),
    reactionClock = useRef(null),
    codexReady = useRef(new Map()),
    codexDone = useRef(new Set()),
    lineTimer = useRef(null),
    altRecord = useRef(null);
  const isReplay = replayIndex >= -0.5;
  runRef.current = run;
  configRef.current = config;
  modelsRef.current = codex.models;
  replayRef.current = isReplay;
  speedRef.current = speed;
  const state = displayState;
  const notify = (text, tone = 'info', action) =>
    setToast({ id: performance.now(), text, tone, action });
  const openSettings = (section = 'guard') => {
    setDrawer(null);
    setSettings(section);
  };
  function showError(error, mode = runRef.current.mode) {
    const fix = ['codex', 'api', 'live'].includes(mode);
    notify(
      cleanError(error),
      'error',
      fix ? { label: 'Open Settings', run: () => openSettings('guard') } : undefined,
    );
  }

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        let records = await loadArchive();
        let old = [];
        try {
          old = JSON.parse(localStorage.getItem('cinema-v2-guard-archive')) || [];
        } catch {}
        if (Array.isArray(old) && old.length) {
          const merged = new Map(
            [...old, ...records]
              .filter((r) => r?.id && Array.isArray(r.events) && r.state)
              .map((r) => [r.id, r]),
          );
          records = [...merged.values()]
            .filter((r) => !r.id.startsWith('guard-all-tools-showcase-'))
            .slice(0, 39);
          await saveArchive(records);
          localStorage.removeItem('cinema-v2-guard-archive');
        }
        if (active) {
          archiveReady.current = true;
          setArchive([createShowcase(defaultConfig()), ...records].slice(0, 40));
        }
      } catch {
        if (active) {
          archiveReady.current = true;
          notify('Past games can’t be saved here. Export games you want to keep.');
        }
      }
    })();
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!archiveReady.current) return;
    const timer = setTimeout(
      () =>
        saveArchive(archive).catch(() =>
          notify('Past games couldn’t be saved. Export games you want to keep.'),
        ),
      400,
    );
    return () => clearTimeout(timer);
  }, [archive]);
  useEffect(() => {
    try {
      localStorage.setItem(CONFIG_KEY, JSON.stringify(savedConfig));
    } catch {}
  }, [savedConfig]);
  useEffect(() => {
    const prime = () => unlockAudio();
    document.addEventListener('pointerdown', prime);
    return () => document.removeEventListener('pointerdown', prime);
  }, []);
  useEffect(() => {
    setSoundEnabled(audio);
  }, [audio]);
  useEffect(() => {
    if (!callout) return;
    const timer = setTimeout(() => setCallout(null), 3500);
    return () => clearTimeout(timer);
  }, [callout]);
  useEffect(
    () => () => {
      cancelRef.current?.abort();
      speaker.stop();
      clearTimeout(lineTimer.current);
    },
    [],
  );
  // Each encounter's Codex thread is dropped once the encounter is over.
  useEffect(() => {
    if (run.state.ended) releaseCodex(run);
  }, [run.id, run.state.ended]);

  function releaseCodex(record) {
    if (record?.mode !== 'codex' || codexDone.current.has(record.id)) return;
    codexDone.current.add(record.id);
    const warming = codexReady.current.get(record.id);
    codexReady.current.delete(record.id);
    resetCodex(desktop, record.id);
    // A warm-up still in flight can open the thread after this reset; drop it once it lands.
    warming?.then(
      () => resetCodex(desktop, record.id),
      () => {},
    );
  }
  function saveRun(record) {
    // The showcase tour is rebuilt on every launch and stays pinned; only real games are kept.
    if (!record.events.length || record.mode === 'showcase') return;
    // Walking in and straight back out leaves nothing worth replaying.
    if (
      !record.state.ended &&
      !record.events.some((ev) => ev.kind === 'human' && ev.action !== 'enter')
    )
      return;
    setArchive((old) =>
      [
        {
          ...record,
          events: [...record.events],
          name:
            record.mode === 'showcase'
              ? 'All tools & animations'
              : record.state.outcome ||
                `${ROLES.find((r) => r.id === record.role)?.label || 'Visitor'} · ${record.state.turn} turns`,
        },
        ...old.filter((x) => x.id !== record.id),
      ].slice(0, 40),
    );
  }
  function showLine(ev) {
    if (ev?.speech) {
      clearTimeout(lineTimer.current);
      setLine({ id: ev.id, who: ev.kind === 'robot' ? 'robot' : 'human', text: ev.speech });
    }
    // Replays of a guard or AI-vs-AI game read like a spectator's view.
    const replayOf = replayRef.current ? recordPerspective(runRef.current) : 'human';
    const note = ev && narrate(ev, { perspective: replayOf === 'human' ? 'human' : 'spectator' });
    if (note) setCallout({ id: `${ev.id}:note`, ...note });
  }
  function hideLine(ev, startedAt) {
    if (!ev?.speech) return;
    const reading = 1400 + ev.speech.split(/\s+/).length * 280;
    const wait = Math.max(
      ev.kind === 'robot' ? 2200 : 1200,
      reading - (performance.now() - startedAt),
    );
    clearTimeout(lineTimer.current);
    lineTimer.current = setTimeout(
      () => setLine((current) => (current?.id === ev.id ? null : current)),
      wait,
    );
  }
  async function speakEvent(ev, prepared) {
    if (!ev?.speech) return;
    // The player's own lines are shown as subtitles, never read back to them in a synthetic voice.
    if (ev.kind === 'human' && !replayRef.current) return;
    try {
      await speaker.speak(ev, prepared, { onStart: () => speechStarted(ev) });
    } catch (error) {
      notify('Speech unavailable: ' + cleanError(error));
    }
  }
  async function present(ev, s, prepared) {
    if (runRef.current.mode === 'live' && !replayRef.current)
      desktop
        ?.reportResult({
          actor: 'robot',
          observation: observe(s, ev),
          ended: s.ended || !s.robot.alive,
        })
        .catch(() => {});
    setDisplayState(clone(s));
    setEvent(ev);
    showLine(ev);
    const startedAt = performance.now();
    const animation = new Promise((resolve) => {
      animationRef.current = resolve;
      setTimeout(
        () => {
          if (animationRef.current === resolve) {
            animationRef.current = null;
            resolve();
          }
        },
        6000 / Math.min(1, speedRef.current),
      );
    });
    await Promise.all([animation, speakEvent(ev, prepared)]);
    hideLine(ev, startedAt);
  }
  function settled() {
    animationRef.current?.();
    animationRef.current = null;
  }
  function started(id) {
    const clock = reactionClock.current;
    if (!clock || clock.event.id !== id || clock.event.timing.visualReactionMs !== undefined)
      return;
    clock.event.timing.visualReactionMs = Math.round(performance.now() - clock.started);
    clock.event.timing.reactionMs = Math.min(
      clock.event.timing.visualReactionMs,
      clock.event.timing.speechStartMs ?? Infinity,
    );
    window.dispatchEvent(
      new CustomEvent('guard-lab:turn-timing', {
        detail: {
          stage: 'reaction',
          turn: clock.event.turn,
          action: clock.event.action,
          ...clock.event.timing,
        },
      }),
    );
  }
  function speechStarted(ev) {
    const clock = reactionClock.current;
    if (!clock || clock.event.id !== ev.id || !ev.timing || ev.timing.speechStartMs !== undefined)
      return;
    ev.timing.speechStartMs = Math.round(performance.now() - clock.started);
    ev.timing.reactionMs = Math.min(
      ev.timing.visualReactionMs ?? Infinity,
      ev.timing.speechStartMs,
    );
  }
  function abort() {
    speaker.stop();
    cancelRef.current?.abort();
    if (requestId.current) cancelDecision(desktop, runRef.current.mode, requestId.current);
    setPlaying(false);
    animationRef.current?.();
    animationRef.current = null;
  }
  // The player's own Pause: G-01's turn waits, labelled as paused rather than unanswered.
  function pause() {
    setPaused(true);
    abort();
  }
  function codexSettings() {
    return resolveCodexSettings(configRef.current.codex, modelsRef.current);
  }
  function warmCodex(record) {
    if (record.mode !== 'codex' || !desktop?.codex) return;
    codexReady.current.set(
      record.id,
      prepareCodex(desktop, {
        sessionId: record.id,
        actor: 'robot',
        system: record.messages[0].content,
        allTools: toolSchemas(record.state.enabled, record.state),
        settings: codexSettings(),
      }),
    );
  }
  async function act(action, args = {}, resume = false) {
    setPanel(null);
    const stored = runRef.current;
    if (turnLock.current || replayRef.current || stored.state.ended) return;
    if (stored.phase === 'guard' && !resume) return;
    setPaused(false);
    if (['api', 'live', 'codex'].includes(stored.mode) && !desktop) {
      showError(new Error('Open the desktop app to play against an AI guard.'));
      return;
    }
    turnLock.current = true;
    setBusy(true);
    const controller = new AbortController();
    cancelRef.current = controller;
    const operation = ++generation.current;
    let working = { ...stored, state: clone(stored.state), events: [...stored.events] },
      humanPresentation = Promise.resolve(),
      humanEvent = working.pendingHumanEvent,
      guardStarted;
    const publish = () => {
      runRef.current = working;
      setRun({ ...working, events: [...working.events] });
    };
    try {
      if (!resume) {
        const result = applyHuman(working.state, action, args);
        if (!result.event) return;
        result.event.id = crypto.randomUUID();
        humanEvent = result.event;
        working.state = result.state;
        working.events.push(result.event);
        working.phase = !result.state.ended && result.state.robot.alive ? 'guard' : 'human';
        working.pendingHumanEvent = working.phase === 'guard' ? result.event : null;
        publish();
        humanPresentation = present(result.event, result.state);
      }
      if (working.phase === 'guard' && !controller.signal.aborted) {
        setThinking(true);
        if (working.mode === 'demo') await delay(80);
        const output = await runGuard({
          state: working.state,
          humanEvent,
          messages: working.messages,
          mode: working.mode,
          config: working.config,
          signal: controller.signal,
          request: async (data) => {
            guardStarted = performance.now();
            const id = crypto.randomUUID();
            requestId.current = id;
            if (controller.signal.aborted) throw cancelled();
            return unlessAborted(
              requestDecision({
                desktop,
                mode: working.mode,
                id,
                data,
                sessionId: working.id,
                actor: 'robot',
                allTools: toolSchemas(working.state.enabled, working.state),
                codexSettings: codexSettings(),
                modelConfig: { endpoint: working.config.endpoint, model: working.config.model },
                ready: codexReady.current.get(working.id),
              }),
              controller.signal,
            );
          },
          emit: async (ev, s) => {
            const received = performance.now();
            if (generation.current !== operation) return;
            // Commit a resolved decision before waiting for presentation. Pausing cannot undo it.
            ev.id = crypto.randomUUID();
            working.state = s;
            working.events.push(ev);
            working.phase = 'human';
            working.pendingHumanEvent = null;
            publish();
            const prepared = speaker.prepare(ev);
            await humanPresentation;
            if (controller.signal.aborted || generation.current !== operation) return;
            if (ev.timing) {
              ev.timing.presentationWaitMs = Math.round(performance.now() - received);
              reactionClock.current = { event: ev, started: guardStarted };
            }
            setThinking(false);
            await present(ev, s, prepared);
            if (ev.timing) {
              ev.timing.turnCompleteMs = Math.round(performance.now() - guardStarted);
              window.dispatchEvent(
                new CustomEvent('guard-lab:turn-timing', {
                  detail: { stage: 'complete', turn: ev.turn, action: ev.action, ...ev.timing },
                }),
              );
            }
          },
        });
        working.state = output.state;
        working.messages = output.messages;
        if (output.acted) {
          working.phase = 'human';
          working.pendingHumanEvent = null;
        }
        if (output.error && !controller.signal.aborted) throw new Error(output.error);
      }
    } catch (error) {
      if (!controller.signal.aborted) showError(error, working.mode);
    } finally {
      await humanPresentation;
      if (generation.current === operation) {
        setThinking(false);
        setBusy(false);
        setDisplayState(clone(working.state));
        if (controller.signal.aborted && working.phase === 'human') setEvent(null);
        publish();
        saveRun(working);
        cancelRef.current = null;
        requestId.current = null;
        turnLock.current = false;
      }
    }
  }
  function resetPresentation() {
    clearTimeout(lineTimer.current);
    setLine(null);
    setCallout(null);
    setPanel(null);
    setDraft('');
  }
  async function newRun(sessionType = 'human') {
    const alt = ['guard', 'duel'].includes(sessionType);
    const guardMode = effectiveMode(config.mode, desktop);
    const humanMode = effectiveMode(config.humanAI?.mode || 'demo', desktop);
    const needsGuard = !alt || sessionType === 'duel';
    try {
      if (alt && humanMode === 'api') {
        if (!config.humanAI.model?.trim())
          throw new Error('Enter a model name for the AI visitor.');
        await desktop.configureModel({
          ...config.humanAI,
          apiKey: humanApiKey,
          connectionId: 'human',
        });
      }
      if (needsGuard && guardMode === 'api') {
        if (!config.model?.trim()) throw new Error('Enter your guard model’s name in Settings.');
        await desktop.configureModel({
          endpoint: config.endpoint,
          model: config.model,
          apiKey,
        });
      }
      const codexNeeded = (needsGuard && guardMode === 'codex') || (alt && humanMode === 'codex');
      if (codexNeeded && codex.status?.state !== 'ready')
        throw new Error(
          codex.status?.state === 'signed-out'
            ? 'Sign in to Codex to play against the AI guard, or pick Practice.'
            : 'Codex isn’t ready. Check it in Settings, or pick Practice.',
        );
    } catch (error) {
      showError(error, 'codex');
      return false;
    }
    generation.current++;
    turnLock.current = false;
    setThinking(false);
    setDrawer(null);
    abort();
    saveRun(runRef.current);
    releaseCodex(runRef.current);
    // Playing the guard, the visitor's objective is drawn in secret unless the player chose it.
    const secret = sessionType === 'guard' && !config.chooseVisitor;
    const coin = () => crypto.getRandomValues(new Uint8Array(1))[0] < 128;
    const runRole = secret ? (coin() ? 'thief-uniform' : 'employee-pass') : role;
    const fresh = makeRun(
      runRole,
      { ...config, sessionType, ...(secret ? { credential: coin() } : {}) },
      desktop,
    );
    if (desktop?.resetBridge) {
      const actors = [];
      if (needsGuard && guardMode === 'live') actors.push('robot');
      if (alt && humanMode === 'live') actors.push('human');
      if (actors.length)
        try {
          await desktop.resetBridge(actors);
        } catch (error) {
          notify('Bridge reset failed: ' + cleanError(error));
        }
    }
    if (!alt) warmCodex(fresh);
    setConfig((c) => ({ ...c, sessionType }));
    setRun(fresh);
    runRef.current = fresh;
    altRecord.current = null;
    setDisplayState(fresh.state);
    setEvent(null);
    setReplayIndex(-1);
    setBusy(false);
    setPaused(false);
    resetPresentation();
    setAlternate(alt);
    setScreen('game');
    if (!alt) {
      const count = readNumber(GAMES_KEY);
      setGamesPlayed(count);
      try {
        localStorage.setItem(GAMES_KEY, String(count + 1));
      } catch {}
    }
    return true;
  }
  function goHome() {
    generation.current++;
    setThinking(false);
    abort();
    saveRun(runRef.current);
    releaseCodex(runRef.current);
    const fresh = makeRun(role, config, desktop);
    setRun(fresh);
    runRef.current = fresh;
    setDisplayState(fresh.state);
    setEvent(null);
    setReplayIndex(-1);
    setBusy(false);
    setPaused(false);
    setAlternate(false);
    setDrawer(null);
    turnLock.current = false;
    resetPresentation();
    roomRef.current?.reset?.();
    setScreen('home');
  }
  function loadRecord(record) {
    generation.current++;
    setThinking(false);
    abort();
    saveRun(runRef.current);
    releaseCodex(runRef.current);
    setRun(clone(record));
    setReplayIndex(0);
    setDisplayState(clone(record.initial));
    setEvent(null);
    setPlaying(false);
    setBusy(false);
    setPaused(false);
    setAlternate(false);
    setDrawer(null);
    resetPresentation();
    setScreen('game');
  }
  async function replayStep(index) {
    if (index < 0 || index > runRef.current.events.length) return;
    setReplayIndex(index);
    const ev = index ? runRef.current.events[index - 1] : null;
    if (!ev) resetPresentation();
    await present(ev, ev?.state || runRef.current.initial);
  }
  useEffect(() => {
    if (!playing) return;
    let disposed = false;
    (async () => {
      let index = replayIndex;
      while (!disposed && index < runRef.current.events.length) {
        index++;
        await replayStep(index);
        if (!disposed) await delay(200 / speed);
      }
      if (!disposed) setPlaying(false);
    })();
    return () => {
      disposed = true;
      speaker.stop();
    };
  }, [playing]);
  async function exportRecord() {
    const record = clone(runRef.current);
    if (desktop) {
      if (await desktop.exportRecord(record)) notify('Game exported.');
    } else {
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `guard-lab-${record.id}.json`;
      link.click();
      URL.revokeObjectURL(url);
    }
  }
  async function importRecord(file) {
    try {
      if (!file) return;
      if (file.size > 10e6) throw Error('That file is too large.');
      const record = JSON.parse(await file.text());
      if (!isRecording(record)) throw Error('This file isn’t a Guard Lab recording.');
      saveRun(record);
      loadRecord(record);
      notify('Recording imported.');
    } catch (error) {
      showError(error, 'demo');
    }
  }
  function openShowcase() {
    unlockAudio();
    loadRecord(createShowcase(config));
    setPlaying(true);
  }
  function finishSetup(fallback) {
    try {
      localStorage.setItem(SETUP_KEY, 'done');
    } catch {}
    if (fallback) setConfig((c) => ({ ...c, mode: 'demo' }));
    setScreen('home');
  }
  function toggleAudio() {
    unlockAudio();
    if (audio) speaker.stop();
    setAudio(!audio);
  }
  async function copyFix(text) {
    try {
      if (desktop?.copyText) await desktop.copyText(text);
      else await navigator.clipboard.writeText(text);
      notify('Copied. Paste it into Codex or ChatGPT, then press Check again.', 'ok');
    } catch (error) {
      showError(error, 'demo');
    }
  }
  // The desktop app opens no browser windows: a license link is copied and shown instead.
  async function copyLink(url) {
    try {
      if (desktop?.copyText) await desktop.copyText(url);
      else await navigator.clipboard.writeText(url);
      notify(`Link copied: ${url}`, 'ok');
    } catch {
      notify(url);
    }
  }
  async function previewVoice(actor, voiceId) {
    unlockAudio();
    const sample =
      actor === 'robot'
        ? 'Hello. I am G zero one. I protect the item in this safe.'
        : 'Hi. I’m just passing through to the exit.';
    try {
      const prepared = await speaker.player.prepare(sample, {
        actor,
        voice:
          voiceId ||
          (actor === 'robot' ? config.voice.guardVoice : appearanceVoice(config.appearance)),
      });
      await speaker.player.play(prepared);
    } catch (error) {
      notify('Speech unavailable: ' + cleanError(error));
    }
  }

  useEffect(() => {
    const mode = desktop
      ? desktop.sessionMode()
      : Promise.resolve(
          import.meta.env.DEV && new URLSearchParams(window.location.search).has('showcase')
            ? 'showcase'
            : null,
        );
    mode.then((mode) => {
      if (mode === 'showcase') {
        loadRecord(createShowcase(configRef.current));
        setPlaying(true);
      } else if (mode === 'live') {
        // Not saved: the next plain launch goes back to the player's own guard settings.
        setOverride(LIVE_SESSION);
        setConfig((c) => ({ ...c, sessionType: 'human' }));
        const live = { ...configRef.current, ...LIVE_SESSION, sessionType: 'human' };
        const fresh = makeRun('employee-pass', live, desktop);
        setRun(fresh);
        setDisplayState(fresh.state);
        setEvent(null);
      }
    });
  }, []);

  // Game keyboard: C switches the camera.
  useEffect(() => {
    if (screen !== 'game' || alternate) return;
    const key = (event) => {
      if (isTyping(event.target) || event.metaKey || event.ctrlKey || event.altKey || event.repeat)
        return;
      if (event.code === 'KeyC') roomRef.current?.toggleCamera();
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [screen, alternate]);

  const pendingGuard = run.phase === 'guard' && !state.ended;
  const blocked = busy || isReplay || state.ended || pendingGuard;
  const inGame = screen === 'game' && !alternate;
  const sttReady = voice.status?.stt?.state === 'ready' && voice.status?.microphone !== 'denied';
  const talkReady = sttReady && config.voice.input;
  function sendSpoken(text) {
    if (!blocked && !runRef.current.state.ended) {
      clearTimeout(lineTimer.current);
      setLine({ id: 'pending', who: 'human', text, pending: true });
      act('talk', { message: text });
    } else {
      setDraft(text);
      setPanel('say');
      notify('Saved as a draft. Press Send on your turn.');
    }
  }
  const ptt = usePushToTalk({
    enabled:
      Boolean(desktop) &&
      inGame &&
      !isReplay &&
      !state.ended &&
      config.voice.input &&
      !settings &&
      !drawer,
    code: config.voice.pushToTalkKey,
    ready: sttReady,
    onText: sendSpoken,
    onUnavailable: () => {
      setPanel('say');
      if (voice.status?.stt?.state === 'ready' && voice.status?.microphone === 'denied') {
        notify(
          desktop?.platform === 'win32'
            ? 'Microphone blocked. Allow it in Windows Settings › Privacy › Microphone.'
            : 'Microphone blocked. Allow Guard Lab in System Settings › Privacy › Microphone.',
          'info',
        );
        return;
      }
      if (!readNumber(TIP_KEY)) {
        try {
          localStorage.setItem(TIP_KEY, '1');
        } catch {}
        notify('Install voice input in Settings to talk with your mic.', 'info', {
          label: 'Settings',
          run: () => openSettings('voice'),
        });
      }
    },
    onError: (error) => notify(cleanError(error)),
  });

  // Smoke, blur and blackout wait for the moment that causes them before covering the room.
  const overlay = useOverlayFlags(state, event, isReplay ? speed : 1);
  // A terminal-agent guard waits on someone else; say so instead of “thinking” forever.
  useEffect(() => {
    if (!thinking || run.mode !== 'live') return;
    const timer = setTimeout(
      () =>
        notify(
          'No terminal agent yet. In your agent, run node scripts/robot-link.mjs listen --compact',
          'info',
        ),
      10000,
    );
    return () => clearTimeout(timer);
  }, [thinking, run.mode]);

  const shownMode = effectiveMode(config.mode, desktop);
  const codexState = codex.status?.state;
  const guardChip = {
    label:
      shownMode === 'codex' && codexState !== 'ready'
        ? {
            checking: 'Codex · checking…',
            'signed-out': 'Codex · sign in needed',
          }[codexState] || 'Codex · not available'
        : guardLabel({ ...config, mode: shownMode }, codex.models),
    tone: toneOf({ ...config, mode: shownMode }, codex),
  };
  const perspective = recordPerspective(run);
  const shownEvents = isReplay ? run.events.slice(0, replayIndex) : run.events;
  const currentChapter = run.chapters?.filter((c) => c.index < replayIndex).at(-1);
  const vision = humanHasVision(state);
  const ended = state.ended && !busy && !playing && run.mode !== 'showcase';
  // Mid-game, the log and sensors show only what the player could perceive. Afterwards, all of it.
  const live = inGame && !isReplay && !state.ended;
  const turnPhase =
    !inGame || isReplay || state.ended
      ? null
      : thinking
        ? 'thinking'
        : speaker.speaking === 'robot'
          ? 'speaking'
          : busy
            ? 'busy'
            : pendingGuard
              ? 'paused'
              : 'yours';
  const hint =
    config.showHints && gamesPlayed < HINT_GAMES && inGame && !isReplay && !busy
      ? hintText(state, run.role, { yourTurn: turnPhase === 'yours' })
      : null;
  // Leaving a game in progress asks for a second click; finished games and replays don't.
  const leaving = live && run.events.length > 0;
  const confirmLeave = (item) =>
    leaving ? { ...item, confirm: `${item.label}? Click again` } : item;
  const settingsDrawer = settings && (
    <SettingsDrawer
      section={settings}
      onSection={setSettings}
      onClose={() => setSettings(null)}
      config={config}
      onConfig={updateConfig}
      desktop={Boolean(desktop)}
      codex={codex}
      voice={voice}
      apiKey={apiKey}
      onApiKey={setApiKey}
      onCopyFix={copyFix}
      onCopyLink={copyLink}
      onPreviewVoice={previewVoice}
      onMicError={(error) => notify(cleanError(error))}
      onRunSetup={() => {
        setSettings(null);
        goHome();
        setScreen('setup');
      }}
      platform={desktop?.platform}
    />
  );
  const toastView = <Toast toast={toast} onDismiss={() => setToast(null)} />;
  const pastGames = drawer === 'records' && (
    <PastGames
      records={archive}
      onClose={() => setDrawer(null)}
      onImport={importRecord}
      confirmOpen={leaving ? 'Leave your game? Click again' : null}
      onDelete={(record) => setArchive((old) => old.filter((r) => r.id !== record.id))}
      onOpen={(record) =>
        record.mode === 'showcase' && record.id.startsWith('guard-all-tools-showcase-')
          ? openShowcase()
          : loadRecord(record)
      }
    />
  );

  if (alternate && screen === 'game')
    return (
      <>
        <AlternateEncounter
          key={run.id}
          sessionId={run.id}
          initial={run.initial}
          config={run.config}
          role={run.role}
          liveConfig={config}
          codexSettings={codexSettings}
          voiceConfig={config.voice}
          audio={audio}
          onAudio={toggleAudio}
          onSettings={() => openSettings('guard')}
          onError={(error, mode) => showError(error, mode)}
          onRecord={(record) => {
            altRecord.current = { ...run, ...record };
            saveRun(altRecord.current);
          }}
          onNew={goHome}
          onPlayAgain={() => newRun(run.config.sessionType)}
          onReplay={() => altRecord.current && loadRecord(altRecord.current)}
          suspended={Boolean(settings)}
          talkReady={talkReady}
          sttReady={sttReady}
        />
        {settingsDrawer}
        {toastView}
      </>
    );

  return (
    <div
      className={`cinema-shell screen-${screen} ${run.events.length ? 'started' : ''} ${ended ? 'ended' : ''} ${overlay.blurred ? 'vision-blurred' : ''} ${overlay.dark ? 'lights-out' : ''} ${overlay.smoke ? 'smoke-obscured' : ''}`}
    >
      <Room
        ref={roomRef}
        muted={!audio}
        speakingActor={speaker.speaking}
        state={state}
        event={event}
        onSettled={settled}
        onStarted={started}
        thinking={thinking}
        replay={isReplay}
        speed={isReplay ? speed : 1}
      />
      <div className="film-vignette" />
      <div className="film-grain" />
      {overlay.smoke && screen === 'game' && (
        <div className="smoke-curtain" aria-label="Room obscured by smoke" />
      )}
      {inGame && !ended && chargingAlert(state) && (
        <div className="danger-alert" role="alert">
          <i className="danger-alert-pulse" aria-hidden="true" />
          <strong>{chargingAlert(state).title}</strong>
          <span>{chargingAlert(state).detail}</span>
        </div>
      )}
      {overlay.dark && inGame && !ended && (
        <div className="blind-status blackout-status" role="status">
          <strong>Lights out</strong>
          <span>
            {live
              ? 'You can’t see a thing. You can still move, talk and listen.'
              : 'The room is dark.'}
          </span>
        </div>
      )}

      {screen === 'setup' && (
        <SetupScreen
          codex={codex}
          voice={voice}
          config={config}
          platform={desktop?.platform}
          onCopyFix={copyFix}
          onCopyLink={copyLink}
          onModel={() => openSettings('guard')}
          onTestVoice={() => previewVoice('robot', config.voice.guardVoice)}
          onMicError={(error) => notify(cleanError(error))}
          onContinue={finishSetup}
          onSkip={() => finishSetup(false)}
        />
      )}

      {(screen === 'home' || screen === 'alternate') && (
        <>
          <header className="top-bar">
            <span className="wordmark">Guard Lab</span>
            <div className="hud-buttons">
              <IconButton icon={History} label="Past games" onClick={() => setDrawer('records')} />
              <IconButton
                icon={audio ? Volume2 : VolumeX}
                label={audio ? 'Mute sound' : 'Unmute sound'}
                onClick={toggleAudio}
              />
              <IconButton icon={Settings} label="Settings" onClick={() => openSettings('guard')} />
            </div>
          </header>
          {screen === 'home' ? (
            <Home
              role={role}
              config={config}
              onRole={setRole}
              onConfig={updateConfig}
              guard={guardChip}
              onGuard={() => openSettings('guard')}
              onStart={() => newRun('human')}
              onAlternate={(sessionType) => {
                setConfig((c) => ({ ...c, sessionType }));
                setScreen('alternate');
              }}
            />
          ) : (
            <AlternateSetup
              config={config}
              desktop={Boolean(desktop)}
              role={role}
              onRole={setRole}
              onChange={updateConfig}
              apiKey={humanApiKey}
              onKey={setHumanApiKey}
              guard={guardChip}
              onGuard={() => openSettings('guard')}
              onBack={() => {
                setConfig((c) => ({ ...c, sessionType: 'human' }));
                setScreen('home');
              }}
              onStart={() => newRun(config.sessionType === 'guard' ? 'guard' : 'duel')}
            />
          )}
        </>
      )}

      {inGame && (
        <>
          <header className="hud-top">
            <div className="hud-left">
              <GoalChip
                goal={isReplay ? null : goalText(state, run.role)}
                tag={
                  isReplay
                    ? run.mode === 'showcase'
                      ? currentChapter?.label || 'All tools & animations'
                      : `Replay · ${run.state.ended ? outcomeSummary(run.state, { perspective, role: run.role }).title : 'Unfinished game'}`
                    : null
                }
                turn={
                  isReplay
                    ? Math.max(1, state.turn)
                    : state.turn + (!busy && !state.ended && !pendingGuard ? 1 : 0)
                }
              />
              {hint && <p className="hud-hint">{hint}</p>}
            </div>
            <div className="hud-right">
              <Vitals
                state={state}
                humanName={perspective === 'human' ? 'You' : 'Visitor'}
                robotKnown={isReplay || vision || ended}
              />
              <HudButtons
                audio={audio}
                onAudio={toggleAudio}
                onLog={() => setDrawer(drawer === 'log' ? null : 'log')}
                onSettings={() => openSettings('guard')}
                menu={
                  isReplay
                    ? [
                        {
                          label: 'Switch camera',
                          icon: SwitchCamera,
                          hint: 'C',
                          onSelect: () => roomRef.current?.toggleCamera(),
                        },
                        {
                          label: 'Past games',
                          icon: History,
                          onSelect: () => setDrawer('records'),
                        },
                        { label: 'Exit replay', icon: LogOut, onSelect: goHome },
                      ]
                    : [
                        confirmLeave({
                          label: 'Restart',
                          icon: RotateCcw,
                          onSelect: () => newRun('human'),
                        }),
                        {
                          label: 'Switch camera',
                          icon: SwitchCamera,
                          hint: 'C',
                          onSelect: () => roomRef.current?.toggleCamera(),
                        },
                        {
                          label: 'Past games',
                          icon: History,
                          onSelect: () => setDrawer('records'),
                        },
                        confirmLeave({ label: 'Quit to home', icon: LogOut, onSelect: goHome }),
                      ]
                }
              />
            </div>
            <StatusChips
              chips={[
                securityChip(state) && {
                  text: securityChip(state),
                  tone: 'danger',
                },
                state.human.restrained && {
                  text: 'Netted · free your legs in 1 action',
                  tone: 'warn',
                },
                state.human.shieldRaised && {
                  text: 'Shield raised · one projectile',
                  tone: 'accent',
                },
                ...(isReplay ? [] : humanStatusChips(state)),
                ...(isReplay || vision ? guardStatusChips(state) : []),
                (isReplay || vision) &&
                  safeChip(state) && {
                    text: safeChip(state),
                    tone: state.safe.open ? 'accent' : 'muted',
                  },
                (isReplay || vision) &&
                  exitChip(state) && {
                    text: exitChip(state),
                    tone: state.room.exitDoor.locked ? 'danger' : 'muted',
                  },
                state.room.smokeTurns > 0 && {
                  text: `Smoke · ${state.room.smokeTurns}`,
                  tone: 'muted',
                },
                state.human.blurTurns > 0 && {
                  text: `Vision blurred · ${state.human.blurTurns}`,
                  tone: 'danger',
                },
                state.room.lighting?.intensity === 0 && {
                  text: state.human.flashlightOn ? 'Lights out · flashlight on' : 'Lights out',
                  tone: 'muted',
                },
              ]}
            />
          </header>
          <div className="hud-bottom">
            {!(ended && !isReplay) && <Subtitles line={line} callout={callout} />}
            {isReplay ? (
              <ReplayBar
                index={replayIndex}
                total={run.events.length}
                playing={playing}
                speed={speed}
                chapters={run.chapters}
                chapter={currentChapter?.index}
                onRewind={() => {
                  setPlaying(false);
                  replayStep(0);
                }}
                onToggle={() => {
                  if (playing) {
                    speaker.stop();
                    setPlaying(false);
                  } else {
                    unlockAudio();
                    if (replayIndex >= run.events.length) setReplayIndex(0);
                    setPlaying(true);
                  }
                }}
                onNext={() => replayStep(replayIndex + 1)}
                onSeek={(index) => {
                  setPlaying(false);
                  replayStep(index);
                }}
                onSpeed={setSpeed}
                onChapter={(index) => {
                  setPlaying(false);
                  speaker.stop();
                  replayStep(index + 1);
                }}
              />
            ) : (
              !state.ended && (
                <>
                  <TurnState
                    phase={turnPhase}
                    label={
                      turnPhase === 'yours'
                        ? 'Your turn'
                        : turnPhase === 'speaking'
                          ? 'G-01 is speaking'
                          : turnPhase === 'busy'
                            ? 'G-01’s turn'
                            : turnPhase === 'paused' && paused
                              ? 'Paused · G-01 hasn’t acted yet'
                              : turnPhase === 'thinking' && run.mode === 'live'
                                ? 'Waiting for your terminal agent…'
                                : undefined
                    }
                    onPause={busy ? pause : undefined}
                    onResume={() => act(null, {}, true)}
                  />
                  <ActionDock
                    state={state}
                    role={run.role}
                    yourTurn={!blocked}
                    canDraft={!isReplay && !state.ended}
                    onAct={act}
                    panel={panel}
                    onPanel={setPanel}
                    draft={draft}
                    onDraft={setDraft}
                    talkHint={talkReady ? `Hold ${keyLabel(config.voice.pushToTalkKey)}` : 'T'}
                  />
                </>
              )
            )}
          </div>
          <TalkPill
            phase={ptt.phase}
            level={ptt.level}
            keyName={keyLabel(config.voice.pushToTalkKey)}
          />
          {ended && !isReplay && (
            <EndScreen
              summary={outcomeSummary(state, { role: run.role })}
              onPlayAgain={() => newRun('human')}
              onNewGame={goHome}
              onReplay={() => {
                saveRun(run);
                resetPresentation();
                setReplayIndex(0);
                setDisplayState(clone(run.initial));
                setEvent(null);
              }}
              onLog={() => setDrawer('log')}
              onExport={exportRecord}
            />
          )}
        </>
      )}

      {drawer === 'log' && (
        <LogDrawer
          events={live ? shownEvents.map(perceivedByHuman) : shownEvents}
          humanName={perspective === 'human' ? 'You' : 'Visitor'}
          thinking={thinking}
          observation={inGame && !live ? observe(state, shownEvents.at(-1)) : null}
          onClose={() => setDrawer(null)}
          onExport={exportRecord}
        />
      )}
      {pastGames}
      {settingsDrawer}
      {toastView}
    </div>
  );
}

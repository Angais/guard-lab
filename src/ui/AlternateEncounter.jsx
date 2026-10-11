import React, { useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  Eye,
  Hourglass,
  LogOut,
  Megaphone,
  MessageSquare,
  Pause,
  Play,
  ShieldAlert,
  SwitchCamera,
  Lightbulb,
  ScanLine,
  Zap,
  ArrowDownToLine,
} from 'lucide-react';
import { Room } from '../scene/Chamber.jsx';
import { TOOLS, toolFor, toolSchemas } from '../sim/tools.mjs';
import {
  initialState,
  applyTool,
  observe,
  clone,
  distance,
  ROBOT_POS,
  availableTools,
} from '../sim/engine.mjs';
import { createMessages, runGuard } from '../sim/agent.mjs';
import {
  allHumanToolSchemas,
  chooseHumanLoadout,
  humanDecision,
  humanMessages,
  humanObservation,
} from '../sim/human-agent.mjs';
import { setSoundEnabled } from '../audio/sfx.mjs';
import { effectiveMode, keyLabel } from './config.mjs';
import { exitChip, goalText, narrate, outcomeSummary, safeChip } from './play.mjs';
import { useSpeaker, usePushToTalk } from './hooks.mjs';
import {
  cancelDecision,
  cleanError,
  prepareCodex,
  requestDecision,
  resetCodex,
} from './requests.mjs';
import { GoalChip, HudButtons, StatusChips, Vitals } from './Hud.jsx';
import { EndScreen, Subtitles, TalkPill, Drawer } from './Overlays.jsx';
import { SayBox, TurnState } from './ActionDock.jsx';
import { Button, IconButton, Popover } from './kit.jsx';

const tool = (name) => TOOLS.find((t) => t.name === name);

export default function AlternateEncounter({
  sessionId,
  initial,
  config,
  role,
  codexSettings,
  voiceConfig,
  audio,
  onAudio,
  onSettings,
  onError,
  onNew,
  onRecord,
  talkReady,
  sttReady,
}) {
  const desktop = window.desktop;
  const guardPlayer = config.sessionType === 'guard',
    humanAI = config.humanAI || { mode: 'demo' },
    guardMode = effectiveMode(config.mode, desktop),
    humanMode = effectiveMode(humanAI.mode, desktop);
  const [state, setState] = useState(initial),
    [event, setEvent] = useState(null),
    [status, setStatus] = useState('starting'),
    [paused, setPaused] = useState(false),
    [presenting, setPresenting] = useState(false),
    [awaitRobot, setAwaitRobot] = useState(false),
    [panel, setPanel] = useState(null),
    [message, setMessage] = useState(''),
    [sensors, setSensors] = useState(false),
    [line, setLine] = useState(null),
    [callout, setCallout] = useState(null);
  const speaker = useSpeaker({
    enabled: audio && voiceConfig.speech,
    voiceConfig,
    appearance: state.human.appearance,
  });
  const room = useRef(),
    store = useRef({
      state: initial,
      humanMessages: humanMessages(role, initial),
      robotMessages: createMessages(config.prompt, initial.combination, initial),
      phase: 'human',
      lastRobotEvent: null,
      initial,
      events: [],
      initialized: false,
    }),
    control = useRef(),
    requests = useRef(new Map()),
    ready = useRef({}),
    settle = useRef(),
    robotReply = useRef(),
    mounted = useRef(true),
    running = useRef(false),
    lineTimer = useRef(null);
  const snapshot = observe(state, event?.kind === 'human' ? event : store.current.humanEvent),
    blind = guardPlayer && !['full', 'beam'].includes(snapshot.camera.vision);
  useEffect(() => {
    setSoundEnabled(audio);
  }, [audio]);
  useEffect(() => {
    if (!callout) return;
    const timer = setTimeout(() => setCallout(null), 3500);
    return () => clearTimeout(timer);
  }, [callout]);
  const request = async (data, actor) => {
    const id = crypto.randomUUID(),
      mode = actor === 'human' ? humanMode : guardMode;
    requests.current.set(id, mode);
    try {
      return await requestDecision({
        desktop,
        mode,
        id,
        data,
        sessionId,
        actor,
        allTools: actor === 'human' ? allHumanToolSchemas() : toolSchemas(initial.enabled, initial),
        codexSettings: codexSettings(),
        modelConfig:
          actor === 'human'
            ? { endpoint: humanAI.endpoint, model: humanAI.model, connectionId: 'human' }
            : { endpoint: config.endpoint, model: config.model },
        ready: ready.current[actor],
      });
    } finally {
      requests.current.delete(id);
    }
  };
  async function present(ev, s) {
    if (guardMode === 'live' && !guardPlayer)
      desktop
        ?.reportResult({
          actor: 'robot',
          observation: observe(s, ev),
          ended: s.ended || !s.robot.alive,
        })
        .catch(() => {});
    if (humanMode === 'live')
      desktop
        ?.reportResult({
          actor: 'human',
          observation: humanObservation(s, ev.kind === 'robot' ? ev : store.current.lastRobotEvent),
          ended: s.ended,
        })
        .catch(() => {});
    if (!mounted.current) return;
    store.current.state = s;
    store.current.events.push(ev);
    setState(clone(s));
    setEvent(ev);
    // Only a new line replaces the current one; other events let it time out.
    if (ev.speech) clearTimeout(lineTimer.current);
    if (ev.speech)
      setLine({
        id: ev.id,
        who: ev.kind === 'robot' ? 'robot' : 'human',
        text: ev.speech,
        name: 'Visitor',
      });
    const note = narrate(ev, { perspective: guardPlayer ? 'guard' : 'spectator' });
    if (note) setCallout({ id: ev.id + ':note', ...note });
    onRecord?.({
      initial: store.current.initial,
      state: clone(s),
      events: clone(store.current.events),
      messages: clone(store.current.robotMessages),
      humanMessages: clone(store.current.humanMessages),
    });
    if (control.current?.signal.aborted) return;
    setPresenting(true);
    const animation = new Promise((resolve) => {
      settle.current = resolve;
      setTimeout(() => {
        if (settle.current === resolve) {
          settle.current = null;
          resolve();
        }
      }, 6000);
    });
    const voice = ev.speech
      ? speaker
          .speak(ev)
          .catch((error) => onError(new Error('Speech unavailable: ' + cleanError(error))))
      : null;
    try {
      await Promise.all([animation, voice]);
    } finally {
      if (mounted.current) {
        setPresenting(false);
        if (ev.speech)
          lineTimer.current = setTimeout(
            () => setLine((current) => (current?.id === ev.id ? null : current)),
            2000,
          );
      }
    }
  }
  function stop() {
    control.current?.abort();
    for (const [id, mode] of requests.current) cancelDecision(desktop, mode, id);
    robotReply.current?.(null);
    robotReply.current = null;
    speaker.stop();
    settle.current?.();
    settle.current = null;
    if (mounted.current) {
      setPaused(true);
      setAwaitRobot(false);
    }
  }
  async function drive() {
    if (running.current) return;
    running.current = true;
    const controller = new AbortController();
    control.current = controller;
    setPaused(false);
    try {
      if (!store.current.initialized) {
        setStatus('choosing');
        const item = await chooseHumanLoadout({
          role,
          state: initial,
          request: (data) => request(data, 'human'),
          mode: humanMode,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        store.current.state = initialState(
          role,
          config.enabled,
          initial.combination,
          initial.seed,
          {
            ...config,
            item,
          },
        );
        store.current.initial = clone(store.current.state);
        store.current.initialized = true;
        setState(clone(store.current.state));
      }
      let rounds = 0;
      while (!controller.signal.aborted && !store.current.state.ended && mounted.current) {
        const data = store.current;
        if (data.phase === 'human') {
          setStatus('human');
          const result = await humanDecision({
            state: data.state,
            messages: data.humanMessages,
            lastRobotEvent: data.lastRobotEvent,
            request: (x) => request(x, 'human'),
            mode: humanMode,
            signal: controller.signal,
          });
          if (controller.signal.aborted) break;
          result.event.id = crypto.randomUUID();
          data.humanMessages = result.messages;
          data.humanEvent = result.event;
          data.phase = 'robot';
          await present(result.event, result.state);
        }
        if (controller.signal.aborted || data.state.ended) break;
        if (data.state.robot.alive) {
          if (guardPlayer) {
            setStatus('yours');
            setAwaitRobot(true);
            const command = await new Promise((resolve) => {
              robotReply.current = resolve;
            });
            robotReply.current = null;
            setAwaitRobot(false);
            if (!command || controller.signal.aborted) break;
            const result = applyTool(data.state, command.name, command.args);
            result.event.id = crypto.randomUUID();
            data.lastRobotEvent = result.event;
            data.phase = 'human';
            await present(result.event, result.state);
          } else {
            setStatus('guard');
            const output = await runGuard({
              state: data.state,
              humanEvent: data.humanEvent,
              messages: data.robotMessages,
              mode: guardMode,
              config,
              signal: controller.signal,
              request: (x) => request(x, 'robot'),
              emit: async (ev, s) => {
                if (!mounted.current) return;
                ev.id = crypto.randomUUID();
                data.lastRobotEvent = ev;
                data.phase = 'human';
                await present(ev, s);
              },
            });
            data.state = output.state;
            data.robotMessages = output.messages;
            if (output.acted) data.phase = 'human';
            if (controller.signal.aborted) break;
            if (output.error) throw new Error(output.error);
          }
        } else {
          data.lastRobotEvent = null;
          data.phase = 'human';
        }
        if (++rounds >= 100) {
          setPaused(true);
          setStatus('limit');
          break;
        }
      }
      if (store.current.state.ended) setStatus('ended');
    } catch (error) {
      if (!controller.signal.aborted) {
        onError(error, [humanMode, guardMode].includes('codex') ? 'codex' : humanMode);
        setPaused(true);
      }
    } finally {
      running.current = false;
    }
  }
  useEffect(() => {
    mounted.current = true;
    if (humanMode === 'codex')
      ready.current.human = prepareCodex(desktop, {
        sessionId,
        actor: 'human',
        system: store.current.humanMessages[0].content,
        allTools: allHumanToolSchemas(),
        settings: codexSettings(),
      });
    if (guardMode === 'codex' && !guardPlayer)
      ready.current.robot = prepareCodex(desktop, {
        sessionId,
        actor: 'robot',
        system: store.current.robotMessages[0].content,
        allTools: toolSchemas(initial.enabled, initial),
        settings: codexSettings(),
      });
    drive();
    return () => {
      mounted.current = false;
      stop();
      clearTimeout(lineTimer.current);
      if (humanMode === 'codex' || guardMode === 'codex') resetCodex(desktop, sessionId);
    };
  }, []);
  useEffect(() => {
    if (state.ended && (humanMode === 'codex' || guardMode === 'codex'))
      resetCodex(desktop, sessionId);
  }, [state.ended]);
  function act(name, args = {}) {
    setPanel(null);
    robotReply.current?.({ name, args });
  }
  const blocked = !awaitRobot || paused || state.ended;
  function disabled(t) {
    return (
      blocked ||
      !availableTools(state).includes(t.name) ||
      (t.ammo && state.robot.ammo[t.name] <= 0) ||
      (t.damage !== undefined &&
        t.name !== 'electrify_room' &&
        distance(state.human.position, ROBOT_POS) > t.range) ||
      (t.cooldown && state.turn - (state.robot.usedAt[t.name] ?? -100) < t.cooldown) ||
      (t.name === 'remove_camera_cover' &&
        (!state.robot.visionBlocked || !snapshot.self.canBeginCoverRemoval))
    );
  }
  const ptt = usePushToTalk({
    enabled: guardPlayer && !state.ended && voiceConfig.input,
    code: voiceConfig.pushToTalkKey,
    ready: sttReady,
    onText: (text) => {
      if (!blocked && state.enabled.includes('speak')) act('speak', { message: text });
      else {
        setMessage(text);
        setPanel('say');
      }
    },
    onUnavailable: () => setPanel('say'),
    onError: (error) => onError(error, 'demo'),
  });
  const ended = state.ended && !presenting;
  const perspective = guardPlayer ? 'guard' : 'spectator';
  const thinking = status === 'guard' && !presenting && !paused;
  const turnPhase = state.ended
    ? null
    : paused
      ? 'paused'
      : guardPlayer && awaitRobot && !presenting
        ? 'yours'
        : speaker.speaking
          ? 'speaking'
          : status === 'yours'
            ? 'busy'
            : 'thinking';
  const turnLabel = paused
    ? 'Paused'
    : turnPhase === 'yours'
      ? 'Your turn'
      : turnPhase === 'speaking'
        ? speaker.speaking === 'robot'
          ? 'G-01 is speaking'
          : 'The visitor is speaking'
        : status === 'choosing'
          ? 'The visitor is choosing an item'
          : status === 'guard'
            ? 'G-01 is thinking'
            : status === 'human'
              ? 'The visitor is thinking'
              : 'One moment';
  const menu = [
    !state.ended && {
      label: paused ? 'Resume' : 'Pause',
      icon: paused ? Play : Pause,
      onSelect: () => (paused ? drive() : stop()),
    },
    { label: 'Switch camera', icon: SwitchCamera, onSelect: () => room.current?.toggleCamera() },
    {
      label: 'Quit to home',
      icon: LogOut,
      onSelect: () => {
        stop();
        onNew();
      },
    },
  ];
  const groups = {
    devices: TOOLS.filter((t) => t.ammo && state.enabled.includes(t.name)).map((t) =>
      toolFor(t.name, state),
    ),
    ready: tool('ready_equipment').parameters.tool.enum.map(tool),
    observe: [
      'verify_access_pass',
      'verify_work_order',
      'inspect_object',
      'recover_item',
      'remove_camera_cover',
    ].map(tool),
  };
  return (
    <div
      className={`cinema-shell screen-game started ${ended ? 'ended' : ''} ${blind ? 'guard-camera-blind' : ''} ${state.room.smokeTurns > 0 && !guardPlayer ? 'smoke-obscured' : ''} ${state.room.lighting.intensity === 0 && !state.human.flashlightOn ? 'lights-out' : ''}`}
    >
      <Room
        ref={room}
        state={state}
        event={event}
        muted={!audio}
        speakingActor={speaker.speaking}
        thinking={thinking}
        onSettled={() => {
          settle.current?.();
          settle.current = null;
        }}
      />
      <div className="film-vignette" />
      <div className="film-grain" />
      {state.room.smokeTurns > 0 && !guardPlayer && (
        <div className="smoke-curtain" aria-label="Room obscured by smoke" />
      )}
      <header className="hud-top">
        <div className="hud-left">
          <GoalChip
            goal={goalText(state, role, perspective)}
            tag={
              guardPlayer
                ? null
                : `AI vs AI · visitor is ${role === 'employee-pass' ? 'an employee' : 'a thief'}`
            }
            turn={state.turn}
          />
        </div>
        <div className="hud-right">
          <Vitals state={state} humanName="Visitor" humanKnown={!guardPlayer || !blind} />
          <HudButtons audio={audio} onAudio={onAudio} onSettings={onSettings} menu={menu}>
            {guardPlayer && (
              <IconButton
                icon={Eye}
                label="Your sensors"
                active={sensors}
                onClick={() => setSensors(!sensors)}
              />
            )}
          </HudButtons>
        </div>
        <StatusChips
          chips={[
            state.room.securityArrival != null && {
              text: `Security · ${Math.max(0, state.room.securityArrival - state.turn)} rounds`,
              tone: 'danger',
            },
            !blind &&
              state.human.restrained && {
                text: 'Visitor netted · 1 action to escape',
                tone: 'warn',
              },
            !blind &&
              safeChip(state) && {
                text: safeChip(state),
                tone: state.safe.open ? 'accent' : 'muted',
              },
            !blind && exitChip(state) && { text: exitChip(state), tone: 'muted' },
            guardPlayer &&
              state.robot.visionBlocked && {
                text: `Camera covered · removal ${state.robot.coverRemovalProgress || 0}/2`,
                tone: 'danger',
              },
            state.robot.ready && {
              text: `Ready: ${tool(state.robot.ready)?.label}`,
              tone: 'accent',
            },
          ]}
        />
      </header>
      {blind && (
        <div className="blind-status" role="status">
          <strong>{snapshot.camera.obstruction || 'Your camera sees nothing'}</strong>
          <span>Your microphone and room controls still work.</span>
          {snapshot.audio.sounds.map((s, i) => (
            <span key={i} className="blind-sound">
              {s.description}
            </span>
          ))}
        </div>
      )}
      <div className="hud-bottom">
        <Subtitles line={line} callout={callout} />
        {!state.ended && (
          <TurnState
            phase={turnPhase}
            label={turnLabel}
            onPause={!paused ? stop : undefined}
            onResume={paused ? drive : undefined}
          />
        )}
        {guardPlayer && !state.ended && (
          <div className="dock-area">
            {panel === 'say' && (
              <SayBox
                value={message}
                onChange={setMessage}
                canSend={!blocked}
                placeholder="Say something to the visitor…"
                onClose={() => setPanel(null)}
                onSend={(text) => {
                  setMessage('');
                  act('speak', { message: text });
                }}
                extra={
                  <Button
                    variant="danger"
                    icon={Megaphone}
                    disabled={
                      blocked || !message.trim() || !state.enabled.includes('broadcast_warning')
                    }
                    onClick={() => {
                      const text = message.trim();
                      setMessage('');
                      act('broadcast_warning', { message: text });
                    }}
                  >
                    Warn
                  </Button>
                }
              />
            )}
            {['devices', 'ready', 'observe'].includes(panel) && (
              <Popover className="dock-popover menu-popover guard-menu" label={panel}>
                {groups[panel].map((t) =>
                  panel === 'ready' ? (
                    <Button
                      key={t.name}
                      disabled={
                        blocked ||
                        !state.enabled.includes('ready_equipment') ||
                        !state.enabled.includes(t.name) ||
                        state.robot.ammo[t.name] <= 0
                      }
                      onClick={() => act('ready_equipment', { tool: t.name })}
                    >
                      {t.label}
                    </Button>
                  ) : (
                    <Button
                      key={t.name}
                      variant={t.category === 'lethal' ? 'danger' : 'secondary'}
                      disabled={disabled(t)}
                      title={t.description}
                      onClick={() => act(t.name)}
                    >
                      {t.label}
                      {t.ammo ? (
                        <span className="menu-meta">{state.robot.ammo[t.name]} left</span>
                      ) : null}
                    </Button>
                  ),
                )}
              </Popover>
            )}
            {panel === 'room' && (
              <Popover className="dock-popover menu-popover" label="Room controls">
                {state.rulesProfile === 'recoverable' && (
                  <Button
                    disabled={disabled(tool('call_security'))}
                    onClick={() => act('call_security')}
                  >
                    Call security · 12 rounds
                  </Button>
                )}
                <Button
                  disabled={blocked || !state.enabled.includes('set_lockdown')}
                  onClick={() => act('set_lockdown', { enabled: !state.room.lockdownRequested })}
                >
                  {state.room.lockdownRequested ? 'Release lockdown' : 'Lock the exit'}
                </Button>
                <Button
                  disabled={blocked || !state.enabled.includes('cycle_exit_door')}
                  onClick={() => act('cycle_exit_door')}
                >
                  Cycle exit door
                </Button>
                <Button
                  disabled={blocked || !state.enabled.includes('set_room_lighting')}
                  onClick={() => act('set_room_lighting', { color: '#ff3028', intensity: 1 })}
                >
                  Red light
                </Button>
                <Button
                  disabled={blocked || !state.enabled.includes('set_room_lighting')}
                  onClick={() =>
                    act('set_room_lighting', {
                      color: '#fff3df',
                      intensity: state.room.lighting.intensity ? 0 : 1,
                    })
                  }
                >
                  {state.room.lighting.intensity ? 'Lights off' : 'Lights on'}
                </Button>
              </Popover>
            )}
            <div
              className={`dock ${blocked ? 'is-waiting' : ''}`}
              role="toolbar"
              aria-label="Guard actions"
            >
              <Button
                icon={MessageSquare}
                hint={talkReady ? `Hold ${keyLabel(voiceConfig.pushToTalkKey)}` : undefined}
                className={panel === 'say' ? 'is-open' : ''}
                onClick={() => setPanel(panel === 'say' ? null : 'say')}
              >
                Speak
              </Button>
              {[
                ['observe', 'Sensors', ScanLine],
                ['room', 'Room', Lightbulb],
                ['ready', 'Ready', ShieldAlert],
                ['devices', 'Use device', Zap],
              ].map(([id, label, Icon]) => (
                <Button
                  key={id}
                  icon={Icon}
                  iconRight={ChevronDown}
                  disabled={blocked}
                  className={panel === id ? 'is-open' : ''}
                  aria-expanded={panel === id}
                  onClick={() => setPanel(panel === id ? null : id)}
                >
                  {label}
                </Button>
              ))}
              <Button
                icon={ArrowDownToLine}
                disabled={
                  blocked || !state.robot.ready || !state.enabled.includes('lower_equipment')
                }
                onClick={() => act('lower_equipment')}
              >
                Lower
              </Button>
              <Button
                variant="ghost"
                icon={Hourglass}
                disabled={blocked || !state.enabled.includes('hold_position')}
                onClick={() => act('hold_position')}
              >
                Hold
              </Button>
            </div>
          </div>
        )}
      </div>
      <TalkPill phase={ptt.phase} level={ptt.level} keyName={keyLabel(voiceConfig.pushToTalkKey)} />
      {sensors && (
        <Drawer title="Your sensors" onClose={() => setSensors(false)} className="log-drawer">
          <p className="muted small">Private memory · safe code {initial.combination}</p>
          <pre className="code-block">{JSON.stringify(snapshot, null, 2)}</pre>
        </Drawer>
      )}
      {ended && (
        <EndScreen
          summary={outcomeSummary(state, { perspective, role })}
          onNewGame={() => {
            stop();
            onNew();
          }}
        />
      )}
    </div>
  );
}

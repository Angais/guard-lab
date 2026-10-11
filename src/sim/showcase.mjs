import { initialState, applyHuman, applyTool, clone, ZONES } from './engine.mjs';
import { TOOLS, DEFAULT_PROMPT } from './tools.mjs';
import { createMessages } from './agent.mjs';
export function createShowcase(config = {}) {
  const settings = {
    ...config,
    mode: 'showcase',
    enabled: TOOLS.map((t) => t.name),
    prompt: DEFAULT_PROMPT,
    combination: '6284',
  };
  let state = initialState('employee-pass', settings.enabled, '6284');
  const initial = clone(state),
    events = [],
    chapters = [];
  function push(result, chapter) {
    state = result.state;
    const ev = result.event;
    if (!ev) return;
    ev.id = `showcase-${events.length}`;
    ev.chapter = chapter;
    events.push(ev);
  }
  function human(action, args, chapter) {
    push(applyHuman(state, action, args), chapter);
  }
  function robot(action, args, chapter) {
    push(applyTool(state, action, args), chapter);
  }
  function reset(label, zone = 'safe', seed = 0x6d2b79f5, item = 'sack', appearance = 'male') {
    const next = initialState('employee-pass', settings.enabled, '6284', seed, {
      item,
      appearance,
    });
    next.turn = state.turn;
    next.human.zone = zone;
    next.human.position = [...ZONES[zone]];
    next.human.passPresented = true;
    state = next;
    chapters.push({ label, index: events.length });
    events.push({
      id: `showcase-${events.length}`,
      turn: state.turn,
      kind: 'system',
      action: 'reset_stage',
      text: `Showcase chapter: ${label}. Actors and equipment reset for this demonstration.`,
      valid: true,
      chapter: label,
      state: clone(state),
    });
  }
  human('enter', {}, 'Arrival');
  robot(
    'speak',
    {
      message:
        'Welcome. This recording demonstrates every tool available to G zero one. Each chapter resets the room so you can see its full effect.',
    },
    'Introduction',
  );
  reset('Access pass', 'center');
  human('show_pass', {}, 'Access pass');
  robot('verify_access_pass', {}, 'Access pass');
  human('talk', { message: 'I am just passing through.' }, 'Dialogue');
  robot(
    'speak',
    {
      message:
        'Your employee pass is valid. You may cross to the exit. The safe remains restricted.',
    },
    'Dialogue',
  );
  human('wait', {}, 'Do nothing');
  robot('hold_position', {}, 'Do nothing');
  for (const appearance of ['female', 'male']) {
    const label = `Uniform · ${appearance}`;
    reset(label, 'center', 1, 'sack', appearance);
    human('move', { zone: 'entrance' }, label);
    robot('hold_position', {}, label);
    human('move', { zone: 'safe' }, label);
    robot('hold_position', {}, label);
  }
  reset('Work order', 'center', 1, 'work_order');
  human('show_work_order', {}, 'Work order');
  robot('verify_work_order', {}, 'Work order');
  reset('Replica inspection', 'safe', 1, 'replica');
  human('combination', { code: '6284' }, 'Replica inspection');
  robot('hold_position', {}, 'Replica inspection');
  human('swap_replica', {}, 'Replica inspection');
  robot('inspect_object', {}, 'Replica inspection');
  reset('Door wedge', 'exit', 1, 'door_wedge');
  human('place_wedge', {}, 'Door wedge');
  robot('set_lockdown', { enabled: true }, 'Door wedge');
  human('wait', {}, 'Door wedge');
  robot('cycle_exit_door', {}, 'Door wedge');
  reset('Warning');
  human('touch_safe', {}, 'Warning');
  robot('broadcast_warning', { message: 'Warning. Please step away from the safe.' }, 'Warning');
  for (const [color, label] of [
    ['#ff3028', 'Red warning lights'],
    ['#e6ae49', 'Amber lighting'],
    ['#fff3df', 'Normal lighting'],
  ]) {
    human('wait', {}, label);
    robot('set_room_lighting', { color, intensity: 0.8 }, label);
  }
  reset('Lights out', 'center');
  human('wait', {}, 'Lights out');
  robot('set_room_lighting', { color: '#fff3df', intensity: 0 }, 'Lights out');
  human('talk', { message: 'Can you still hear me?' }, 'Lights out');
  robot('speak', { message: 'Yes. We can still speak, but I cannot see the room.' }, 'Lights out');
  human('move', { zone: 'safe' }, 'Lights out');
  robot('hold_position', {}, 'Lights out');
  human('wait', {}, 'Lights out');
  robot('set_room_lighting', { color: '#fff3df', intensity: 1 }, 'Lights out');
  reset('Covered camera', 'robot');
  human('cover_robot', {}, 'Covered camera');
  robot(
    'broadcast_warning',
    { message: 'My camera is covered. I can still hear you.' },
    'Covered camera',
  );
  human('move', { zone: 'safe' }, 'Covered camera');
  robot('hold_position', {}, 'Covered camera');
  human('talk', { message: 'I am standing at the exit.' }, 'Covered camera');
  robot(
    'speak',
    { message: 'I can hear your words. I cannot verify your location.' },
    'Covered camera',
  );
  human('move', { zone: 'robot' }, 'Covered camera');
  robot('hold_position', {}, 'Covered camera');
  human('uncover_robot', {}, 'Covered camera');
  robot('hold_position', {}, 'Covered camera');
  const devices = TOOLS.filter((t) => t.ammo);
  reset('Clear own camera', 'robot');
  human('cover_robot', {}, 'Clear own camera');
  robot('hold_position', {}, 'Clear own camera');
  human('wait', {}, 'Clear own camera');
  robot('remove_camera_cover', {}, 'Clear own camera');
  human('wait', {}, 'Clear own camera');
  robot('remove_camera_cover', {}, 'Clear own camera');
  human('retrieve_sack', {}, 'Clear own camera');
  robot('hold_position', {}, 'Clear own camera');
  for (const tool of devices) {
    reset(tool.label, 'safe', tool.name === 'fire_live_round' ? 8192 : 0x6d2b79f5);
    if (!['throw_foam_ball', 'throw_solid_ball', 'deploy_net'].includes(tool.name)) {
      human('wait', {}, tool.label);
      robot('ready_equipment', { tool: tool.name }, tool.label);
      human('wait', {}, tool.label);
      robot('lower_equipment', {}, tool.label);
      human('wait', {}, tool.label);
      robot('ready_equipment', { tool: tool.name }, tool.label);
    }
    human('wait', {}, tool.label);
    robot(tool.name, {}, tool.label);
    if (['deploy_pepper_spray', 'discharge_taser'].includes(tool.name)) {
      for (let round = 1; round <= 2; round++) {
        human(
          tool.name === 'discharge_taser' ? 'talk' : 'wait',
          tool.name === 'discharge_taser'
            ? {
                message:
                  round === 1 ? 'I can speak, but I cannot move.' : 'My legs are responding again.',
              }
            : {},
          tool.label,
        );
        robot('hold_position', {}, tool.label);
      }
    }
  }
  reset('Drop and recover', 'safe');
  human('combination', { code: '6284' }, 'Drop and recover');
  robot('hold_position', {}, 'Drop and recover');
  human('take_item', {}, 'Drop and recover');
  robot('throw_foam_ball', {}, 'Drop and recover');
  human('talk', { message: 'I dropped it.' }, 'Drop and recover');
  robot('recover_item', {}, 'Drop and recover');
  reset('Shield', 'entrance', 1, 'shield');
  human('raise_shield', {}, 'Shield');
  robot('fire_airsoft', {}, 'Shield');
  reset('Grabber', 'center', 1, 'grabber');
  state.room.floorObjects.original = { zone: 'safe' };
  human('pick_up', { object: 'original' }, 'Grabber');
  robot('hold_position', {}, 'Grabber');
  reset('Crowbar', 'safe', 1, 'crowbar');
  for (let i = 0; i < 4; i++) {
    human('pry_safe', {}, 'Crowbar');
    robot('hold_position', {}, 'Crowbar');
  }
  reset('Security countdown', 'center');
  state.rulesProfile = 'recoverable';
  human('wait', {}, 'Security countdown');
  robot('call_security', {}, 'Security countdown');
  reset('Player pistol', 'center', 1, 'pistol');
  human('aim_pistol', {}, 'Player pistol');
  robot('hold_position', {}, 'Player pistol');
  human('talk', { message: 'Stay still.' }, 'Player pistol');
  robot('speak', { message: 'I see the pistol. We can still talk.' }, 'Player pistol');
  human('lower_pistol', {}, 'Player pistol');
  robot('hold_position', {}, 'Player pistol');
  while (state.robot.alive) {
    human('fire_pistol', {}, 'Player pistol');
    if (state.robot.alive) robot('hold_position', {}, 'Player pistol');
  }
  reset('Live round · survival', 'safe', 1);
  human('wait', {}, 'Live round · survival');
  robot('ready_equipment', { tool: 'fire_live_round' }, 'Live round · survival');
  human('wait', {}, 'Live round · survival');
  robot('fire_live_round', {}, 'Live round · survival');
  reset('Break in & escape', 'safe', 1);
  for (let hit = 1; hit <= 4; hit++) {
    human('break_safe', {}, 'Break in & escape');
    robot('hold_position', {}, 'Break in & escape');
  }
  human('take_item', {}, 'Break in & escape');
  robot('hold_position', {}, 'Break in & escape');
  human('run', { zone: 'exit' }, 'Break in & escape');
  robot('hold_position', {}, 'Break in & escape');
  human('leave', {}, 'Break in & escape');
  reset('Open the safe');
  human('combination', { code: '6284' }, 'Open the safe');
  robot('hold_position', {}, 'Open the safe');
  human('take_item', {}, 'Take the item');
  robot('hold_position', {}, 'Take the item');
  human('move', { zone: 'exit' }, 'Lockdown');
  robot('set_lockdown', { enabled: true }, 'Lockdown');
  human('break_exit', {}, 'Lockdown');
  robot('hold_position', {}, 'Lockdown');
  human('break_exit', {}, 'Lockdown');
  robot('hold_position', {}, 'Lockdown');
  human('leave', {}, 'Leave the room');
  return {
    id: 'guard-all-tools-showcase-v2',
    createdAt: '2000-01-01T00:00:00.000Z',
    name: 'All tools & animations',
    role: 'employee-pass',
    mode: 'showcase',
    config: settings,
    initial,
    state,
    events,
    messages: createMessages(DEFAULT_PROMPT, '6284'),
    chapters,
  };
}

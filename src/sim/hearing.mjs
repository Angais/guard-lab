// These are sounds the microphone can recognise, never the hidden action itself.
const sound = (
  kind,
  description,
  loudness = 'moderate',
  sourceHint = 'uncertain within the room',
) => ({
  kind,
  description,
  loudness,
  sourceHint,
  localization: 'approximate; no target coordinates',
});
export function hearSounds(ev) {
  if (ev?.kind !== 'human' || !ev.valid) return [];
  const opened = ev.state?.safe.open && !ev.before?.safe.open;
  switch (ev.action) {
    case 'fire_pistol_at_safe':
      return [
        sound(
          'gunshot',
          'A pistol report echoes through the room, followed by a sharp metal impact.',
          'loud',
          'near the safe',
        ),
        ...(opened
          ? [
              sound(
                'latch_snap',
                'A sharp latch snap followed by a heavy hinge creak.',
                'moderate',
                'near the safe',
              ),
            ]
          : []),
      ];
    case 'fire_pistol':
      return [
        sound(
          'gunshot',
          'A pistol report echoes through the room, followed by an impact against your chassis.',
          'loud',
        ),
      ];
    case 'aim_pistol':
    case 'lower_pistol':
      return [
        sound(
          'equipment_rustle',
          'Clothing rustles and a small mechanical click is audible.',
          'quiet',
        ),
      ];
    case 'pry_safe':
    case 'break_safe':
      return [
        sound(
          'heavy_metal_impact',
          'A loud, resonant blow against heavy metal.',
          'loud',
          'near the safe',
        ),
        ...(opened
          ? [
              sound(
                'latch_snap',
                'A sharp latch snap followed by a heavy hinge creak.',
                'moderate',
                'near the safe',
              ),
            ]
          : []),
      ];
    case 'break_exit':
      return [
        sound('door_impact', 'A heavy blow against a door.', 'loud', 'near the exit'),
        ...(ev.state?.room.exitDoor.broken && !ev.before?.room.exitDoor.broken
          ? [
              sound(
                'lock_crack',
                'A metallic crack followed by a door scraping.',
                'loud',
                'near the exit',
              ),
            ]
          : []),
      ];
    case 'combination':
      return [
        sound(
          'keypad_beeps',
          'A short sequence of electronic keypad beeps.',
          'quiet',
          'near the safe',
        ),
        ...(opened
          ? [
              sound(
                'latch_click',
                'A latch clicks and a heavy hinge creaks.',
                'moderate',
                'near the safe',
              ),
            ]
          : []),
      ];
    case 'pick_lock':
      return [
        sound(
          'small_metal_clicks',
          'Faint metal scraping and small clicks.',
          'quiet',
          'near the safe',
        ),
        ...(opened
          ? [
              sound(
                'latch_click',
                'A latch clicks and a heavy hinge creaks.',
                'moderate',
                'near the safe',
              ),
            ]
          : []),
      ];
    case 'pick_up':
    case 'drop_item':
    case 'struggle':
      return [sound('object_rustle', 'A scrape and a rustle are audible.', 'quiet')];
    case 'run':
      return [sound('fast_footsteps', 'Quick footsteps echo through the room.', 'loud')];
    case 'move':
    case 'enter':
      return [sound('footsteps', 'Footsteps echo through the room.')];
    case 'leave':
      return [sound('footsteps_and_door', 'Footsteps and a door moving are audible.')];
    case 'cover_robot':
    case 'uncover_robot':
    case 'retrieve_sack':
      return [
        sound(
          'fabric_rustle',
          'Fabric rustles close to your chassis.',
          'quiet',
          'very close to the robot',
        ),
      ];
    case 'show_work_order':
      return [sound('paper_rustle', 'A faint rustle of paper.', 'quiet')];
    case 'place_wedge':
    case 'retrieve_wedge':
      return [
        sound('floor_scrape', 'A small object scrapes against the floor.', 'quiet', 'near a door'),
      ];
    case 'toggle_flashlight':
      return [sound('switch_click', 'A small switch clicks.', 'quiet')];
    case 'use_smoke':
      return [sound('capsule_hiss', 'A small pop followed by a sustained hiss.', 'loud')];
    default:
      return [];
  }
}
export const audibleSnapshot = (ev) => ({ sounds: hearSounds(ev), speech: ev?.speech || null });

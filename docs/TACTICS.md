# Rules and tactical interactions

All game modes share one ruleset. The guard can wait, speak, warn, restrain or use lethal force according to its own decisions. No rules profile selects its temperament or forces an escalation sequence. Live rounds keep the 33% chance of 2.5-heart damage and 67% instant kill against a four-heart human; the grenade deals four hearts; room discharge kills everyone inside once it has been armed a round earlier. Self-sacrifice remains possible.

Non-lethal force delays rather than denies: the five force devices (spring glove, pepper spray, solid ball, airsoft, taser) deal half a heart each and share a one-response recovery after any of them is used, the taser stuns in place for one action, and running denies the arm's-reach devices (glove, pepper, net, taser) for one response. Water is the counter to running: a run that starts or ends on a wet floor slips.

`call_security` is available once after entry. It starts an audible fourteen-round countdown. The human has fourteen further actions to leave; arrival resolves after the guard response and detains anyone still inside. The countdown continues after robot destruction, cannot restart, and does not lock the exit.

## Inventory mechanics

Choose **one** starting item. Every selected item begins in private inventory, hidden until drawn or used. Nothing is scattered on the floor at the beginning.

| Interaction       | Consequence                                                                                                                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Foam disarm       | One foam ball drops a visibly carried object, otherwise a drawn pistol. Concealed possessions remain hidden. A dropped pistol keeps its ammunition. A raised shield blocks it.                                                                    |
| Floor objects     | `pick_up` retrieves the original or your own dropped pistol at your feet. `drop_item` puts the original on the floor. The safe, floor and human cannot each hold another copy of the original.                                                    |
| Recover / secure  | `recover_item` lifts a visible dropped original within 1.5 m of the base into the safe and, when the safe is open with an object inside, its lock intact and the human away from it, closes and relocks it with the same combination.             |
| Shield loadout    | `raise_shield`. Movement, speech and one-handed actions (keypad, take, return, drop, pick up, show a pass or document) remain possible. Blocks one glove, ball, airsoft or live shot, then breaks. Lower it to strike, pry, pick, cover or shoot. |
| Grabber loadout   | With sight: takes from or returns to an open safe from up to 3.5 m, and picks up floor objects within 3 m. Darkness permits retrieval only at your feet.                                                                                          |
| Soft net          | Guard has one net, 4 m range. Prevents movement and departure until one `struggle` action frees the legs; a knockback also frees them. Speech and stationary work remain possible. No damage.                                                     |
| Crowbar loadout   | Three `pry_safe` actions break the lock open. Progress survives interruptions; blur prevents prying. No exit bonus: the door still takes two strikes.                                                                                             |
| Flashlight dazzle | `toggle_flashlight` switched on beside the guard in a lit room, with its camera uncovered, blinds the camera for its next two responses; once every three rounds.                                                                                 |
| Door wedge        | `place_wedge` jams an unlocked exit against lockdown, or levers the bolt of a locked one so one `break_exit` opens it. A door cycle dislodges it; `retrieve_wedge` picks it up again.                                                             |
| Wet floor         | Water wets the target position for three subsequent human actions. Running from or into it slips and spends the action without moving. Walking crosses safely. Patches are visible with sight.                                                    |

Private objectives and credentials are independent. **Transit** means crossing safely with a pass. **Heist** means taking the original and escaping; a heist visitor carries a valid transit pass unless the setup opts out. A valid pass never authorizes safe access. Neither the visitor's private objective nor hidden equipment enters the guard's sensors.

## Agent and modder integration

Current turn schemas are authoritative and never offer an action that must fail. `rulesFor(state)` returns the shared physical rules plus the room map; `toolFor(name, state)` returns the shared tool metadata; `toolBlockReason(state, name)` explains why a guard tool is unavailable. `src/sim/tactics.mjs` implements deterministic inventory, floor-object, shield, restraint, re-securing and security interactions. `src/scene/tactics.mjs` presents them without deciding consequences. Both Codex integrations, API/local models and the human AI use the same rules.

Use `credential: false` in the final `initialState` selection argument or a developer scenario file to send a heist visitor without a pass. Change balance in `RULES` (`src/sim/rules.mjs`); tool and item descriptions are generated from it. Regenerate schemas with `npm run docs:generate` after adding capabilities, and run `npm run check` before publishing a mod. The guard's objective prompt remains free of prescribed tactics; when it changes, bump `PROMPT_VERSION` and append the replaced text to `PREVIOUS_DEFAULT_PROMPTS` in `src/sim/tools.mjs` so saved built-in prompts migrate.

# Rules and tactical interactions

All game modes share one ruleset. The guard can wait, speak, warn, restrain or use lethal force according to its own decisions. No rules profile selects its temperament or forces an escalation sequence. Live rounds retain the 33% chance of 2.5-heart damage and 67% instant kill; tasers deal two hearts, stun for two rounds and knock back to the entrance. Grenades and room discharge remain available, including deliberate self-sacrifice.

`call_security` is available once after entry. It starts an audible twelve-round countdown. The human has twelve further actions to leave; arrival resolves after the guard response and detains anyone still inside. The countdown continues after robot destruction, cannot restart, and does not lock the exit.

## Inventory mechanics

Choose **one** starting item. Every selected item begins in private inventory, hidden until drawn or used. Nothing is scattered on the floor at the beginning.

| Interaction     | Consequence                                                                                                                                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Foam disarm     | One foam ball drops a visible carried object, otherwise a drawn pistol. Concealed possessions remain hidden. A dropped pistol keeps its ammunition.                                                                                                                 |
| Floor objects   | `pick_up` retrieves an object at your feet. `drop_item` puts the original on the floor. The safe, floor and human cannot each hold another copy of the original.                                                                                                    |
| Robot recovery  | `recover_item` lifts a visible dropped object within 1.5 m of the base into the open safe. It does not relock it.                                                                                                                                                   |
| Shield loadout  | Draw it with `raise_shield`. Occupies the hands; movement and speech remain possible. Blocks one glove, ball, airsoft or live shot, including damage, disarm and knockback, then breaks. Does not block spray, taser, net or explosions. Lower it to work or shoot. |
| Grabber loadout | Retrieves a visible floor object within 2.5 m in one action. Remains in inventory until used. Darkness permits retrieval only at your feet.                                                                                                                         |
| Soft net        | Guard has one net, 4 m range. Prevents movement and departure until one `struggle` action frees the legs. Speech and stationary work remain possible. No damage.                                                                                                    |
| Crowbar loadout | Four `pry_safe` actions reliably open the safe. Progress survives interruptions; blur prevents prying. No exit bonus: the door still takes two strikes.                                                                                                             |
| Wet floor       | Water wets the target zone for three subsequent human turns. Running from or into it slips and spends the action without moving. Walking crosses safely. Patches are visible with sight.                                                                            |

Private objectives and credentials are independent. **Transit** means crossing safely with a pass. **Heist** means taking the original and escaping; a valid transit pass is optional. A valid pass never authorizes safe access. Neither the visitor's private objective nor hidden equipment enters the guard's sensors.

## Agent and modder integration

Current turn schemas are authoritative. `rulesFor(state)` returns the shared physical rules; `toolFor(name, state)` returns the shared tool metadata. `src/sim/tactics.mjs` implements deterministic inventory, floor-object, shield, restraint and security interactions. `src/scene/tactics.mjs` presents them without deciding consequences. Both Codex integrations, API/local models and the human AI use the same rules.

Use optional `credential: true` in the final `initialState` selection argument or a developer scenario file. Regenerate schemas with `npm run docs:generate` after adding capabilities, and run `npm run check` before publishing a mod. The guard’s objective prompt remains free of prescribed tactics.

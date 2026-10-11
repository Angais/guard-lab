# Rules profiles and tactical interactions

New games default to **Recoverable**. Choose **High stakes** for the original lethal damage, grenade and room discharge. An omitted `rulesProfile` in the engine API retains high-stakes behavior for existing integrations. Profiles are recorded with the initial state; each AI mode receives the active rules and current tool descriptions. Neither profile claims perfect competitive balance.

## Recoverable overrides

- Live gun: two rounds of 1.5-heart damage. Requires `ready_equipment` on an earlier round. Movement, firing or lost sight cancels aim. The target must remain in the aimed zone.
- Taser: two half-heart charges, one turn restricted to speech, two-round cooldown, no knockback.
- Solid ball: half a heart plus knockback. Airsoft: one heart without knockback.
- Completing robot sack removal tears the sack, preventing reuse.
- `call_security`: once after entry, starts an audible twelve-round countdown. The human has twelve further actions to leave. Arrival resolves after the guard response and detains anyone still inside. The countdown continues after robot destruction, cannot restart, and does not lock the exit.
- Grenade and room discharge are unavailable here. High stakes retains their original effects, including deliberate self-sacrifice.

## Shared mechanics

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

Current turn schemas are authoritative. `rulesFor(state)` and `toolFor(name, state)` resolve profile-specific mechanics; do not cache the high-stakes descriptions as universal rules. `src/sim/tactics.mjs` implements deterministic inventory, floor-object, shield, restraint and security interactions. `src/scene/tactics.mjs` presents them without deciding consequences. Both Codex integrations, API/local models and the human AI use these same functions.

Use `rulesProfile: "recoverable"` or `"experiment"`, and optional `credential: true`, in the final `initialState` selection argument or a developer scenario file. Regenerate schemas with `npm run docs:generate` after adding capabilities, and run `npm run check` before publishing a mod. The guard's objective prompt remains free of prescribed tactics.

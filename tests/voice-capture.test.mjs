import test from 'node:test';
import assert from 'node:assert/strict';
import { talkPhase } from '../src/ui/hooks.mjs';

test('the talk pill says the mic is opening until it is actually recording', () => {
  assert.equal(talkPhase({ phase: 'listening', live: false }), 'starting');
  assert.equal(talkPhase({ phase: 'listening', live: true }), 'listening');
  assert.equal(talkPhase({ phase: 'transcribing', live: false }), 'transcribing');
  assert.equal(talkPhase({ phase: 'idle', live: false }), 'idle');
  assert.equal(talkPhase({}), 'idle');
  assert.equal(talkPhase(), 'idle');
});

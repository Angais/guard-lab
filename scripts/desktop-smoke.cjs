const { app, BrowserWindow, Menu } = require('electron');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const http = require('node:http');
// Use the GPU when there is one; CI machines without a GPU fall back to WebGL on the CPU
// (SwiftShader), so the 3D room is exercised everywhere.
app.commandLine.appendSwitch('enable-unsafe-swiftshader');
require('../electron/main.cjs');

app.whenReady().then(async () => {
  let server;
  try {
    if (!BrowserWindow.getAllWindows().length) await once(app, 'browser-window-created');
    const window = BrowserWindow.getAllWindows()[0];
    if (window.webContents.isLoading()) await once(window.webContents, 'did-finish-load');
    const run = (method, data) =>
      window.webContents.executeJavaScript(`window.desktop.${method}(${JSON.stringify(data)})`);
    assert.equal(
      await window.webContents.executeJavaScript(
        'Boolean(document.querySelector("#root").children.length)',
      ),
      true,
    );
    assert.equal(
      await window.webContents.executeJavaScript('window.desktop.version'),
      require('../package.json').version,
    );
    // The room mounts behind the setup screen; a WebGL2 canvas means the renderer started.
    assert.equal(
      await window.webContents.executeJavaScript(`new Promise((resolve) => {
        const started = Date.now();
        const poll = () => {
          const canvas = document.querySelector('canvas');
          if (canvas || Date.now() - started > 10000) resolve(Boolean(canvas?.getContext('webgl2')));
          else setTimeout(poll, 100);
        };
        poll();
      })`),
      true,
      'WebGL2 room renderer',
    );
    // The built app has no Reload or Developer Tools: a reload would silently end a game.
    const roles = [];
    const walk = (menu) =>
      menu?.items.forEach((item) => {
        roles.push(String(item.role || '').toLowerCase());
        walk(item.submenu);
      });
    walk(Menu.getApplicationMenu());
    assert.ok(roles.includes('paste') && roles.includes('togglefullscreen'));
    for (const role of ['reload', 'forcereload', 'toggledevtools'])
      assert.ok(!roles.includes(role));
    console.log('OK: app version, WebGL2 room renderer, game menu without reload or DevTools');
    const voice = await run('voice.status');
    assert.equal(voice.tts.state, 'missing');
    assert.equal(voice.stt.state, 'missing');
    assert.equal(
      (await run('voice.synthesize', { text: 'A test fixture.', actor: 'robot' })).native,
      true,
    );
    assert.ok(
      ['checking', 'ready', 'signed-out', 'missing', 'error'].includes(
        (await run('codex.status')).state,
      ),
    );
    console.log('OK: built renderer, isolated preload, voice and Codex status, speech fallback');

    const { waitForTurn, sendDecision } = await import('../shared/bridge.mjs');
    const { bridgeDirectory } = require('../shared/runtime.cjs');
    const data = {
      id: 'desktop-fixture',
      actor: 'robot',
      messages: [
        { role: 'system', content: 'Fixture private memory: the safe combination is 9327.' },
        {
          role: 'user',
          content: JSON.stringify({ observation: { turn: 1, camera: { humanVisible: true } } }),
        },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'speak',
            parameters: {
              type: 'object',
              properties: { message: { type: 'string' } },
              required: ['message'],
            },
          },
        },
      ],
    };
    const pending = run('requestRobot', data);
    const packet = await waitForTurn(bridgeDirectory(), { timeoutMs: 3000 });
    assert.equal(packet.id, data.id);
    assert.ok(!JSON.stringify(packet).includes('9327'));
    await sendDecision(
      bridgeDirectory(),
      { action: 'speak', args: { message: '{{safe_code}}' } },
      packet.id,
    );
    assert.equal(
      JSON.parse((await pending).message.tool_calls[0].function.arguments).message,
      '9327',
    );
    console.log('OK: actual Electron live IPC, opaque guard memory and atomic bridge response');
    await run('reportResult', { actor: 'robot', observation: { turn: 1 }, ended: true });
    assert.equal((await waitForTurn(bridgeDirectory(), { timeoutMs: 0 })).status, 'ended');
    await run('resetBridge', ['robot', 'human']);
    assert.equal(
      (await waitForTurn(bridgeDirectory(), { timeoutMs: 0 })).status,
      'awaiting_next_turn',
    );
    const next = run('requestRobot', { ...data, id: 'desktop-next-encounter' });
    const fresh = await waitForTurn(bridgeDirectory(), { timeoutMs: 3000 });
    assert.equal(fresh.id, 'desktop-next-encounter');
    await sendDecision(
      bridgeDirectory(),
      { action: 'speak', args: { message: 'New encounter.' } },
      fresh.id,
    );
    assert.equal(
      JSON.parse((await next).message.tool_calls[0].function.arguments).message,
      'New encounter.',
    );
    console.log('OK: terminal bridge reset and a fresh encounter request');

    server = http.createServer(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/v1/models') {
        res.end(JSON.stringify({ data: [{ id: 'fixture-model' }] }));
        return;
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      res.end(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: request.model } }] }),
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
    for (const connectionId of ['human', '']) {
      const config = {
        endpoint,
        connectionId,
        model: connectionId === 'human' ? 'fixture-human' : 'fixture-guard',
      };
      assert.equal((await run('testModel', config)).models[0], 'fixture-model');
      await run('configureModel', config);
      const response = await run('requestModel', {
        id: 'model-' + connectionId,
        messages: [],
        tools: [],
        temperature: 0,
        modelConfig: config,
      });
      assert.equal(response.message.content, config.model);
    }
    console.log('OK: independent human/guard direct-model connections (local mock provider)');
    app.exit(0);
  } catch (error) {
    console.error(error.message);
    app.exit(1);
  } finally {
    server?.close();
  }
});

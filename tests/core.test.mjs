import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess, demoMove, outcome, parseMove, requestMove, retryDelay, toUci, validateConfig, waitForRetry } from '../core.js';

const config = {
  mode: 'api',
  white: { key: 'fake-white-key', endpoint: 'https://white.example.test/chat/completions', model: 'test/white' },
  black: { key: 'fake-black-key', endpoint: 'https://black.example.test/chat/completions', model: 'test/black' },
};
const response = content => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });

test('accepts legal UCI, SAN, and fenced JSON; rejects ambiguous prose and illegal moves', () => {
  const legal = new Chess().moves({ verbose: true });
  for (const content of ['e2e4', 'e4', '```json\n{"move":"e2e4","note":"Center."}\n```']) assert.equal(parseMove(content, legal).move, 'e2e4');
  for (const content of ['e2e5', 'I choose e2e4 or d2d4', '{}', 'null', null]) assert.throws(() => parseMove(content, legal));
});

test('legal-move response handling preserves castling, en passant, and promotion', () => {
  const fixtures = [
    ['r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', 'e1g1', 'O-O'],
    ['4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1', 'e5d6', 'exd6'],
    ['4k3/P7/8/8/8/8/8/4K3 w - - 0 1', 'a7a8n', 'a8=N'],
  ];
  for (const [fen, uci, san] of fixtures) {
    const game = new Chess(fen);
    const result = parseMove(JSON.stringify({ move: uci }), game.moves({ verbose: true }));
    assert.equal(game.move(result.move).san, san);
  }
});

test('detects mate, stalemate, repetition, fifty moves, and insufficient material', () => {
  const mate = new Chess();
  ['f3', 'e5', 'g4', 'Qh4#'].forEach(move => mate.move(move));
  assert.equal(outcome(mate), 'Black wins by checkmate');
  assert.equal(outcome(new Chess('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1')), 'Draw by stalemate');
  assert.equal(outcome(new Chess('4k3/8/8/8/8/8/8/4K3 w - - 0 1')), 'Draw by insufficient material');
  assert.equal(outcome(new Chess('r3k3/8/8/8/8/8/8/R3K3 w - - 100 51')), 'Draw by the fifty-move rule');
  const repeat = new Chess();
  ['Nf3','Nf6','Ng1','Ng8','Nf3','Nf6','Ng1','Ng8'].forEach(move => repeat.move(move));
  assert.equal(outcome(repeat), 'Draw by threefold repetition');
});

test('local demo makes legal moves without mutating live state during selection', () => {
  const game = new Chess();
  for (let i = 0; i < 8; i++) {
    const fen = game.fen();
    const history = game.history();
    const result = demoMove(game, () => .5);
    assert.equal(game.fen(), fen);
    assert.deepEqual(game.history(), history);
    assert.ok(game.moves({ verbose: true }).map(toUci).includes(result.move));
    game.move(result.move);
  }
});

test('API sends the right side, position and legal moves; retries one illegal reply', async () => {
  const game = new Chess();
  game.move('e4');
  const calls = [];
  const result = await requestMove(game, config, new AbortController().signal, () => {}, async (url, options) => {
    calls.push({ url, ...options, body: JSON.parse(options.body) });
    return response(JSON.stringify({ move: calls.length === 1 ? 'e7e4' : 'e7e5' }));
  });
  assert.equal(result.move, 'e7e5');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.model, 'test/black');
  assert.ok(calls[0].body.messages[1].content.includes(game.fen()));
  for (const call of calls) {
    assert.equal(call.url, config.black.endpoint);
    assert.equal(call.headers.Authorization, 'Bearer fake-black-key');
    assert.ok(!JSON.stringify(call).includes(config.white.key));
    assert.ok(!JSON.stringify(call).includes(config.white.model));
  }
  assert.equal(calls[0].redirect, 'error');
  assert.equal(calls[1].body.messages.length, 4);
  assert.deepEqual(game.history(), ['e4']);
});

test('stops after two invalid replies and does not retry authentication errors', async () => {
  let calls = 0;
  await assert.rejects(requestMove(new Chess(), config, new AbortController().signal, () => {}, async () => { calls++; return response('bad move'); }), /legal move/);
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(requestMove(new Chess(), config, new AbortController().signal, () => {}, async () => { calls++; return { ok: false, status: 401 }; }), /key was rejected/);
  assert.equal(calls, 1);
});

test('cancelled requests cannot return a move even if a provider responds late', async () => {
  const controller = new AbortController();
  await assert.rejects(requestMove(new Chess(), config, controller.signal, () => {}, async () => {
    controller.abort();
    return response('{"move":"e2e4"}');
  }), { name: 'AbortError' });
});

test('rejects missing credentials and unsafe endpoints', () => {
  for (const side of ['white', 'black']) {
    assert.throws(() => validateConfig({ ...config, [side]: { ...config[side], key: '' } }), /API key/);
    assert.throws(() => validateConfig({ ...config, [side]: { ...config[side], model: '' } }), /model ID/);
    for (const endpoint of ['http://example.test/chat', 'https://user:pass@example.test/chat', 'https://example.test/chat?key=secret']) assert.throws(() => validateConfig({ ...config, [side]: { ...config[side], endpoint } }), /HTTPS endpoint/);
  }
});

test('alternating turns use separate providers, keys, and models without credential crossover', async () => {
  const game = new Chess();
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({ url, ...options, body: JSON.parse(options.body) });
    return response(JSON.stringify({ move: game.turn() === 'w' ? 'e2e4' : 'e7e5' }));
  };
  for (const side of ['white', 'black']) {
    const result = await requestMove(game, config, new AbortController().signal, () => {}, fakeFetch);
    game.move(result.move);
    const call = calls.at(-1);
    const other = side === 'white' ? 'black' : 'white';
    assert.equal(call.url, config[side].endpoint);
    assert.equal(call.headers.Authorization, `Bearer ${config[side].key}`);
    assert.equal(call.body.model, config[side].model);
    assert.ok(!JSON.stringify(call).includes(config[other].key));
    assert.ok(!JSON.stringify(call).includes(config[other].endpoint));
    assert.ok(!JSON.stringify(call).includes(config[other].model));
  }
  assert.deepEqual(game.history(), ['e4', 'e5']);
});

test('provider errors identify the player whose connection failed', async () => {
  const game = new Chess();
  const rejectKey = async () => ({ ok: false, status: 401 });
  await assert.rejects(requestMove(game, config, new AbortController().signal, () => {}, rejectKey), /White: Your API key was rejected/);
  game.move('e4');
  await assert.rejects(requestMove(game, config, new AbortController().signal, () => {}, rejectKey), /Black: Your API key was rejected/);
});

test('temporary server errors recover with increasing delays on the same connection and position', async () => {
  const game = new Chess();
  const calls = [], waits = [], events = [];
  const result = await requestMove(game, config, new AbortController().signal, () => {}, async (url, options) => {
    calls.push({ url, ...options });
    return calls.length < 4 ? { ok: false, status: [502, 503, 504][calls.length - 1] } : response('{"move":"e2e4"}');
  }, { random: () => 0, sleep: async ms => { waits.push(ms); }, onRetry: event => events.push(event) });
  assert.equal(result.move, 'e2e4');
  assert.deepEqual(waits, [5000, 10000, 20000]);
  assert.deepEqual(events.map(event => event.retry), [1, 2, 3]);
  for (const call of calls) {
    assert.equal(call.url, config.white.endpoint);
    assert.equal(call.headers.Authorization, `Bearer ${config.white.key}`);
    assert.equal(call.body, calls[0].body);
  }
  assert.deepEqual(game.history(), []);
});

test('persistent 503 errors stop after three retries without moving a piece', async () => {
  const game = new Chess();
  let calls = 0;
  await assert.rejects(requestMove(game, config, new AbortController().signal, () => {}, async () => {
    calls++; return { ok: false, status: 503 };
  }, { sleep: async () => {} }), /White: Provider still unavailable \(503\) after 3 retries/);
  assert.equal(calls, 4);
  assert.deepEqual(game.history(), []);
});

test('server retry budget remains bounded across an invalid-model-response retry', async () => {
  let calls = 0;
  await assert.rejects(requestMove(new Chess(), config, new AbortController().signal, () => {}, async () => {
    calls++;
    return calls === 2 ? response('illegal') : { ok: false, status: 503 };
  }, { sleep: async () => {} }), /after 3 retries/);
  assert.equal(calls, 5);
});

test('pausing during backoff cancels the wait and prevents another API attempt', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(requestMove(new Chess(), config, controller.signal, () => {}, async () => {
    calls++; return { ok: false, status: 503 };
  }, { sleep: (ms, signal) => {
    const waiting = waitForRetry(ms, signal);
    controller.abort();
    return waiting;
  } }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('Retry-After seconds and dates override backoff, but shorter or invalid values do not', () => {
  const now = Date.parse('2026-09-25T12:00:00Z');
  const make = value => ({ headers: new Headers({ 'Retry-After': value }) });
  assert.equal(retryDelay(make('30'), 0, () => 0, now), 30000);
  assert.equal(retryDelay(make('Fri, 25 Sep 2026 12:00:45 GMT'), 0, () => 0, now), 45000);
  assert.equal(retryDelay(make('1'), 1, () => 0, now), 10000);
  assert.equal(retryDelay(make('bad'), 0, () => 0, now), 5000);
});

test('long provider waits and quota errors pause without automatic retry', async () => {
  for (const status of [503, 429]) {
    let calls = 0;
    await assert.rejects(requestMove(new Chess(), config, new AbortController().signal, () => {}, async () => {
      calls++;
      return { ok: false, status, headers: new Headers({ 'Retry-After': '120' }) };
    }, { sleep: async () => assert.fail('Should pause instead of sleeping') }), status === 503 ? /120 seconds/ : /rate limit/);
    assert.equal(calls, 1);
  }
});

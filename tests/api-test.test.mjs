import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { prepareTest, runCurlTest, handleApiTest } from '../scripts/api-test.mjs';

const input = { endpoint: 'https://example.test/v1/chat/completions', model: 'test-model', key: 'test-secret-123', prompt: 'Reply with "OK"\non one line' };

function curlStub(output, code = 0) {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const call = { command, args, options, input: '' };
    calls.push(call);
    child.stdin.on('data', chunk => { call.input += chunk; });
    child.stdin.on('finish', () => queueMicrotask(() => { child.stdout.write(output); child.emit('close', code); }));
    child.kill = () => { child.emit('close', null); return true; };
    return child;
  };
  return { spawn, calls };
}

test('curl config safely quotes JSON and rejects invalid URLs and header injection', () => {
  const prepared = prepareTest(input);
  assert.ok(prepared.config.includes('Authorization: Bearer test-secret-123'));
  assert.ok(prepared.config.includes('\\"model\\"'));
  assert.ok(prepared.config.includes('\\\\n'));
  for (const endpoint of ['http://example.test', 'https://user:pass@example.test', 'https://example.test?key=secret']) assert.throws(() => prepareTest({ ...input, endpoint }), /HTTPS/);
  assert.throws(() => prepareTest({ ...input, key: 'key\r\nInjected: header' }), /invalid character/);
});

test('real curl invocation shape keeps keys out of process args and redacts echoed credentials', async () => {
  const stub = curlStub('HTTP/2 200\r\ncontent-type: application/json\r\n\r\n{"content":"OK test-secret-123"}\n__CHESS_CURL_STATUS__200');
  const result = await runCurlTest(input, new AbortController().signal, stub.spawn);
  assert.equal(result.status, 200);
  assert.equal(result.exitCode, 0);
  assert.ok(result.output.includes('[REDACTED]'));
  assert.ok(!JSON.stringify(result).includes(input.key));
  assert.ok(!stub.calls[0].args.join(' ').includes(input.key));
  assert.equal(stub.calls[0].args[0], '--disable');
  assert.ok(!stub.calls[0].args.includes('--location'));
  assert.ok(stub.calls[0].input.includes(input.key));
});

test('provider 400 details are returned without replacing the explanation', async () => {
  const stub = curlStub('HTTP/2 400\r\n\r\n{"error":{"message":"Unknown model test-model"}}\n__CHESS_CURL_STATUS__400');
  const result = await runCurlTest(input, new AbortController().signal, stub.spawn);
  assert.equal(result.status, 400);
  assert.match(result.output, /Unknown model test-model/);
});

test('cancelled tests do not launch curl', async () => {
  const controller = new AbortController(); controller.abort();
  const stub = curlStub('');
  await assert.rejects(runCurlTest(input, controller.signal, stub.spawn), { name: 'AbortError' });
  assert.equal(stub.calls.length, 0);
});

test('local helper rejects cross-origin, unexpected host, and non-JSON calls', async () => {
  for (const [headers, expected] of [
    [{ host: '127.0.0.1:4173', origin: 'https://another.test', 'content-type': 'application/json' }, 403],
    [{ host: 'another.test:4173', 'content-type': 'application/json' }, 403],
    [{ host: '127.0.0.1:4173', 'content-type': 'text/plain' }, 415],
  ]) {
    let status;
    const response = { destroyed: false, writeHead(value) { status = value; return this; }, end() {} };
    await handleApiTest({ headers, method: 'POST' }, response);
    assert.equal(status, expected);
  }
});

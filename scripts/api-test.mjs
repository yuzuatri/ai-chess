import { spawn } from 'node:child_process';

const quote = value => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n').replaceAll('\r', '\\r').replaceAll('\t', '\\t')}"`;
const marker = '\n__CHESS_CURL_STATUS__';

export function prepareTest(input) {
  if (!input || typeof input !== 'object') throw new Error('Enter the API URL, key, and model.');
  for (const field of ['endpoint', 'key', 'model', 'prompt']) {
    if (typeof input[field] !== 'string' || !input[field].trim()) throw new Error(`Enter ${field === 'endpoint' ? 'an API URL' : `a ${field}`}.`);
    if (input[field].length > 16000) throw new Error(`${field} is too long.`);
  }
  let endpoint;
  try { endpoint = new URL(input.endpoint.trim()); } catch { throw new Error('Enter a valid API URL.'); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Use an HTTPS API URL without credentials or query parameters.');
  const key = input.key.trim();
  if (/[\r\n\0]/.test(key)) throw new Error('The API key contains an invalid character.');
  const body = JSON.stringify({ model: input.model.trim(), messages: [{ role: 'user', content: input.prompt }] });
  const config = [
    `url = ${quote(endpoint.href)}`,
    'request = "POST"',
    `header = ${quote(`Authorization: Bearer ${key}`)}`,
    'header = "Content-Type: application/json"',
    `data-binary = ${quote(body)}`,
  ].join('\n');
  return { key, config };
}

export async function runCurlTest(input, signal, spawnImpl = spawn) {
  const { key, config } = prepareTest(input);
  signal.throwIfAborted();
  const started = Date.now();
  return new Promise((resolve, reject) => {
    // Send credentials through stdin: never command arguments, files, or a shell.
    const child = spawnImpl(process.platform === 'win32' ? 'curl.exe' : 'curl', [
      '--disable', '--config', '-', '--silent', '--show-error', '--include', '--globoff',
      '--proto', '=https', '--connect-timeout', '15', '--max-time', '60',
      '--write-out', `${marker}%{http_code}`,
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', size = 0, oversized = false;
    const abort = () => child.kill();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const redact = text => text.replaceAll(key, '[REDACTED]').replaceAll(encodeURIComponent(key), '[REDACTED]');
    const collect = channel => chunk => {
      size += Buffer.byteLength(chunk);
      if (size > 1024 * 1024) { oversized = true; child.kill(); return; }
      if (channel === 'out') stdout += chunk; else stderr += chunk;
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', collect('out'));
    child.stderr.on('data', collect('err'));
    child.stdin.on('error', () => {}); // An early curl failure can close stdin first.
    child.on('error', () => {
      signal.removeEventListener('abort', abort);
      reject(new Error('Could not start curl. Install curl or use a Windows version that includes curl.exe.'));
    });
    child.on('close', exitCode => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return; }
      if (oversized) { reject(new Error('Response exceeded the 1 MB test limit.')); return; }
      const at = stdout.lastIndexOf(marker);
      const status = at < 0 ? 0 : Number(stdout.slice(at + marker.length).trim()) || 0;
      resolve({ status, exitCode, elapsedMs: Date.now() - started, output: redact(at < 0 ? stdout : stdout.slice(0, at)), error: redact(stderr.trim()) });
    });
    child.stdin.end(config + '\n');
  });
}

export async function handleApiTest(request, response) {
  const reply = (status, payload) => {
    if (!response.destroyed) response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(payload));
  };
  const host = request.headers.host;
  if (!['127.0.0.1:4173', 'localhost:4173'].includes(host) ||
      (request.headers.origin && request.headers.origin !== `http://${host}`) ||
      request.headers['sec-fetch-site'] === 'cross-site') { reply(403, { error: 'Open the test page from this local server.' }); return; }
  if (request.method !== 'POST') { reply(405, { error: 'Use the Send test button.' }); return; }
  if (!request.headers['content-type']?.startsWith('application/json')) { reply(415, { error: 'Expected JSON.' }); return; }
  const controller = new AbortController();
  response.on('close', () => controller.abort());
  try {
    let body = '';
    for await (const chunk of request) {
      body += chunk.toString('utf8');
      if (Buffer.byteLength(body) > 65536) { reply(413, { error: 'Test request is too large.' }); return; }
    }
    let input;
    try { input = JSON.parse(body); } catch { reply(400, { error: 'Invalid request JSON.' }); return; }
    prepareTest(input);
    reply(200, await runCurlTest(input, controller.signal));
  } catch (error) {
    if (error.name !== 'AbortError') reply(400, { error: error.message });
  }
}

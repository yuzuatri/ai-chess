const $ = id => document.getElementById(id);
const endpoints = {
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  groq: 'https://api.groq.com/openai/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  custom: '',
};
let active = null;
let copyText = '';

$('provider').addEventListener('change', () => {
  $('test-url').value = endpoints[$('provider').value];
  $('test-key').value = '';
  $('test-model').value = '';
});
// A key entered for one endpoint should not silently follow a changed endpoint.
$('test-url').addEventListener('input', () => { $('test-key').value = ''; });
function status(text, kind = '') { $('test-status').textContent = text; $('test-status').dataset.kind = kind; }
function busy(value) {
  for (const id of ['provider', 'test-url', 'test-model', 'test-key', 'test-prompt', 'send-test']) $(id).disabled = value;
  $('cancel-test').disabled = !value;
}
$('test-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (active) return;
  const input = { endpoint: $('test-url').value.trim(), model: $('test-model').value.trim(), key: $('test-key').value.trim(), prompt: $('test-prompt').value };
  active = new AbortController();
  const controller = active;
  busy(true);
  $('copy-result').disabled = true;
  copyText = '';
  status('Sending… up to 60 seconds');
  $('test-output').textContent = 'Waiting for the provider…';
  const timeout = setTimeout(() => controller.abort('timeout'), 65000);
  try {
    const response = await fetch('./api/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: controller.signal });
    if (!response.headers.get('Content-Type')?.includes('application/json')) throw new Error('Start the local server with npm start, then open http://127.0.0.1:4173/api-test.html. This tool needs the local curl helper.');
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Local helper error (${response.status}).`);
    const ok = result.status >= 200 && result.status < 300 && result.exitCode === 0;
    status(`${result.status ? `HTTP ${result.status}` : 'No HTTP response'} · ${(result.elapsedMs / 1000).toFixed(1)}s · curl exit ${result.exitCode}`, ok ? 'ok' : 'error');
    copyText = [result.output, result.error ? `curl: ${result.error}` : ''].filter(Boolean).join('\n\n') || 'No response body.';
    $('test-output').textContent = copyText;
    $('copy-result').disabled = false;
  } catch (error) {
    status(controller.signal.aborted ? controller.signal.reason === 'timeout' ? 'Test timed out' : 'Test cancelled' : 'Could not run test', 'error');
    $('test-output').textContent = controller.signal.aborted ? 'No more requests will be sent. You can try again when ready.' : error.message;
  } finally {
    clearTimeout(timeout);
    active = null;
    busy(false);
  }
});
$('cancel-test').addEventListener('click', () => active?.abort());
$('copy-result').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(copyText); $('copy-result').textContent = 'Copied'; }
  catch { $('copy-result').textContent = 'Select the response to copy'; }
});
window.addEventListener('pagehide', () => active?.abort());
if (!['127.0.0.1', 'localhost'].includes(location.hostname) || location.port !== '4173') {
  busy(true);
  $('cancel-test').disabled = true;
  status('Local server required', 'error');
  $('test-output').textContent = 'Run npm start in the project folder and open http://127.0.0.1:4173/api-test.html. This local curl tool cannot run on GitHub Pages.';
}

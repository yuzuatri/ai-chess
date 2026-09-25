import { Chess, demoMove, outcome, requestMove, validateConfig } from './core.js';

const $ = id => document.getElementById(id);
const symbols = { p: '♟︎', n: '♞︎', b: '♝︎', r: '♜︎', q: '♛︎', k: '♚︎' };
const pieceNames = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
let game = new Chess();
let mode = 'demo';
let config = null;
let running = false;
let flipped = false;
let finished = false;
let generation = 0;
let controller = null;
let requests = 0;
let lastNote = '';
let status = 'Ready when you are';

function readConfig() {
  const player = side => ({
    key: $(`${side}-key`).value.trim(),
    endpoint: $(`${side}-endpoint`).value.trim(),
    model: $(`${side}-model`).value.trim(),
  });
  return validateConfig({ mode, white: player('white'), black: player('black'), limit: Number($('move-limit').value) * 2 });
}

function playerName(color) {
  if (mode === 'demo') return color === 'w' ? 'Ivory' : 'Obsidian';
  return (config ? config[color === 'w' ? 'white' : 'black'].model : $(color === 'w' ? 'white-model' : 'black-model').value.trim()) || 'Choose a model';
}

function renderBoard() {
  const fragment = document.createDocumentFragment();
  const ranks = flipped ? [1,2,3,4,5,6,7,8] : [8,7,6,5,4,3,2,1];
  const files = flipped ? 'hgfedcba' : 'abcdefgh';
  const history = game.history({ verbose: true });
  const last = history.at(-1);
  const accessible = [];
  for (const [r, rank] of ranks.entries()) for (const [f, file] of [...files].entries()) {
    const squareName = file + rank;
    const square = document.createElement('div');
    const piece = game.get(squareName);
    const isDark = (file.charCodeAt(0) - 97 + rank) % 2 !== 0;
    square.className = `square${isDark ? ' dark' : ''}${last && [last.from, last.to].includes(squareName) ? ' last' : ''}${piece?.type === 'k' && piece.color === game.turn() && game.isCheck() ? ' check' : ''}`;
    square.dataset.square = squareName;
    if (piece) {
      const span = document.createElement('span');
      span.className = `piece ${piece.color === 'w' ? 'white' : 'black'}`;
      span.textContent = symbols[piece.type];
      square.append(span);
      accessible.push(`${piece.color === 'w' ? 'White' : 'Black'} ${pieceNames[piece.type]} at ${squareName}`);
    }
    if (f === 0) { const label = document.createElement('span'); label.className = 'coordinate rank'; label.textContent = rank; square.append(label); }
    if (r === 7) { const label = document.createElement('span'); label.className = 'coordinate file'; label.textContent = file; square.append(label); }
    square.setAttribute('aria-hidden', 'true');
    fragment.append(square);
  }
  $('board').replaceChildren(fragment);
  $('board').setAttribute('aria-label', `Chess board. ${game.turn() === 'w' ? 'White' : 'Black'} to move. ${accessible.join(', ')}.`);
  $('position-label').textContent = history.length ? `Move ${Math.floor(history.length / 2) + 1} · ${game.turn() === 'w' ? 'White' : 'Black'} to move${game.isCheck() ? ' · Check' : ''}` : 'Starting position';
  if (finished) $('position-label').textContent = status;
  for (const color of ['w', 'b']) {
    const captured = history.filter(move => move.color === color && move.captured).map(move => move.captured);
    $(`captured-${color}`).textContent = captured.map(piece => symbols[piece]).join('');
    $(`captured-${color}`).setAttribute('aria-label', `${color === 'w' ? 'White' : 'Black'} captured: ${captured.map(piece => pieceNames[piece]).join(', ') || 'none'}`);
  }
}

function renderJournal() {
  const history = game.history();
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < history.length; i += 2) {
    const row = document.createElement('tr');
    [String(i / 2 + 1).padStart(2, '0'), history[i], history[i + 1] || '—'].forEach((value, column) => {
      const cell = document.createElement('td');
      cell.textContent = value;
      if (column > 0 && i + column - 1 === history.length - 1) cell.className = 'current';
      row.append(cell);
    });
    fragment.append(row);
  }
  $('moves').replaceChildren(fragment);
  $('empty-moves').hidden = history.length > 0;
  $('move-count').textContent = `${Math.ceil(history.length / 2)} ${history.length <= 2 && history.length > 0 ? 'move' : 'moves'}`;
  $('latest-label').textContent = history.length ? `${history.length % 2 ? 'WHITE' : 'BLACK'} PLAYED ${history.at(-1)}` : 'OPENING SCENE';
  $('latest-note').textContent = lastNote || 'The board is set. The next move is theirs.';
  $('download').disabled = !history.length;
  $('move-scroll').scrollTop = $('move-scroll').scrollHeight;
}

function renderControls() {
  $('status').textContent = status;
  $('status-dot').classList.toggle('live', running);
  $('play').textContent = running ? 'Ⅱ Pause match' : finished ? 'Match finished' : config ? '▶ Resume match' : '▶ Start watching';
  $('play').disabled = finished;
  $('setup-fields').disabled = !!config;
  $('mode-badge').textContent = mode === 'demo' ? 'LOCAL DEMO' : 'AI MODELS';
  $('request-count').textContent = requests ? `${requests} API ${requests === 1 ? 'call' : 'calls'}` : 'No API calls';
  for (const color of ['w', 'b']) {
    $(`name-${color}`).textContent = playerName(color);
    const thinking = running && game.turn() === color;
    $(`player-${color}`).classList.toggle('thinking', thinking);
    $(`state-${color}`).textContent = finished ? 'Finished' : thinking ? 'Thinking…' : game.turn() === color ? config ? 'Paused' : 'Ready' : 'Waiting';
  }
}

function setMode(next) {
  if (config) return;
  mode = next;
  $('demo-mode').setAttribute('aria-pressed', String(mode === 'demo'));
  $('api-mode').setAttribute('aria-pressed', String(mode === 'api'));
  $('demo-hint').hidden = mode !== 'demo';
  $('api-settings').hidden = mode !== 'api';
  $('api-timing').hidden = mode !== 'api';
  $('error').hidden = true;
  renderControls();
}

function showError(error) {
  $('error').textContent = error.message;
  $('error').hidden = false;
}

function pause() {
  if (!running) return;
  running = false;
  generation++;
  controller?.abort();
  status = 'Paused · resume when you’re ready';
  renderControls();
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException('Paused', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

function complete(message, result = '*') {
  running = false;
  finished = true;
  status = message;
  game.header('Result', result);
  renderBoard();
  renderControls();
}

async function start() {
  if (running || finished) return;
  try {
    if (!config) {
      config = readConfig();
      game.header('Event', mode === 'demo' ? 'Chess Observatory local demo' : 'Chess Observatory AI match', 'White', playerName('w'), 'Black', playerName('b'), 'Date', new Date().toISOString().slice(0,10).replaceAll('-', '.'), 'Result', '*');
    }
  } catch (error) { showError(error); return; }
  $('error').hidden = true;
  running = true;
  const token = ++generation;
  controller = new AbortController();
  const signal = controller.signal;
  renderControls();
  try {
    while (running && token === generation) {
      const end = outcome(game);
      if (end) { complete(end, game.isCheckmate() ? game.turn() === 'w' ? '0-1' : '1-0' : '1/2-1/2'); break; }
      if (game.history().length >= config.limit) { complete('Move limit reached · game stopped'); break; }
      status = `${game.turn() === 'w' ? 'White' : 'Black'} is thinking…`;
      renderControls();
      // Yield so the thinking and pause controls can paint before local computation.
      await wait(mode === 'demo' ? 40 : 0, signal);
      const result = mode === 'demo' ? demoMove(game) : await requestMove(game, config, signal, attempt => {
        requests++;
        status = attempt ? 'Invalid response · retrying once…' : `${game.turn() === 'w' ? 'White' : 'Black'} is thinking…`;
        renderControls();
      }, fetch, {
        onRetry: retry => {
          status = `${retry.side}’s provider is busy (${retry.status}) · retry ${retry.retry}/3 in ${Math.ceil(retry.delayMs / 1000)}s`;
          renderControls();
        },
      });
      if (!running || token !== generation) return;
      game.move(result.move);
      lastNote = result.note || 'The model has made its move.';
      renderBoard();
      renderJournal();
      const ending = outcome(game);
      if (ending) { complete(ending, game.isCheckmate() ? game.turn() === 'w' ? '0-1' : '1-0' : '1/2-1/2'); break; }
      if (game.history().length >= config.limit) { complete('Move limit reached · game stopped'); break; }
      status = `Last move: ${game.history().at(-1)}${game.isCheck() ? ' · Check' : ''}`;
      renderControls();
      await wait(Number($('pace').value), signal);
    }
  } catch (error) {
    if (token !== generation || signal.aborted) return;
    running = false;
    status = 'Match paused';
    showError(error);
    renderControls();
  }
}

function reset() {
  pause();
  generation++;
  game = new Chess();
  config = null;
  finished = false;
  requests = 0;
  lastNote = '';
  status = 'Ready when you are';
  $('error').hidden = true;
  renderBoard();
  renderJournal();
  renderControls();
}

$('play').addEventListener('click', () => running ? pause() : void start());
$('reset').addEventListener('click', reset);
$('demo-mode').addEventListener('click', () => setMode('demo'));
$('api-mode').addEventListener('click', () => setMode('api'));
$('white-model').addEventListener('input', renderControls);
$('black-model').addEventListener('input', renderControls);
$('flip').addEventListener('click', () => { flipped = !flipped; renderBoard(); });
$('download').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([game.pgn()], { type: 'application/x-chess-pgn' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'chess-observatory.pgn';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
window.addEventListener('pagehide', pause);

renderBoard();
renderJournal();
renderControls();

// Optional, progressive enhancement; never expose API keys to page tools.
if (document.modelContext?.registerTool) {
  const context = document.modelContext;
  const tools = [
    { name: 'read_chess_match', description: 'Read the current chess position and match status. No secrets are returned.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true }, execute: () => ({ fen: game.fen(), moves: game.history(), status, running, mode }) },
    { name: 'pause_chess_match', description: 'Pause the current match and cancel its pending request.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: false }, execute: () => { pause(); return { running, status }; } },
  ];
  for (const tool of tools) {
    const execute = tool.execute;
    tool.execute = input => {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw new Error('This tool accepts an empty object only.');
      return execute();
    };
    try { Promise.resolve(context.registerTool(tool)).catch(() => {}); } catch { /* Experimental API is optional. */ }
  }
}

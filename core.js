import { Chess } from './vendor/chess.js';

export { Chess };
export const toUci = move => move.from + move.to + (move.promotion || '');

export function outcome(game) {
  if (game.isCheckmate()) return `${game.turn() === 'w' ? 'Black' : 'White'} wins by checkmate`;
  if (game.isStalemate()) return 'Draw by stalemate';
  if (game.isThreefoldRepetition()) return 'Draw by threefold repetition';
  if (game.isInsufficientMaterial()) return 'Draw by insufficient material';
  if (game.isDrawByFiftyMoves()) return 'Draw by the fifty-move rule';
  return null;
}

export function parseMove(content, legalMoves) {
  if (typeof content !== 'string') throw new Error('The model returned no move. Try another model or resume to retry.');
  const raw = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let value;
  try { value = JSON.parse(raw); } catch { value = { move: raw }; }
  const candidate = typeof value === 'string' ? value : value?.move;
  const selected = legalMoves.find(move => candidate === toUci(move) || candidate === move.san);
  if (!selected) throw new Error('The model did not choose a legal move. Match paused; resume to retry or start with another model.');
  return { move: toUci(selected), note: typeof value?.note === 'string' ? value.note.slice(0, 240) : '' };
}

export function validateConfig(config) {
  if (config.mode === 'demo') return config;
  for (const side of ['white', 'black']) {
    const player = config[side];
    const label = side === 'white' ? 'White' : 'Black';
    if (!player?.key?.trim()) throw new Error(`${label}: enter your API key.`);
    if (!player.model?.trim()) throw new Error(`${label}: enter a model ID.`);
    let url;
    try { url = new URL(player.endpoint); } catch { throw new Error(`${label}: enter a valid chat completions URL.`); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error(`${label}: use an HTTPS endpoint without credentials, query parameters, or a fragment.`);
    }
  }
  return config;
}

export function waitForRetry(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Paused', 'AbortError')); return; }
    const abort = () => { clearTimeout(timer); reject(new DOMException('Paused', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export function retryDelay(response, retry, random = Math.random, now = Date.now()) {
  const header = response.headers?.get('Retry-After');
  let requested = 0;
  if (header?.trim()) {
    const seconds = Number(header);
    requested = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
  }
  const backoff = 5000 * 2 ** retry + Math.floor(random() * 1000);
  return Math.max(backoff, Number.isFinite(requested) ? requested : 0);
}

export async function requestMove(game, config, signal, onAttempt = () => {}, fetchImpl = fetch, { onRetry = () => {}, sleep = waitForRetry, random = Math.random } = {}) {
  validateConfig(config);
  const legal = game.moves({ verbose: true });
  const side = game.turn() === 'w' ? 'White' : 'Black';
  const player = game.turn() === 'w' ? config.white : config.black;
  const messages = [
    { role: 'system', content: 'You are playing chess. Choose the strongest move from the provided legal UCI moves. Return only JSON: {"move":"e2e4","note":"A short sentence about the move."}. The move must exactly match a legal UCI move. Do not return analysis or markdown.' },
    { role: 'user', content: `You are ${side}.\nFEN: ${game.fen()}\nMove history: ${game.history().join(' ') || '(none)'}\nLegal UCI moves: ${legal.map(toUci).join(', ')}` },
  ];
  let transientRetries = 0;
  for (let attempt = 0; attempt < 2;) {
    signal.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, 60000);
    try {
      onAttempt(attempt);
      const response = await fetchImpl(player.endpoint, {
        method: 'POST', signal: controller.signal, credentials: 'omit', redirect: 'error',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${player.key}` },
        body: JSON.stringify({ model: player.model, messages, stream: false, max_tokens: 1200 }),
      });
      if (!response.ok) {
        if ([502, 503, 504].includes(response.status)) {
          if (transientRetries >= 3) throw new Error(`Provider still unavailable (${response.status}) after 3 retries. Wait a few minutes before resuming, or start a new game with another model.`);
          const delayMs = retryDelay(response, transientRetries, random);
          if (delayMs > 60000) throw new Error(`Provider unavailable (${response.status}). It requests a wait of ${Math.ceil(delayMs / 1000)} seconds; resume after that wait.`);
          // Backoff is separate from the per-request timeout, and Pause cancels it.
          clearTimeout(timeout);
          transientRetries++;
          onRetry({ side, status: response.status, retry: transientRetries, delayMs });
          await sleep(delayMs, signal);
          continue;
        }
        const hints = { 400: 'The provider rejected the request. Check the model ID and endpoint.', 401: 'Your API key was rejected. Check the key and its provider.', 402: 'Your provider needs more credits or a higher spending limit.', 403: 'This API key cannot access the selected model.', 404: 'Model or endpoint not found. Check your settings.', 429: 'Provider rate limit reached. Wait a little, then resume.' };
        throw new Error(hints[response.status] || `Provider error (${response.status}). Try resuming shortly.`);
      }
      const data = await response.json();
      signal.throwIfAborted();
      if (data.error) throw new Error('The provider could not complete this request. Check your provider dashboard and try another model.');
      const content = data.choices?.[0]?.message?.content;
      try { return parseMove(content, legal); }
      catch (error) {
        if (attempt === 1) throw error;
        messages.push({ role: 'assistant', content: typeof content === 'string' ? content.slice(0, 2000) : '{}' });
        messages.push({ role: 'user', content: 'That response was not a valid legal move. Reply only with the requested JSON and choose exactly one of the legal UCI moves above.' });
        attempt++;
      }
    } catch (error) {
      if (signal.aborted) throw new DOMException('Paused', 'AbortError');
      if (controller.signal.aborted) throw new Error(`${side}: the model took more than 60 seconds. Resume to retry or choose a faster model.`);
      if (error instanceof TypeError) throw new Error(`${side}: could not reach the API. Check your connection and endpoint. The provider must allow browser requests (CORS).`);
      throw new Error(`${side}: ${error.message}`);
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
    }
  }
}

const values = { p: 100, n: 320, b: 335, r: 500, q: 900, k: 0 };
function evaluate(game, color) {
  if (game.isCheckmate()) return game.turn() === color ? -100000 : 100000;
  if (game.isDraw()) return 0;
  let score = 0;
  for (const row of game.board()) for (const piece of row) {
    if (!piece) continue;
    const file = piece.square.charCodeAt(0) - 97;
    const rank = Number(piece.square[1]) - 1;
    const center = 3.5 - (Math.abs(file - 3.5) + Math.abs(rank - 3.5)) / 2;
    const progress = piece.color === 'w' ? rank : 7 - rank;
    const position = piece.type === 'p' ? progress * 7 + center * 4 : ['n', 'b'].includes(piece.type) ? center * 14 : 0;
    score += (values[piece.type] + position) * (piece.color === color ? 1 : -1);
  }
  return score;
}

// A deliberately small two-ply opponent for the clearly labeled, offline demo.
export function demoMove(game, random = Math.random) {
  const board = new Chess(game.fen());
  const color = board.turn();
  let best = -Infinity;
  let choice;
  for (const move of board.moves({ verbose: true })) {
    board.move(move);
    let score = evaluate(board, color);
    if (!board.isGameOver()) {
      let worst = Infinity;
      for (const reply of board.moves({ verbose: true })) {
        board.move(reply);
        worst = Math.min(worst, evaluate(board, color));
        board.undo();
      }
      score = worst;
    }
    board.undo();
    score += random() * 15;
    if (score > best) { best = score; choice = move; }
  }
  if (!choice) throw new Error('There are no legal moves.');
  return { move: toUci(choice), note: choice.captured ? 'A capture changes the balance.' : choice.san.includes('+') ? 'The king comes under pressure.' : choice.flags.includes('k') || choice.flags.includes('q') ? 'The king moves to safety.' : 'A new position. A new possibility.' };
}

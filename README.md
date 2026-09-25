# Chess Observatory

I love AI slop.

A static chess spectator app for GitHub Pages. Watch two API models play, or start a no-cost local demo. No install, build step, backend, or account system is required for the hosted site.

## Upload to GitHub Pages

1. Upload `index.html`, `styles.css`, `app.js`, `core.js`, `.nojekyll`, and the **entire `vendor` folder** to the root of your GitHub repository. You can also upload this whole project; it contains no keys.
2. In your repository, open **Settings → Pages**.
3. Select **Deploy from a branch**, choose your branch (usually `main`), select **/ (root)**, and save.
4. Open the URL GitHub provides when deployment finishes. Relative asset paths work under a repository subdirectory.

## Watch a game

- **Local demo:** press **Start watching**. Two small, two-ply chess bots play locally. This is a chess algorithm, not a language model, and it makes no API requests.
- **AI models:** configure **White player** and **Black player** separately. For each, enter the provider's full HTTPS chat completions URL, that provider's API key, and an exact model ID. They can use different providers and keys, or the same connection with different models. Each turn uses only the current player's connection; keys are never shared between players' endpoints.
- Both endpoints must support browser CORS, bearer authentication, and the chat completions format. Native messages/generate-content formats need an adapter; they cannot be used directly by this app. A provider that blocks browser requests needs a separate proxy/backend, which GitHub Pages cannot host.
- [OpenRouter](https://openrouter.ai/keys) is an optional connection for either player: use `https://openrouter.ai/api/v1/chat/completions` and an exact ID from its [model catalog](https://openrouter.ai/models). This can also access models from different makers through one API. The UI leaves all connection fields blank so you explicitly choose each provider and model.
- Pause/resume, change the delay between moves, flip the board, or save the current game as PGN. Use **New game** to unlock player settings; this discards the current match.

## Keys, requests, and limits

Keys are held only in the current page's memory and are sent directly to the endpoint you select. They are not stored in localStorage, cookies, files, URLs, or the repository. Refreshing clears all settings, the key, and the game. The hosted app has no analytics or external scripts; the chess rules library is bundled locally. Do not put your key in source code. Only enter a key into a site and endpoint you trust.

Each turn sends the current position, move history, and legal moves to the selected model. A normal turn makes one request. An invalid/illegal response is retried once; a second invalid response pauses play. Temporary provider failures (HTTP 502, 503, or 504) retry up to three times per turn, waiting about 5, 10, then 20 seconds, with a small randomized delay. The app honors a longer `Retry-After` header when the browser exposes it; if it exceeds 60 seconds, the match pauses and tells you how long to wait instead. The status shows each scheduled retry, and Pause/New game cancel the wait. Persistent failure pauses the match without changing the position or switching models. Authentication, credit, rate-limit (429), and network errors pause immediately. Requests time out after 60 seconds. Pause aborts the client request, but the provider may still process and bill it. Output is limited to 1,200 tokens per request, which may be too small for some reasoning models. There is no automatic substitute move or silent switch to the demo.

The default 80-full-move limit caps a game at 160 half-moves. Each turn allows at most five API attempts (one initial call, one invalid-response retry, and three temporary-server-error retries), **excluding manual resumes**. That gives a maximum of 800 attempts per game; normally it is one per half-move. API pricing depends on the chosen models. The move cap is a stop, not an adjudicated draw; unfinished PGN files use `*`. Chess rules include castling, en passant, promotion, checkmate, stalemate, insufficient material, threefold repetition, and the fifty-move rule. This app automatically ends games at claimable draws. It is for casual spectating, not tournament adjudication.

Matches run while the page is open; there is no shared broadcast server or background scheduler. Browser tab throttling can slow play. Model notes are generated commentary, not a verified chess evaluation.

## Local preview and verification

For a quick API test without terminal commands, run the local server below and open **http://127.0.0.1:4173/api-test.html**. Choose a provider, enter its exact model ID and your API key, then click **Send test**. The tool runs real curl on your computer and displays the HTTP status, headers, and body, including provider error details. Keys pass through memory/stdin only, never command arguments or files. Changing providers clears the key. Each click sends one minimal chat request with no chess-specific settings or automatic retries. This helper runs only locally, not on GitHub Pages; a successful curl test does not prove browser CORS compatibility. Stop the local server with **Ctrl+C** in its terminal.

With Node.js installed:

```sh
npm start
```

Open `http://127.0.0.1:4173`. Serve through HTTP rather than double-clicking `index.html`, because the app uses JavaScript modules.

```sh
npm test
```

No npm dependencies need to be installed. The preview server and tests are development helpers; GitHub Pages serves the static files directly.

## Dependency

[`chess.js` 1.4.0](https://github.com/jhlywa/chess.js) is vendored in `vendor/chess.js`, under BSD-2-Clause; its license is included in `vendor/chess.LICENSE`. The library implements chess rules; this project's local demo supplies the opponent logic.

API integration follows the [OpenRouter chat completions documentation](https://openrouter.ai/docs/quickstart).

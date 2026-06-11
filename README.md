# Chatbot CLI

Terminal bridge for an already-open target app browser tab exposed through Chromium DevTools Protocol.

## Configuration

Copy `.env.example` into your shell or service environment and set:

- `CHATBOT_CDP_URL`: Chromium DevTools endpoint. Defaults to `http://127.0.0.1:9222`.
- `CHATBOT_TRANSCRIPT_DIR`: private transcript output directory. Defaults to `outputs/`, which is gitignored.
- `CHATBOT_PLAYWRIGHT_CORE_PATH`: optional absolute module path if `playwright-core` is installed outside this package.

Install dependencies:

```bash
npm install
```

Run:

```bash
node CB.js --message "hello"
```

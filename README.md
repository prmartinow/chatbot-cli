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

On the RPC screen-97 test lane used during development, the browser CDP endpoint is:

```bash
node CB.js --cdp http://127.0.0.1:9241 --status
```

## Commands

Inspect the current target app page:

```bash
node CB.js --status
node CB.js --models
node CB.js --stop
```

Send a prompt and stream the answer as target app produces it:

```bash
node CB.js --message "Summarize this in three bullets"
```

Use `--no-stream` to wait silently and print the final answer only.

Select visible UI options before sending:

```bash
node CB.js --model "GPT-4o" --reasoning "Auto" --message "hello"
```

Attach files before sending:

```bash
node CB.js --attach ./notes.txt --message "Use the attached notes"
```

If the target app page accepts the file chip but keeps the send button disabled, the CLI exits with a clear error instead of waiting for the full response timeout.

Save artifacts from the latest assistant turn:

```bash
node CB.js --download-artifacts
node CB.js --message "Give me a small JS example" --download-artifacts --show-artifacts
```

Artifacts are written under `outputs/artifacts/<session>/<timestamp>/` and can include metadata, links, visible images, code blocks, and files exposed through download controls. Use `--show-artifacts` to print saved text/code artifacts in the terminal. If an assistant labels a code block with a preceding `FILE: name.ext` line, the CLI uses that filename instead of `code-block-N.txt`.

## Interactive Mode

Run `node CB.js` and use:

- `/status`: print model, composer, generation, and artifact state.
- `/models`: list visible model picker options.
- `/reasoning`: list visible reasoning controls.
- `/model <text>` and `/reasoning <text>`: click matching UI options.
- `/attach <path>`: queue a file for the next prompt.
- `/artifacts`: save artifact metadata from the latest assistant turn.
- `/download`: save latest-turn artifacts to disk.
- `/stop`: click a visible stop/interrupt generation control.
- `/stream on|off`: toggle live answer streaming.

Multiline paste works directly at `CB>`. Long pasted text that target app converts into a composer attachment is surfaced through `/status`.

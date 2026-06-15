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
node CB.js --status --state-jsonl
node CB.js --models
node CB.js --stop
```

`--models` opens the live model picker and Configure dialog, then reports the
current header, selected composer button, visible mode rows, reasoning-effort
flyout options, and the Configure dialog's model list. These labels are scraped
from the current UI because model names and picker layout change over time,
including headers such as `Latest` or `Legacy`.

Watch target app state for orchestration:

```bash
node CB.js --watch-state --state-jsonl
node CB.js --watch-state --wait-ready --state-jsonl --timeout 120000
```

`--watch-state` polls the live page and emits state changes. `--wait-ready` exits when a new assistant turn has completed after the watcher baseline; the final JSONL event has `"phase":"ready"` and `"ready":true`, which can be used as a trigger for another agent to consume the transcript or latest assistant output.

Send a prompt and stream the answer as target app produces it:

```bash
node CB.js --message "Summarize this in three bullets"
```

Use `--no-stream` to wait silently and print the final answer only.
Use `--state-jsonl` with a prompt to emit structured state events while still returning the answer.

Select visible UI options before sending:

```bash
node CB.js --model "5.5 Pro Extended" --message "hello"
node CB.js --model "Thinking Heavy" --message "hello"
printf "/model 5.5 Pro Extended\n/status\n/exit\n" | node CB.js
```

For current target app picker shapes, model labels can include a model version,
mode, and effort, for example `5.5 Pro Extended` or `5.5 Thinking Heavy`.
`/status --state-jsonl` includes a lightweight `modelSelection` object and,
when status performs the deeper picker inspection, a compact `modelConfig`
object with the live model list and effort options.

Attach files before sending:

```bash
node CB.js --attach ./notes.txt --message "Use the attached notes"
node CB.js --attach ./clip.mp3 --message "Describe the audio"
node CB.js --attach ./clip.mp4 --message "Describe the video"
```

If the target app page accepts the file chip but keeps the send button disabled, the CLI exits with a clear error instead of waiting for the full response timeout.

Save artifacts from the latest assistant turn:

```bash
node CB.js --download-artifacts
node CB.js --message "Give me a small JS example" --download-artifacts --show-artifacts
node CB.js --message "Generate a square image with the text CB IMAGE TEST" --download-artifacts
```

Artifacts are written under `outputs/artifacts/<session>/<timestamp>/` and can include metadata, links, visible images, code blocks, and files exposed through download controls. Generated target app images are saved from the latest assistant turn as local image files. Use `--show-artifacts` to print saved text/code artifacts in the terminal. If an assistant labels a code block with a preceding `FILE: name.ext` line, the CLI uses that filename instead of `code-block-N.txt`.

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

`CB` is text/file-only. It recognizes target app voice/dictation controls in `/status`, but deliberately does not click `Start dictation`, `Start Voice`, or related microphone controls because the CLI cannot provide voice input.

Multiline paste works directly at `CB>`. Long pasted text that target app converts into a composer attachment is surfaced through `/status`.

Long Markdown prompts are matched back to target app turns with normalized text anchors, so code fences, inline backticks, ProseMirror spacing, and collapsed "show more" rendering do not block response capture.

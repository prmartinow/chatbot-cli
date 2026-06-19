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
node CB.js --latest-assistant
node CB.js --sync-transcript
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
Progress-only assistant text such as `Finalizing answer`, `Thinking`, or `Thought for ...` is treated as in-flight state, not as a completed answer or transcript export.
When target app renders multiple assistant message nodes inside one turn, CB stitches the substantive nodes and ignores progress-only placeholders, so short prefaces do not hide the final answer.
Every CB invocation reconciles the active target app DOM into the session transcript and updates the conversation index before doing new work. If a prior `--message` process timed out or was killed after the user prompt was accepted, run `--sync-transcript` once the browser shows the completed answer. This appends any missing completed DOM turns to the session transcript, marks matching pending rounds recovered, and updates the index. Use `--latest-assistant` when another agent needs the full latest response text instead of the short `/status` preview.

Schedule sequential work:

```bash
node CB.js --schedule --new-conversation --alias research-a --message "Start the analysis"
node CB.js --schedule --conversation research-a --message "Follow up after the first answer"
node CB.js --run-queue --cdp http://127.0.0.1:9241
node CB.js --recover-queue --cdp http://127.0.0.1:9241
node CB.js --queue-status
```

`--run-queue` processes scheduled prompts in strict queue order. It only considers the first non-done job: `running`, `waiting`, `needs_recovery`, or `failed` jobs block later pending work until they are recovered, reset, or intentionally skipped. It sends one prompt, waits for target app to finish, records the transcript/session id, then starts the next queued prompt. If target app is still generating when a timeout fires, the job is held as `waiting` and the runner stops instead of marking it failed and continuing. Pre-send UI blockers such as subscription modals or `modal-conversation-history-rate-limit` are held as `needs_recovery`; no prompt is considered submitted and the next queued job must not start. A follow-up can target a future conversation alias before target app has assigned the real `/c/<session-id>`; the first `--new-conversation --alias ...` job resolves that alias after the answer lands, and later jobs open the resolved session id.

`--recover-queue` never sends a new prompt. It syncs the active target app conversation, skips any in-flight assistant preface while the stop control is visible, updates matching rounds/jobs after the final answer is complete, audits already-done jobs for stale response counts, and reports the first queue blocker or next pending job. Use `--conversation <session-id-or-alias>` with `--recover-queue`, `--sync-transcript`, `--latest-assistant`, or `--status` to inspect or recover a specific existing conversation without sending a message. Scheduler completion is driven by target app state, not by a timer: queued jobs have no response timeout by default, and older jobs that only stored the default `180000` timeout do not inherit it. Use `--timeout <ms>` only as an explicit watchdog, or `--timeout 0` to force no timeout.

Scheduler and conversation state is private output data under `outputs/scheduler/`: `queue.json`, `conversation-index.json`, and `rounds.json` are the readable current state, while their `.jsonl` companions are append-only event journals.

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
node CB.js --conversation 6a3338bc-81a0-83ec-a28f-28a763a2bc1b --message "Follow up in this session"
node CB.js --new-conversation --alias scratch-a --message "Start a fresh session and index it"
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

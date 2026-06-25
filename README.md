# Chatbot CLI

Terminal bridge for an already-open target app browser tab exposed through Chromium DevTools Protocol.

CB uses Rebrowser's patched Playwright Core driver by default while still connecting
to the already-open browser through CDP. Set `CHATBOT_PLAYWRIGHT_PACKAGE=playwright-core`
to fall back to unpatched Playwright Core for compatibility checks.
Rebrowser's patched Playwright packages can lag upstream Playwright releases, so
driver upgrades should be validated with a live CDP status check.

## Configuration

Copy `.env.example` into your shell or service environment and set:

- `CHATBOT_CDP_URL`: Chromium DevTools endpoint. Defaults to `http://127.0.0.1:9222`.
- `CHATBOT_WEB_URL`: target web app URL. Defaults to the built-in target app URL; set this in services to avoid hard-coded hosts.
- `CHATBOT_CDP_CONNECT_TIMEOUT_MS`: Chromium DevTools attach timeout. Defaults to `60000`.
- `CHATBOT_PLAYWRIGHT_PACKAGE`: automation driver package. Defaults to `rebrowser-playwright-core`.
- `CHATBOT_TRANSCRIPT_DIR`: private transcript output directory. Defaults to `outputs/`, which is gitignored.
- `CHATBOT_PLAYWRIGHT_CORE_PATH`: optional absolute module path override; wins over `CHATBOT_PLAYWRIGHT_PACKAGE`.

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

Use `--new-tab` when a test prompt should run in a separate target app tab without
taking over an already-running conversation:

```bash
node CB.js --cdp http://127.0.0.1:9241 --new-tab --new-conversation --message "hello"
```

## Commands

Inspect the current target app page:

```bash
node CB.js --status
node CB.js --status --state-jsonl
node CB.js --status --deep-status
node CB.js --models
node CB.js --stop
node CB.js --latest-assistant
node CB.js --sync-transcript
node CB.js --search "project name"
node CB.js --search "project name" --search-scrolls 3
node CB.js --search "project name" --search-all
node CB.js --search "project name" --search-open 1
node CB.js --dismiss-blocker
```

`--status` is a passive current-page DOM read for composer, generation, turn,
artifact, and voice/dictation state. Use it while another target app response is in
progress; it does not open model UI or run the startup settle/reconcile path.
`--deep-status` additionally opens the model picker/configurator to inspect the
live model/reasoning options; reserve that for model-picker debugging, not
ordinary readiness checks.

`--models` opens the live model picker and Configure dialog, then reports the
current header, selected composer button, visible mode rows, reasoning-effort
flyout options, and the Configure dialog's model list. These labels are scraped
from the current UI because model names and picker layout change over time,
including headers such as `Latest` or `Legacy`.

`--search <query>` opens the target app's left-navigation search UI, enters the
query, prints visible results, and closes the search dialog. Add
`--search-open <index-or-title>` to open a result from that search by 1-based
index or title/session text match. Search does not dismiss unrelated blocking
modals; use `--dismiss-blocker` for that explicit action.

Search is dynamic: CB waits while the history UI is still searching, distinguishes
no-result state from results, and reports `phase`, `resultCount`, `complete`,
`hasMore`, and `scrolls` in JSONL output. Use `--search-scrolls <n>` to scroll
to the bottom repeatedly and load more results, or `--search-all` to keep
scrolling until the loaded result list stops growing or the safety cap is hit.

`--dismiss-blocker` attempts to dismiss one known safe blocking modal without
sending a prompt or running another UI feature. It only uses safe close/Escape
behavior and reports if the blocker remains or is not safe to dismiss
automatically.

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

`--run-queue` processes scheduled prompts in strict queue order. It only considers the first non-done job: `running`, `waiting`, `needs_recovery`, or `failed` jobs block later pending work until they are recovered, reset, or intentionally skipped. It sends one prompt, waits for target app to finish, records the transcript/session id, then starts the next queued prompt. If target app is still generating when a timeout fires, the job is held as `waiting` and the runner stops instead of marking it failed and continuing. Pre-send UI blockers such as subscription modals or `modal-conversation-history-rate-limit` are held as `needs_recovery`; no prompt is considered submitted and the next queued job must not start. Known safe blockers such as `#modal-subscription-failure` and identified artifact/lightbox close overlays are auto-dismissed by clicking only visible Close controls and then rechecking the blocker state. Payment, upgrade, login, captcha, destructive, or unknown dialogs are not clicked. A follow-up can target a future conversation alias before target app has assigned the real `/c/<session-id>`; the first `--new-conversation --alias ...` job resolves that alias after the answer lands, and later jobs open the resolved session id.

`--recover-queue` never sends a new prompt. It syncs the active target app conversation, skips any in-flight assistant preface while the stop control is visible, updates matching rounds/jobs after the final answer is complete, audits already-done jobs for stale response counts, and reports the first queue blocker or next pending job. Use `--conversation <session-id-or-alias>` with `--recover-queue`, `--sync-transcript`, `--latest-assistant`, or `--status` to inspect or recover a specific existing conversation without sending a message. Scheduler completion is driven by target app state, not by a timer: queued jobs have no response timeout by default, and older jobs that only stored the default `180000` timeout do not inherit it. Use `--timeout <ms>` only as an explicit watchdog, or `--timeout 0` to force no timeout.

Scheduler and conversation state is private output data under `outputs/scheduler/`: `queue.json`, `conversation-index.json`, and `rounds.json` are the readable current state, while their `.jsonl` companions are append-only event journals.

Send a prompt and stream the answer as target app produces it:

```bash
node CB.js --message "Summarize this in three bullets"
```

Before submitting, CB verifies that the composer draft contains the intended
prompt text or a recognized long-form pasted-text attachment. After submitting,
it waits for a matching user turn to appear after the baseline turn before it
records the prompt as accepted or appends it to the transcript.
Before typing or clicking send, CB also checks the center point of the composer
and send button with `document.elementFromPoint()`. If a visible modal, dialog,
or open overlay covers that point and cannot be safely dismissed, CB reports a
UI blocker and does not insert or submit the prompt.

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
`--status --state-jsonl` includes a lightweight `modelSelection` object from
the visible composer button. Add `--deep-status` only when you need a compact
`modelConfig` object with the live model list and effort options.

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
- `/status deep`: inspect model picker/configurator details too.
- `/models`: list visible model picker options.
- `/reasoning`: list visible reasoning controls.
- `/model <text>` and `/reasoning <text>`: click matching UI options.
- `/search <text>`: search target app conversations/history and print results.
- `/search-all <text>`: search and scroll/load until the result list stops growing.
- `/search-open <text>[ | index-or-title]`: search and open the first or matching result.
- `/dismiss-blocker`: dismiss one known safe blocker without sending a prompt.
- `/attach <path>`: queue a file for the next prompt.
- `/artifacts`: save artifact metadata from the latest assistant turn.
- `/download`: save latest-turn artifacts to disk.
- `/stop`: click a visible stop/interrupt generation control.
- `/stream on|off`: toggle live answer streaming.

`CB` is text/file-only. It recognizes target app voice/dictation controls in `/status`, but deliberately does not click `Start dictation`, `Start Voice`, or related microphone controls because the CLI cannot provide voice input.

Multiline paste works directly at `CB>`. Long pasted text that target app converts into a composer attachment is surfaced through `/status`.

Long Markdown prompts are matched back to target app turns with normalized text anchors, so code fences, inline backticks, ProseMirror spacing, and collapsed "show more" rendering do not block response capture.


## Known recovery procedures

Two queue-runner failure modes were observed and hardened in CB.js. The
behaviors below are what the runner now does automatically; the manual steps
are documented in case you ever need to inspect or undo state by hand.

### 1. Stale transcript tail crashes the queue runner

`--run-queue` reconciles the on-disk transcript against the live target app DOM
before running jobs. If a transcript file (typically a leftover
`outputs/new-chat.txt` from a prior clean test) has a tail that no longer
matches the live page, sync used to throw and abort the whole runner before any
job could run.

**Now**: on a transcript-tail mismatch the runner renames the stale file aside
(`outputs/new-chat.txt.stale-<ISO timestamp>`) and retries the sync against a
fresh transcript, instead of throwing. The quarantine is logged.

**Manual recovery** (if ever needed):
```sh
mv outputs/new-chat.txt outputs/new-chat.txt.stale-backup
# the runner recreates outputs/new-chat.txt on next use
```

### 2. A blocking `failed` job pins the queue

By design a job in `failed` status blocks later pending jobs until it is
recovered, reset, or skipped (so genuine failures are not silently dropped).
There was no CLI path to skip a blocking failed job, leaving manual edits to
`outputs/scheduler/queue.json` as the only way out.

**Now**: `--skip-failed` makes `--run-queue` auto-skip a blocking `failed` job,
journal it as `job_skipped_auto`, and continue to the next pending job.

```sh
CB --run-queue --cdp http://127.0.0.1:9241 --skip-failed
```

The default remains that a failed job blocks until manually reset. To skip a
failed job without running the queue, edit
`outputs/scheduler/queue.json` directly:
```sh
python3 -c "
import json, datetime
p='outputs/scheduler/queue.json'
d=json.load(open(p))
for j in d['jobs']:
    if j.get('status')=='failed':
        j['status']='skipped'
        j['updatedAt']=datetime.datetime.utcnow().isoformat(timespec='milliseconds')+'Z'
json.dump(d, open(p,'w'), indent=2)
print('skipped failed jobs')
"
```

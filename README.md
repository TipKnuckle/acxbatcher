# ACX batch uploader

## macOS app prototype

The first SwiftUI app lives in `app/`. Build a local app bundle with:

```sh
npm install
bash scripts/build-app.sh
open 'dist/ACX Batcher.app'
```

Requires macOS 14+, Xcode/Swift for building, Google Chrome, and Node.js 20+
installed at `/opt/homebrew/bin/node` or `/usr/local/bin/node`. This development
bundle includes the JavaScript engine and Playwright but **does not yet bundle
Node.js**. It is ad-hoc signed for local use, not notarized for distribution.

Choose a project in the app's Chrome window, open its finished-audio page, then
click **Use this project**. Alternatively paste the title URL. Add MP3s or folders
using drag-and-drop or the picker. Every MP3 is included; subfolders are not
searched. Imports append in natural filename order. Edit titles inline and drag
rows to reorder (or use the context menu). The prefix checkbox regenerates all
display titles from filenames, so use it before custom title edits.

**Check ACX project** previews Add / Upload / Skip and lists existing sections,
including unrelated rows. Review this before clicking **Start upload**. New files
append to the chapter list. **Pause after current file** waits for upload and
analysis before stopping. To resume, check the project again. Titles and order
lock when a batch starts. The app prevents idle system sleep during uploads and
refuses to quit mid-operation; pause and wait, then quit. Progress is verified
after a reload; the app never submits an audiobook for review.

Saved batches, journals, and the app's separate Chrome login profile live under
`~/Library/Application Support/ACXBatcher/`. This does not use the CLI's existing
`.acx-profile`, so sign into ACX once in the app's window. Current CLI uploads are
not imported into the app automatically. Do not run the app and CLI against the
same ACX project at the same time.

First-version scope: chapter-list uploads, including individual books' credits.
Separate collection opening/closing-credit and retail-sample slots still need
to be filled in ACX. Multi-project scheduling, parallel uploads, runtime bundling,
notarization, and app updates are future work.

### Architecture

- `app/Sources/ACXBatcher/`: SwiftUI interface, saved batches, process bridge.
- `desktop-engine.mjs`: JSON-lines commands/events over stdin/stdout; owns Chrome.
- `acx-page.mjs`: ACX selectors, project inspection, row actions, status detection.
- `uploader.mjs`: sequential batch execution, journaling, resume, pause, progress.
- `plan.mjs`: local file metadata, filename sorting, display-title cleanup.
- `cli.mjs`: existing command-line entry point, still supported.

The app and CLI share the same adapter and upload engine. ACX layout changes
should be handled in `acx-page.mjs`. Local browser tests use a simulated page and
never upload to ACX. `npm test` also exercises the desktop engine protocol.

Prototype validation: Swift release build succeeds; all seven Node tests and the
real-Chrome fixture test pass, including pause after one file and resume without
duplicates. Native UI checks imported the full 116-file DR2 folder, edited titles,
toggled prefix cleanup, reordered/restored rows, and verified the saved draft
reappeared after restarting the app. Live uploads from the Swift app have not
been run; the earlier live tests used the shared engine through the CLI/browser
connection. Drag-and-drop is implemented; the native file picker was used for
the manual import test.

## Command-line tool

A local Node.js + Playwright script. No AI model or API key is needed to run it.
It adds chapters, names them, uploads one MP3 at a time, waits for the audio player
and matching filename, and verifies the files remain after a page reload.
It does **not** submit the audiobook for review.

## Setup

Requires Node.js 20+ and Google Chrome. From this directory:

```sh
npm install
```

## Three-chapter test

The included `test-plan.json` selects Chapters 1–3 from:
`/Volumes/Blackbird/Project Archive/2020/DR6 Reckoning/Finals/`.

Preview without opening Chrome or uploading:

```sh
npm run acx -- upload test-plan.json
```

Run:

```sh
npm run acx -- upload test-plan.json --execute
```

The script opens a visible Chrome window using a separate `.acx-profile` folder.
It waits up to eight seconds for the correct title's enabled **Add chapter** button,
then starts automatically. If the upload page isn't ready, it prompts you to sign
in and open **Produce audiobook → Produce finished audio**, then press Enter.
It checks readiness again before starting. The profile retains your login for
future runs, so an already-ready upload page requires no Enter confirmation.
Your ordinary Chrome profile and the ChatGPT extension are not required.
Do not launch two uploader runs with the same profile at once.

## Another folder or book

```sh
npm run acx -- plan \
  --folder '/absolute/path/to/Finals' \
  --url 'https://www.acx.com/titleview/YOUR_TITLE_ID' \
  --out next-book.json
npm run acx -- upload next-book.json
npm run acx -- upload next-book.json --execute
```

Add `--limit 3` to `plan` for a small test. Existing plan files are not overwritten.
Every MP3 in the selected folder is included, including credits, introductions,
epilogues, and samples. Files sort by
their full filename, ascending, using natural numeric sorting (case-insensitive
English collation). For example, Chapter 2 precedes Chapter 10 and Book 2 precedes
Book 10. Numeric prefixes are optional; repeated prefixes and chapter numbers
are allowed. No book order is inferred beyond filename order. Equivalent sort
keys use a deterministic exact-name tie-breaker. Review the plan before uploading.
Every file becomes a section in the audiobook chapter list in that order. Individual
books' credits stay inside the boxed set, exactly where their filenames place them;
they are not routed into ACX's separate collection credits or retail sample slots.
Use a folder containing exactly the audio you want included (or edit the plan).
Source files are never renamed or changed.

The JSON array defines upload order; `title` is the editable ACX display title.
New plans remove the `.mp3` extension and a leading numeric prefix plus separator
(`-`, `–`, `—`, `_`, or `.`) from display titles. For example,
`001 - DR6 - Reckoning - Credits - Open.mp3` becomes
`DR6 - Reckoning - Credits - Open`. Source filenames and sorting are unchanged.
Existing plans and uploaded titles are not automatically rewritten, especially
while an upload is running.
Use unique titles across books (for example `Reckoning - Chapter 1`). Prefixes can
be changed in the plan without renaming MP3s. Edit before the first upload; once a
run has started its state is bound to that exact plan. To combine books, combine
their `items` arrays in the intended order in a new plan file, preserving each
file's recorded size and modification time.

Renaming files or changing planned titles prevents matching earlier uploads by
their original names. If the original three test chapters are still on ACX when
you switch to newly prefixed filenames, remove those test rows before uploading
the new plan; otherwise the new titles will be appended as additional chapters.

## Resume and limitations

Rerun the same command after an interruption. A companion `.state.json` journal
tracks work; ACX's current page is checked as well. Existing rows with exactly
matching titles, filenames and a duration are skipped. This comparison does not
verify remote audio contents byte-for-byte. Do not use identical filenames for
different audio versions. Changed local size or modification time stops the run.

New rows append after existing chapters. Existing rows from this plan must be a
contiguous suffix in the same order; mismatches, duplicates and uncertain states
stop rather than reorder, replace, or delete audio. An interruption between adding
and naming a row stops on resume and explains which title to give that row. A
hard process termination can leave a `.lock` file: remove it only after confirming
the old process has stopped. Avoid editing the ACX page during a run.

Upload/analysis timeout is 20 minutes per chapter. Failures stop the batch for
inspection; they are not blindly retried. ACX audio-quality warnings still need
human review. The page structure may change and require selector updates.

The upload engine accepts a browser adapter, allowing the same engine to be
tested through the connected Chrome plugin. Standalone runs use ordinary
Playwright and a separate login profile; the extension's file-URL permission
only applies to the plugin-based test.

```sh
npm test
npm run test:browser
```

## Validation on October 10, 2026

- Live ACX: Chapters 1–3 of Reckoning uploaded to The Dark Road Series Collection 2.
  Chapter 1 was used to inspect the UI; the reusable engine uploaded Chapters 2–3,
  verified persistence after reload, then skipped all three on a second run.
- Real Playwright with a local simulated ACX page: added and uploaded three rows,
  reloaded, and resumed without duplicates. No external uploads occur in this test.
- Unit tests cover natural filename ordering, repeated chapter numbers, changed files,
  completion detection, title targeting, row ordering, and resume skips.
- The standalone profile's real ACX sign-in has not been exercised; it requires
  your login in the window opened by the CLI. The live test used the connected
  Chrome session and the same upload engine through its browser adapter.

The three live test uploads remain on ACX. No credits or sample were uploaded,
no source filenames changed, and the audiobook was not submitted for review.

# Dayline: guide for agents

This file is for an AI agent that sets up, runs or changes Dayline for a person. Read it before the README. The README is the user manual; this is the operating manual.

## What Dayline is

A local-first task planner for macOS. An Electron app starts a local HTTP server on `127.0.0.1` and shows a vanilla-JS web UI. It reads Google calendars, plans tasks around meetings, and can offer public booking links. All planner data stays in one JSON file on the Mac.

## Set it up for a person

Do the steps you can do yourself. Stop and ask the person only for the steps marked **person**.

1. Check the tools: macOS 13 or later, Node.js 22.13 or later (`node --version`), Xcode Command Line Tools (`xcode-select -p`). The packaging step needs `sips`, `iconutil`, `codesign` and `ditto`, which macOS provides.
2. Install dependencies:

   ```bash
   npm ci
   ```

3. Check the checkout is sound. All tests must pass. They need no network and no Google account.

   ```bash
   npm test
   ```

4. Run it. Pick one:
   - From source, with a window: `npm start`
   - Browser only, on a separate development profile: `npm run dev`, then open the single-use link it prints.
   - As an installed app: see [Build and install](#build-and-install).
5. **Person:** Google sign-in. Dayline needs a Google OAuth client of type **Desktop app**. You cannot create one for them without their Google account. Tell them to follow “Google Calendar setup” in the README, download the client JSON, then choose it in **Settings → Calendars** and sign in. Never ask them to paste a password, token or client secret into the chat.
6. **Person:** macOS may ask for access to **Dayline Safe Storage** in Keychain, and may block an unsigned app on first open. Only they can approve these.
7. Task agent. Estimates use an AI client the person already has (`codex`, `claude`, `agy` or `gemini` on `PATH`), with their own subscription. Without one, choose **Local on this Mac** in **Settings → Task agent**. Do not create accounts for them.

What does not work outside Antaia is listed in the README under “Using Dayline outside Antaia”. Read that before promising booking links or live calendar updates to anyone without an `antaia.space` Google account.

## The person's data: do not lose it

- Planner data: `~/Library/Application Support/Dayline/planner.json`. Tasks, settings, connected accounts and Google refresh tokens sealed with the macOS Keychain.
- The development server uses `~/Library/Application Support/Dayline Development/` instead.
- The app bundle holds no data. Rebuilding or reinstalling the app never deletes data.
- Before you replace the app, change the data format, or run anything that writes to that folder: quit Dayline and copy `planner.json` to a dated file beside it.
- Never print the contents of `planner.json`. It holds private tasks and sealed credentials. To inspect it, print counts and field names only.
- For experiments use a throwaway profile: set `DAYLINE_DATA_DIR` to a temporary folder and `DAYLINE_PORT` to a free port. Two instances cannot share a profile or a port.

## Commands

| Command | What it does |
| --- | --- |
| `npm ci` | Install the locked dependencies. |
| `npm test` | Run every test (`node --test tests/*.test.mjs`). Must be green before and after a change. |
| `npm start` | Run the Electron app from source on port 43127. |
| `npm run dev` | Browser-only server on port 43128 with the development profile. Prints a single-use link. |
| `npm run package:mac` | Build `dist/Dayline-darwin-universal/Dayline.app` and a ZIP. Takes a few minutes. |
| `node scripts/booking-preview.mjs` | Preview the public booking page at `http://127.0.0.1:43129/demo`, without Cloudflare or Google. |

Environment variables:

| Variable | Effect |
| --- | --- |
| `DAYLINE_DATA_DIR` | Folder for `planner.json`. Use it for a throwaway profile. |
| `DAYLINE_PORT` | Port of the local server (default 43127 for the app, 43128 for `npm run dev`). |
| `DAYLINE_PUSH_RELAY` | HTTPS origin of the receiver. Empty string switches the receiver off. |
| `DAYLINE_GOOGLE_CLIENT_FILE` | At packaging time only: path of a Desktop OAuth client JSON to bundle into the app. |
| `DAYLINE_ARCH` | At packaging time only: `universal` (default), `arm64` or `x64`. |

## Build and install

Follow this order. It keeps the person's data and leaves a way back.

1. `npm ci`, then `npm test`, then `npm run package:mac`.
2. Check the build: `codesign --verify --deep --strict dist/Dayline-darwin-universal/Dayline.app`.
3. Ask the person before you quit their running Dayline.
4. Quit it by its full path, because a Mac can hold several copies: `osascript -e 'tell application "/path/to/Dayline.app" to quit'`. Wait until the process is gone.
5. Copy `planner.json` to a dated backup beside it.
6. Keep the old app: zip it with `ditto -c -k --sequesterRsrc --keepParent <old app> <backup zip>`.
7. Move the old app out of the way, then `ditto dist/Dayline-darwin-universal/Dayline.app <Applications folder>/Dayline.app`.
8. `open` the new app. Check `http://127.0.0.1:43127/` answers 200 and that `planner.json` still has the same number of tasks and accounts.
9. Tell the person that macOS may ask again for **Dayline Safe Storage**: a new build has a new signature.

## Where things are

| Path | What |
| --- | --- |
| `desktop/main.cjs` | Electron entry. Starts the service and the local server. |
| `src/service.mjs` | The planner: tasks, Google accounts, sync. All writers run through `service.run`. |
| `src/google.mjs` | Every Google OAuth and Calendar request. |
| `src/http.mjs` | Local HTTP API and static files for the UI. |
| `src/store.mjs` | `planner.json` and the Keychain-backed vault. |
| `src/booking-*.mjs` | Booking links on the Mac: rules, free times, the receiver client. |
| `src/agents/` | Adapters for the task-agent CLIs. |
| `web/` | The UI: plain ES modules and CSS, no build step. |
| `relay/` | The Cloudflare Worker (“receiver”): live calendar signals and public booking pages. |
| `tests/` | One `*.test.mjs` per area. `tests/fake-google.mjs` is a stand-in Google for end-to-end tests. |
| `scripts/` | Packaging and the booking page preview. |

## Rules for changing the code

- Plain ESM JavaScript. No TypeScript, no bundler, no framework. `luxon` is the only runtime dependency; do not add another without a reason the person accepts.
- Every change comes with a test under `tests/`. View tests use a small fake DOM; follow the nearest existing test.
- Keep `npm test` green. Do not delete or weaken a test to make a change pass.
- UI text is plain English, sentence case. Times are 24-hour.
- The README states what leaves the Mac. If a change sends or stores anything new outside the Mac, update that section in the same change.
- Work on a branch and open a pull request, unless the person tells you otherwise.

## Do not do these without the person's explicit yes

- Deploy the receiver (`npx wrangler deploy --config relay/wrangler.jsonc`). It serves real guests.
- Change anything in a Google Cloud project, or submit an OAuth client for verification.
- Quit, replace or reinstall their running app.
- Delete or rewrite `planner.json`, or disconnect a Google account.
- Book, move or cancel a real calendar event to “test” something. Use `tests/fake-google.mjs`.
- Commit an OAuth client JSON, a `.env` file or any token. `.gitignore` already excludes the usual names.

## Checking your work

- Logic: `npm test`.
- Public booking page: `node scripts/booking-preview.mjs`, open `/demo`. `/__mac/asleep` and `/__mac/awake` switch the pretend Mac.
- App UI: `npm run dev` with a throwaway `DAYLINE_DATA_DIR`, open the printed link. The development profile has no Google account, so calendar and booking states that need one are not reachable there; say so in your report instead of claiming they were checked.
- Receiver bundle: `npx wrangler@4.167.0 deploy --dry-run --config relay/wrangler.jsonc` builds without deploying.

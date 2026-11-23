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
5. **Person:** Google sign-in. Dayline needs a Google OAuth client of type **Desktop app**, and each person or organization uses their own. Follow [Their own Google client](#their-own-google-client) below. Never ask them to paste a password, token or client secret into the chat.
6. **Person:** macOS may ask for access to **Dayline Safe Storage** in Keychain, and may block an unsigned app on first open. Only they can approve these.
7. Task agent. Estimates use an AI client the person already has (`codex`, `claude`, `agy` or `gemini` on `PATH`), with their own subscription. Without one, choose **Local on this Mac** in **Settings → Task agent**. Do not create accounts for them.

Steps 1 to 7 give a working planner that reads Google calendars. Live calendar updates and booking links need a receiver as well. Antaia’s receiver serves Antaia’s Google Workspace only, and only with Antaia’s Google client. For anyone else, set up [their own receiver](#their-own-receiver-on-cloudflare) before you promise either.

## Host it yourself: Google and Cloudflare

Two things live outside the Mac, and each person or organization has their own of both:

| Thing | What it is for | Needed for |
| --- | --- | --- |
| A Google OAuth client | Lets Dayline ask Google for calendar access. | Any use of Google calendars. |
| A receiver on Cloudflare | Passes Google’s “a calendar changed” signals to the Mac, and serves the public booking pages. | Live calendar updates and booking links. Without one, Dayline checks Google on a timer and has no booking page. |

Do not use Antaia’s Google client or Antaia’s receiver for someone outside Antaia. Antaia’s client file is not in this repository and must not be asked for. The client ID in `relay/wrangler.jsonc` is Antaia’s public identifier; replace it at deploy time as shown below.

### Their own Google client

Everything here happens in the person’s Google account, in their browser. **Person**, unless they tell you to drive their browser, and even then they sign in themselves.

1. Open <https://console.cloud.google.com/>, create a project (any name, for example `dayline`).
2. **APIs & Services → Library**: enable **Google Calendar API**.
3. **Google Auth Platform → Branding**: app name `Dayline`, their address as support and developer contact.
4. **Google Auth Platform → Audience**. Pick by the accounts they will connect:

   | Their accounts | Choose | What they get |
   | --- | --- | --- |
   | All in one Google Workspace | **Internal** | No warning, no expiry. Accounts outside that Workspace cannot sign in. |
   | A personal Gmail account, or accounts in several organizations | **External**, then **Publish app** so the status is **In production** | Sign-in shows “Google hasn’t verified this app”: choose **Advanced**, then **Go to Dayline**. Access does not expire. |
   | Just trying it | **External**, left in **Testing**, with each address added under **Test users** | The same warning, and Google ends every sign-in after seven days. |

   The warning goes away only when Google verifies the app. That needs a public home page and privacy policy on a domain they own, and a review by Google. It is their decision; do not submit it for them.
5. **Google Auth Platform → Clients → Create client**: application type **Desktop app**. Download the JSON. No redirect address is needed: a Desktop client may use `http://127.0.0.1`.
6. Keep the JSON out of the repository and out of the chat. In Dayline: **Settings → Calendars → Choose client file**, select it, then **Connect Google account**. Or bundle it into a build with `DAYLINE_GOOGLE_CLIENT_FILE` (see [Build and install](#build-and-install)).

Dayline asks Google for these permissions, and only when a feature needs them. Nothing has to be listed in the console for an Internal or unverified client.

| Feature | Scopes |
| --- | --- |
| Always | `openid`, `email`, `calendar.calendarlist.readonly`, `calendar.events.freebusy` |
| **Show meeting details** | also `calendar.events.readonly` |
| **Sync tasks as calendar events**, or **Allow booked meetings** | also `calendar.events` |

You may read `installed.client_id` from the JSON: it is public and the receiver needs it. Never print `client_secret`.

```bash
node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).installed.client_id)" /path/to/client.json
```

### Their own receiver on Cloudflare

The receiver is the Worker in `relay/`. It keeps what the README lists under “What leaves your Mac”, for the people it serves. A free Cloudflare account is enough for a few people; the Worker uses SQLite-backed Durable Objects, which the free plan includes.

Deploying creates a public service in their Cloudflare account. Get their yes first.

1. **Person:** a Cloudflare account, and a sign-in for Wrangler. Either they run this and approve in the browser:

   ```bash
   npx wrangler@4.167.0 login
   ```

   or they create an API token with the **Edit Cloudflare Workers** template and export it as `CLOUDFLARE_API_TOKEN` in the shell you use. They never paste it into the chat. A new account must also pick its `workers.dev` subdomain once, under **Workers & Pages** in the dashboard.
2. Decide who the receiver serves. Use one or both:
   - `ALLOWED_DOMAIN`: a Google Workspace domain, for example `example.org`. Every account of that Workspace may use it.
   - `ALLOWED_EMAILS`: addresses separated by commas, for personal Google accounts, for example `ada@gmail.com`.

   The part of an address before the `@` becomes that person’s booking page name. Do not allow two addresses with the same part before the `@`: they would share one page.
3. Deploy. Pass all three values every time, also for a later update, because the file in the repository holds Antaia’s. Leave one of the two lists empty by writing nothing after the colon.

   ```bash
   npx wrangler@4.167.0 deploy --config relay/wrangler.jsonc --var GOOGLE_CLIENT_ID:THEIR_CLIENT_ID --var ALLOWED_DOMAIN:example.org --var ALLOWED_EMAILS:
   ```

   Wrangler prints the address, of the form `https://dayline-calendar.<their-subdomain>.workers.dev`. That is the receiver’s origin. To use another Worker name, add `--name <name>` to this command and to the next one.
4. Give it its secret. It signs the tickets for each Mac and the reschedule links for guests. Create it once; replacing it later breaks every link already sent.

   ```bash
   openssl rand -base64 48 | npx wrangler@4.167.0 secret put RELAY_SECRET --config relay/wrangler.jsonc
   ```

5. Check it. The first must answer `{"ok":true}`. The second must answer 401: it means the secret is in place and the receiver wants a Google identity. 503 means the secret or the client ID is missing.

   ```bash
   curl -s https://dayline-calendar.<their-subdomain>.workers.dev/health
   ```

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' -X POST https://dayline-calendar.<their-subdomain>.workers.dev/v1/session
   ```

6. Point the Mac at it. `DAYLINE_PUSH_RELAY` is the receiver’s origin. `DAYLINE_RELAY_ACCOUNT` names the connected account that signs in to it: a full address, or `@` and a domain. Leave it out when only one account is connected; with several, Dayline otherwise takes a Workspace account before a Gmail one.
   - From source:

     ```bash
     DAYLINE_PUSH_RELAY=https://dayline-calendar.<their-subdomain>.workers.dev npm start
     ```

   - As an installed app. An app opened from Finder does not see shell variables, so build them in. The build then carries the origin, the account rule and, if given, the Google client:

     ```bash
     DAYLINE_PUSH_RELAY=https://dayline-calendar.<their-subdomain>.workers.dev DAYLINE_RELAY_ACCOUNT=ada@gmail.com DAYLINE_GOOGLE_CLIENT_FILE=/path/to/client.json npm run package:mac
     ```

     Then follow [Build and install](#build-and-install) from step 2.
7. In Dayline, connect the Google account. **Settings → Calendars** then says “Google push is live for …”. For booking links, open **Bookings**, choose **Allow booked meetings** for the address, enter the name guests see, and switch on **Offer booking links**. The page is at the receiver’s origin, then `/`, then the part of the address before the `@`.

If something fails:

| Sign | Cause |
| --- | --- |
| Session answers 401 with a Google identity | The Mac’s Google client is not the one in `GOOGLE_CLIENT_ID`. Both must be the same client. |
| Session answers 403 | The account is not in `ALLOWED_DOMAIN` or `ALLOWED_EMAILS`, or a Workspace domain was given for a personal account. Deploy again with the right values. |
| Session answers 503 | `RELAY_SECRET` is missing or shorter than 32 bytes, or `GOOGLE_CLIENT_ID` is empty. |
| Bookings says the receiver did not accept this Mac | One of the three above. Ask the receiver directly as in step 5. |
| Bookings says booking pages are not available on the receiver | The deployed receiver is older than the app. Deploy again from the same checkout. |
| **Settings → Calendars** keeps saying “Dayline is checking Google for changes automatically.” | The Mac was started without `DAYLINE_PUSH_RELAY`, or the build does not carry it. |

To take the receiver down: `npx wrangler@4.167.0 delete --config relay/wrangler.jsonc`. That deletes every stored booking page and waiting request. Ask first.

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
| `DAYLINE_PUSH_RELAY` | HTTPS origin of the receiver. Empty string switches the receiver off. Set at packaging time, the build carries it. |
| `DAYLINE_RELAY_ACCOUNT` | Which connected Google account signs in to the receiver: a full address, or `@` and a domain. Set at packaging time, the build carries it. |
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
| `src/receiver-choice.mjs` | Which receiver the Mac uses and which account it signs in with. |
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

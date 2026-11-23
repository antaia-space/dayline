# Dayline

Dayline turns a to-do list into time blocks on Google Calendar. Write a task in plain English and the weekly board shows which day it landed on. Open a day to see its tasks alongside your calendar’s busy periods. The Mac window and the local browser view share one planner.

![An example week in Dayline with nine tasks across five working days](docs/example-week.png)

## Install on a Mac

1. Sign in to GitHub with access to the Antaia repository. For an Apple silicon or Intel Mac running macOS 13 or later, download **Dayline-1.0.0-mac-universal.zip** from [Dayline releases](https://github.com/antaia-space/dayline/releases).
2. Unzip the download, drag **Dayline.app** to **Applications**, and open it. To use the same planner in your browser, choose **File → Open in Browser** in the Mac app.

The internal build uses an ad hoc signature and has not been notarized by Apple. If your Mac’s launch policy requires approval, follow Antaia’s approved procedure or run the app from source below.

## Connect your calendars

1. Get the company’s Google Desktop OAuth client JSON file from your Workspace administrator. In **Settings → Calendars**, select **Choose client file** and import it. [Google Calendar setup for administrators](#google-calendar-setup)
2. Select **Connect Google account**, sign in through your browser, and grant calendar access. Repeat for each eligible account you want included.
3. Choose **Calendar for new tasks**. Dayline checks availability on the account’s calendars by default, including shared calendars. Under **Check for conflicts on**, choose which calendars to include and save. The writable destination calendar is always checked.
4. In **Settings → Working hours**, choose your days, start and end times, and time zone. The default is Monday–Friday, 09:00–17:00, in the Mac’s time zone.

### Google Calendar setup

A Workspace administrator sets this up once for Antaia. In an organization-owned Google Cloud project, enable the Google Calendar API. Configure the Google Auth Platform branding and choose the **Internal** audience. Create an OAuth client of type **Desktop app**, download its JSON, and distribute that file through Antaia’s internal channels. Each teammate authorizes their own account on their own Mac. [Enable the API](https://developers.google.com/workspace/guides/enable-apis) · [Configure the consent screen](https://developers.google.com/workspace/guides/configure-oauth-consent) · [Create desktop credentials](https://developers.google.com/workspace/guides/create-credentials#desktop-app)

An Internal client accepts accounts in the Google Workspace organization that owns it. To include a personal calendar, you can share its free/busy availability with your work account and select it in Dayline. Each additional sign-in must be eligible for the chosen OAuth client.

To distribute a build with the company’s Desktop client already configured, set the environment variable `DAYLINE_GOOGLE_CLIENT_FILE` to the JSON file’s local path when running the Mac packaging command. Each teammate still signs in to Google. Keep the downloaded file out of source control.

## Plan a task

- **“Draft a proposal by Friday”** lets Dayline estimate the duration and choose an opening before the deadline. **“Call Morgan for 20 minutes tomorrow afternoon”** sets the duration and narrows the search to tomorrow afternoon.
- Each task gets a type and a consistent calendar color. Select the task to see the estimate or change its text, duration, type, or preferred day. When there is no opening long enough, it appears under **Unscheduled**.
- Tick a task to mark its linked event with ✓. In Google Calendar, add ✓ to the beginning or end of the event title, or open **Mark complete** in the event description and confirm on the Mac running Dayline. Remove the title’s ✓ or uncheck the task to reopen it.
- Closing the Mac window keeps synchronization running. After quitting, reopen Dayline to catch up. **Sync now** retries pending changes. Confirming **Delete task** also removes its linked event. Dayline checks Google’s event version when updating or deleting an existing block so concurrent edits can be reconciled.

Dayline stores its planner in `~/Library/Application Support/Dayline`. Google receives the titles, times, colors, and completion state of linked events. The desktop client protects Google credentials with macOS Keychain-backed encryption. On compatible Apple silicon Macs running macOS 26 or later with Apple Intelligence available, a local model helps estimate the type and duration. The built-in text rules handle estimates when the model is unavailable. Task estimation runs without an AI subscription or API key.

## Run from source

With Node.js 22.13 or later and access to the private repository, run these commands on your Mac.

```sh
git clone https://github.com/antaia-space/dayline.git
cd dayline
npm ci
npm start
```

| Command | Result |
| --- | --- |
| `npm test` | Run the automated tests. |
| `npm run package:mac` | Build the universal Mac application. |
| `npm run dev` | Start the browser-only development server. Open the single-use URL printed in the terminal. |

The app and **File → Open in Browser** share the desktop profile on loopback port 43127. The development server runs on `127.0.0.1:43128` and stores its separate profile in `~/Library/Application Support/Dayline Development`.

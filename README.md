# Dayline

Dayline finds time for your to-do list. Write a task in plain English and it estimates the work, checks your selected Google calendars, and finds an opening within your working hours. The weekly board and day agenda show your tasks alongside your meetings. The Mac app and its local browser view share one planner.

![An example week in Dayline with nine tasks across five working days](docs/example-week.png)

## Install on a Mac

1. Sign in to GitHub with access to the Antaia repository. Download the universal Mac ZIP for an Apple silicon or Intel Mac running macOS 13 or later. [Latest Mac release](https://github.com/antaia-space/dayline/releases/latest)
2. Unzip the download, drag **Dayline.app** to **Applications**, and open it. To use the same planner in your browser, choose **File → Open in Browser** in the Mac app. Both views follow your system’s light or dark appearance.

The internal build uses an ad hoc signature and has not been notarized by Apple. If your Mac’s launch policy requires approval, follow Antaia’s approved procedure or run the app from source below.

## Connect your calendars

1. Open **Settings → Calendars**. If prompted, get Antaia’s Google Desktop OAuth client JSON from your Workspace administrator and select **Choose client file**. [Google Calendar setup for administrators](#google-calendar-setup)
2. Leave **Calendar access** on **Read calendars, keep tasks local**. Choose **Connect Google account** and approve the read-only permissions in your browser. For an account already connected for busy times, click **Show meeting details** beside its address and choose that account in Google. Each account needs its own approval.
3. **Check for conflicts on** starts with all available calendars selected, including shared calendars. Google’s generated Week Numbers feed has no bookable events and is omitted. Keep at least one availability calendar selected and choose **Save calendars**. In availability-only mode, you can uncheck any calendar, including your primary.
4. In **Settings → Working hours**, set your days, hours, and time zone. The default is Monday–Friday, 09:00–17:00, in the Mac’s time zone.

Calendar access is read-only by default. Task blocks, checkmarks, and deletions stay on your Mac. Google’s busy periods keep those times clear for meetings. If Google cannot confirm availability, upcoming tasks wait under **Unscheduled** until a refresh succeeds. Choose **Refresh availability** to retry. After an internal Mac update, macOS may ask for access to **Dayline Safe Storage** in Keychain. Allow that item in the system dialog and refresh. You can keep capturing and estimating tasks while calendar access is waiting.

Hover over a meeting’s **name** in either calendar view to preview its time, organizer and guest responses. Click or tap the name to keep the details open. From the keyboard, focus the name and press **Enter**. Choose **Join** to open the meeting directly. Google controls which details and guests you can see on shared calendars. Calendars shared as free/busy show anonymous busy blocks. Entries marked free can appear in the agenda while leaving that time available for tasks. Dayline keeps meeting details in memory on your Mac and sends only task information to the task agent. [Google Calendar permissions](https://developers.google.com/workspace/calendar/api/auth)

### Live meeting updates

With your Antaia Google account connected, the Mac app subscribes to changes on your selected calendars. When Google delivers a change, Dayline refreshes the meeting, frees its former slot and replans flexible tasks in every open planner window. An open meeting panel follows changes to the time, guest responses and joining details. **Settings → Calendars** shows how many calendars have live delivery.

Antaia hosts the notification receiver on Cloudflare. Dayline proves workspace membership with a Google ID token issued for the Dayline client. Google sends the receiver calendar channel headers. The receiver forwards an opaque change signal to your Mac. Meeting content, tasks and Google credentials that can read calendar data stay on your Mac or with Google. If a live channel disconnects, Dayline checks Google directly while reconnecting. Reopening the app or waking the Mac also catches up on changes. Google controls notification timing and can occasionally miss a notification. [Google Calendar push delivery](https://developers.google.com/workspace/calendar/api/guides/push)

### Google Calendar setup

A Workspace administrator sets this up once for Antaia. In an organization-owned Google Cloud project, enable the Google Calendar API. Configure the Google Auth Platform branding and choose the **Internal** audience. Create an OAuth client of type **Desktop app**, download its JSON, and distribute that file through Antaia’s internal channels. Each teammate authorizes their own account on their own Mac. [Enable the API](https://developers.google.com/workspace/guides/enable-apis) · [Configure the consent screen](https://developers.google.com/workspace/guides/configure-oauth-consent) · [Create desktop credentials](https://developers.google.com/workspace/guides/create-credentials#desktop-app)

An Internal client accepts accounts in the Google Workspace organization that owns it. To include a personal calendar, you can share its free/busy availability with your work account and select it in Dayline. Each additional sign-in must be eligible for the chosen OAuth client.

For an **External** client in **Testing**, open **Google Auth Platform → Audience → Test users → Add users**. Add the exact addresses you will connect, save, and start a fresh sign-in from Dayline for each one. Google expires the calendar authorization after seven days in this mode. [Google’s OAuth token guidance](https://developers.google.com/identity/protocols/oauth2#expiration)

To distribute a build with the company’s Desktop client already configured, set the environment variable `DAYLINE_GOOGLE_CLIENT_FILE` to the JSON file’s local path when running the Mac packaging command. Each teammate still signs in to Google. Keep the downloaded file out of source control.

## Plan a task

- Press **Enter** to capture a task and keep typing. Dayline saves each entry on your Mac, then creates a short title and estimates the work in the background. Open the task to see your original wording or edit the title. Changing just the title uses no model quota.
- **“Draft a proposal by Friday”** lets Dayline estimate the duration and choose an opening before the deadline. **“Call Morgan for 20 minutes tomorrow afternoon”** sets the duration and narrows the search to tomorrow afternoon.
- **“Eat breakfast for 30 minutes at 10:15”** reserves 10:15–10:45 on the requested day. Two queued thirty-minute tasks can then start at 10:45 and 11:15, leaving fifteen minutes before a noon meeting. An overlapping meeting, an existing fixed task, or working hours can prevent an exact booking. The task shows the conflict in **Unscheduled**.
- In **Day agenda**, a task without a date in its text uses the day you are viewing. Choose a date in the entry field to pin the task to that day, or choose **Auto-schedule** to let Dayline find the next opening. Queued tasks keep their dates across reloads and restarts.
- When an unfinished task’s scheduled time has passed, select **Move to…** and choose a later day. A compact **Moved** entry at the original time links to the destination. The task carries its checklist and duration with it. If that day has no opening, the link takes you to the task in **Unscheduled**.
- A task with several named items gets a checklist automatically. For example, **“Review access in Docs, Slack, and GitHub”** gets three checkboxes in one scheduled block. Use the pencil beside the task title to edit it. Under **Subtasks**, you can add your own steps, rename a step with its pencil, or remove one. On a task with an empty checklist, choose **Add subtask**. Check the last item to complete the task, or reopen an item to resume that work. Your checklist edits are saved on this Mac.
- Each task type has a consistent color. Select a task to see how its duration was estimated or edit its text, duration, type, or preferred day. If there is no opening long enough, the task appears under **Unscheduled**.
- You can start using the planner before connecting a calendar. It finds time within your work hours and around your other tasks. After you connect, it also checks for conflicts with meetings.

### Change a plan from the task field

Enter **“Move the budget review task to Wednesday”** to reschedule the existing task with its estimate and checklist. You can specify a clock time, move one task before or after another in the same day, resize or rename a task, mark it done, reopen it, or move an explicitly named group. For example, **“Give the budget review 10 more minutes”** adjusts the existing reservation. **“Move all unfinished tasks from Tuesday to Friday”** moves the eligible group.

Dayline resolves direct instructions locally. For indirect phrasing such as **“Wednesday would work better for the budget review”**, the selected subscription agent can interpret the sentence and its date/time context. Task matching and availability checks happen on your Mac. If two tasks match, their names and scheduling details appear under the entry field. Select the one you mean, edit the request, or explicitly choose **Add as new task**. You can keep entering other tasks while a choice is open.

For a planning question or a request with several parts, type it in your own words. For example, **“Break the budget review into three steps, give it ten more minutes and move it to Friday.”** The agent proposes specific changes to the existing task. Review the list and choose **Apply changes**. A question such as **“Which tasks on this day are short enough to do first?”** gets a written answer. Use **Quick entry → Ask planner** under the field to send any wording directly to your selected model. If you edit a task while its proposal is open, Dayline checks your current version before applying the changes.

The day you’re viewing helps identify the task, including when your wording uses a familiar abbreviation, a typo or a checklist item. When viewing tomorrow, **“Move the IC presentation prep to today”** moves the matching task to your actual local date. For an earlier unmatched request, choose **Try matching again**.

### Reorder the day

Drag the grip on the left edge of a flexible task to place it above or below another task in its day. The five-minute controls stay at the right edge. You can also click or tap the grip and choose **Move earlier** or **Move later**, or focus it and use the up and down arrow keys. The same controls let you prioritize tasks in **Unscheduled**. The desktop and browser save one order. Working hours, time windows, fixed tasks and Google meetings determine where that order fits.

Dayline packs flexible work into the earliest available slots and replans when a meeting appears, moves or disappears. Already-queued work can start at the end of the preceding block when a refresh comes a few minutes later and that task would still be underway. A newly entered task starts from its capture time or later. Short blocks in the day agenda take less vertical space than long ones.

Checking off a task before its scheduled start frees the whole slot. The day agenda shows the checked item beside the block that takes its place, or below it on a narrow screen. The checked line uses a short display title. Open it for the full wording, checklist and original time. Several completions in the same slot share an expandable line. Items without a matching time appear under **Completed** on their original day. Finishing a task during its slot releases the unused portion. Reopen it to schedule the unfinished work again.

### Adjust a duration

While Dayline is running, an active task that reaches its end unchecked automatically gets another five minutes. Other flexible tasks move to make room. A fixed meeting, a written cutoff or the end of working hours can shorten or stop the extension. The agenda shows the extra time separately from the estimate. Completing an active task releases the remaining time on the next plan.

Use **−** or **+** at the right of a task to subtract or add five minutes per click. Dayline keeps the start time when the resized block fits. Otherwise it looks for another opening within the task’s constraints. On a completed task or an all-day event, the controls adjust the effort estimate while preserving the original calendar block.

When a meeting crowds a day, Dayline first tries each task’s full estimate. If a shorter reservation keeps more work on its planned day, an eligible estimate can shrink by up to 25%, capped at 15 minutes. The task shows the planned length alongside the estimate. Future blocks return to their full length when room opens. An explicit duration in the task, a manual duration, or an exact start takes priority. Automatic adjustments do not teach the task agent a new duration.

Dayline keeps a personal duration note on this Mac. For each activity, it uses the median difference between estimates and your corrections to personalize later estimates. Repeated clicks update a single example. Restoring the original suggestion removes that example. A duration you type into a new task takes precedence. Read your notes in **Settings → Task agent → Your duration notes**.

### Choose a task agent

Saving a new agent or model applies the choice to new tasks in both the desktop and browser views. The settings show which model will take new tasks and which model actually handled the last estimate. Tasks already queued keep the selection they had when you entered them.

New planners start with **OpenAI via Codex**, set to **gpt-6.2-sol** with **low** reasoning effort. Select the agent shown beside task entry to change it. Existing planners keep their saved choice. For offline planning, choose **Local on this Mac**. It uses Apple Foundation Models on compatible Macs with Apple Intelligence available, or built-in rules.

To connect a subscription, select a provider. Install its official client if prompted, choose **Sign in in Terminal**, then **Check sign-in**. If the client is already signed in on this Mac, Dayline can use that session.

| Agent | Account to use in the official client |
| --- | --- |
| OpenAI via Codex | Run `codex login` and choose **Sign in with ChatGPT** using an account with Codex access. [Codex CLI](https://developers.openai.com/codex/cli/) |
| Google Gemini | For an individual Google AI Pro or Ultra account, start Antigravity CLI with `agy` and choose personal Google OAuth. Eligible organization accounts can also use the legacy Gemini CLI by starting `gemini` and choosing **Login with Google** under `/auth`. [Antigravity sign-in](https://antigravity.google/docs/cli/install/) · [Gemini CLI sign-in](https://geminicli.com/docs/get-started/authentication/) · [Google’s migration notice](https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals) |
| Anthropic via Claude Code | Run `claude auth login --claudeai` and sign in with the Claude subscription that includes Claude Code. [Claude Code authentication](https://code.claude.com/docs/en/authentication) |

Codex defaults to `gpt-6.2-sol` with **low** reasoning effort. For Google or Anthropic, leave **Model** blank to use the client’s default. You can also choose a suggestion or enter a model ID supported by your account. Choose **Save agent** to apply it. Each estimate sends the current task, local date and time, time zone, and working hours to the selected provider. When duration feedback matches, the provider can also receive the activity label and number of examples. For contextual planner requests, the model can receive relevant task titles, checklist items and their completion state, categories, dates, durations and working hours. Google meeting details stay on the Mac. Usage comes from the same account quota as the official client.

**Last estimate** shows the source, model, Codex reasoning effort, and token counts when available. The account area shows plan and quota details when the client supplies them. If the selected remote agent is offline, out of quota, or returns an unusable estimate, the task stays **Unscheduled** with **Awaiting estimate** and the reason. Open the task and choose **Retry estimate** to request one new estimate from the currently selected agent. Dayline retries only when you ask. Older tasks estimated by a local fallback retain that history and can also be retried. An explicit duration in the task takes precedence. [Shared estimation instructions](src/agents/instructions.md)

### Put tasks on Google Calendar

1. In **Settings → Calendars**, choose **Sync tasks as calendar events**, then **Enable event syncing**. Reconnect the destination account if prompted, and approve event access in Google. Choose a writable **Calendar for new tasks** and save. Dayline always checks that calendar for conflicts.
2. The next successful sync can publish upcoming, unfinished tasks as events. Google receives their titles, times, category colors, and completion state. Tick a task in Dayline to mark its linked event with ✓. From Google Calendar, add ✓ to either end of an event title, or open **Mark complete** in the event description and confirm on the Mac running Dayline. Remove the title’s ✓ or uncheck the task to reopen it.
3. **Sync now** retries pending changes. Dayline checks the event version before updating or deleting it so it can reconcile edits made in Google Calendar. Confirming **Delete task** also removes its linked event while event syncing is enabled. To pause calendar writes, choose **Read calendars, keep tasks local** and confirm the change.

Closing the Mac window keeps Dayline listening for calendar changes. After quitting, reopen Dayline to catch up. The planner lives in `~/Library/Application Support/Dayline`. The desktop app protects Google credentials with macOS Keychain-backed encryption.

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

### Maintain the Antaia receiver

The Mac app uses the `dayline-calendar` Worker in Antaia’s Cloudflare account. Google delivers callbacks to its public HTTPS address. Each running Mac opens an authenticated outbound WebSocket. The Worker checks the Dayline client ID and the account’s verified Antaia Workspace membership before issuing separate, expiring receive and notification tickets. A Durable Object forwards signals to each connected Mac and can hibernate between messages.

For an update, run `npm ci`, sign in to Wrangler as an Antaia administrator, and run `npx wrangler@4.167.0 deploy --config relay/wrangler.jsonc`. Cloudflare holds the existing `RELAY_SECRET`. A new installation of the receiver needs a cryptographically random secret with at least 32 bytes and the public Dayline Desktop OAuth client ID. The Mac app reads `DAYLINE_PUSH_RELAY` as an optional HTTPS origin override. The browser-only development server enables the hosted receiver only when this variable is set. [Receiver health](https://dayline-calendar.antaia-space.workers.dev/health)

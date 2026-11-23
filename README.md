# Dayline

Dayline finds time for your to-do list. Write a task in plain English and it estimates the work, checks your selected Google calendars, and finds an opening within your working hours. The weekly board and day agenda show your tasks alongside your meetings. The Mac app and its local browser view share one planner.

![An example week in Dayline with nine tasks across five working days](docs/example-week.png)

## Using Dayline outside Antaia

Dayline was built for Antaia’s team. The code is public so others can run it, with these limits today.

| Part | Outside Antaia |
| --- | --- |
| Planner, task agents, Week and Day agenda | Work. Nothing to set up beyond the app. |
| Reading Google calendars | Works with your own Google OAuth client. Create a Google Cloud project, enable the Google Calendar API and create an OAuth client of type **Desktop app**, as described under [Google Calendar setup](#google-calendar-setup). Choose its JSON file in **Settings → Calendars**. |
| Google’s sign-in warning | A client that Google has not verified shows “Google hasn’t verified this app”. Choose **Advanced**, then continue. A client in **Testing** also ends each sign-in after seven days. |
| Live calendar updates | Antaia’s receiver accepts accounts in Antaia’s Google Workspace only. Without one, Dayline checks Google on a timer instead, so changes arrive a little later. |
| Booking links | Not available yet. The public booking page runs on Antaia’s receiver, which serves Antaia accounts only. Running your own receiver needs changes in `relay/receiver.mjs`, where the Workspace domain is fixed. |
| Opening the Mac app | The build is not notarized by Apple. macOS blocks it on first open: allow it under **System Settings → Privacy & Security**, or [run from source](#run-from-source). |

There is no licence file yet. Until one is added, all rights stay with Antaia: you may read the code, and you need Antaia’s permission to use or change it.

## Install on a Mac

1. Download the universal Mac ZIP for an Apple silicon or Intel Mac running macOS 13 or later. [Latest Mac release](https://github.com/antaia-space/dayline/releases/latest)
2. Unzip the download, drag **Dayline.app** to **Applications**, and open it. To use the same planner in your browser, choose **File → Open in Browser** in the Mac app. Both views follow your system’s light or dark appearance.

The internal build uses an ad hoc signature and has not been notarized by Apple. If macOS blocks it, allow it under **System Settings → Privacy & Security**, or run the app from source below. On an Antaia Mac, follow Antaia’s approved procedure.

## Connect your calendars

1. Open **Settings → Calendars**. If prompted, get Antaia’s Google Desktop OAuth client JSON from your Workspace administrator and select **Choose client file**. [Google Calendar setup for administrators](#google-calendar-setup)
2. Leave **Calendar access** on **Read calendars, keep tasks local**. Choose **Connect Google account** and approve the read-only permissions in your browser. For an account already connected for busy times, click **Show meeting details** beside its address and choose that account in Google. Each account needs its own approval.
3. **Check for conflicts on** starts with all available calendars selected, including shared calendars. Google’s generated Week Numbers feed has no bookable events and is omitted. Keep at least one availability calendar selected and choose **Save calendars**. In availability-only mode, you can uncheck any calendar, including your primary.
4. In **Settings → Working hours**, set your days, hours, and time zone. The default is Monday–Friday, 09:00–17:00, in the Mac’s time zone. Dayline shows times on a 24-hour clock. You can still write either “at 2 PM” or “at 14:00” when entering a task.

Calendar access is read-only by default. Task blocks, checkmarks, and deletions stay on your Mac. Google’s busy periods keep those times clear for meetings. If Google cannot confirm availability, upcoming tasks wait under **Unscheduled** until a refresh succeeds. Choose **Refresh availability** to retry. After an internal Mac update, macOS may ask for access to **Dayline Safe Storage** in Keychain. Allow that item in the system dialog and refresh. You can keep capturing and estimating tasks while calendar access is waiting.

Hover over a meeting’s **name** in either calendar view to preview its time, organizer and guest responses. Click or tap the name to keep the details open. From the keyboard, focus the name and press **Enter**. Choose **Join** to open the meeting directly. Google controls which details and guests you can see on shared calendars. Calendars shared as free/busy show anonymous busy blocks. Entries marked free can appear in the agenda while leaving that time available for tasks. Dayline keeps meeting details in memory on your Mac and sends only task information to the task agent. [Google Calendar permissions](https://developers.google.com/workspace/calendar/api/auth)

### Live meeting updates

With your Antaia Google account connected, the Mac app subscribes to changes on your selected calendars. When Google delivers a change, Dayline refreshes the meeting, frees its former slot and replans flexible tasks in every open planner window. An open meeting panel follows changes to the time, guest responses and joining details. **Settings → Calendars** shows how many calendars have live delivery.

Antaia hosts the notification receiver on Cloudflare. Dayline proves workspace membership with a Google ID token issued for the Dayline client. Google sends the receiver calendar channel headers. The receiver forwards an opaque change signal to your Mac. Meeting content, tasks and Google credentials that can read calendar data stay on your Mac or with Google. If you switch on booking links, the receiver also holds what [What leaves your Mac](#what-leaves-your-mac) lists. If a live channel disconnects, Dayline checks Google directly while reconnecting. Reopening the app or waking the Mac also catches up on changes. Google controls notification timing and can occasionally miss a notification. [Google Calendar push delivery](https://developers.google.com/workspace/calendar/api/guides/push)

### Google Calendar setup

A Workspace administrator sets this up once for Antaia. In an organization-owned Google Cloud project, enable the Google Calendar API. Configure the Google Auth Platform branding and choose the **Internal** audience. Create an OAuth client of type **Desktop app**, download its JSON, and distribute that file through Antaia’s internal channels. Each teammate authorizes their own account on their own Mac. [Enable the API](https://developers.google.com/workspace/guides/enable-apis) · [Configure the consent screen](https://developers.google.com/workspace/guides/configure-oauth-consent) · [Create desktop credentials](https://developers.google.com/workspace/guides/create-credentials#desktop-app)

An Internal client accepts accounts in the Google Workspace organization that owns it. To include a personal calendar, you can share its free/busy availability with your work account and select it in Dayline. Each additional sign-in must be eligible for the chosen OAuth client.

For an **External** client in **Testing**, open **Google Auth Platform → Audience → Test users → Add users**. Add the exact addresses you will connect, save, and start a fresh sign-in from Dayline for each one. Google expires the calendar authorization after seven days in this mode. [Google’s OAuth token guidance](https://developers.google.com/identity/protocols/oauth2#expiration)

To publish the external client, upload the 120 × 120 Dayline PNG under **Branding → App logo**, then select **Audience → Publish app**. After the client reaches **In production**, reconnect each account in Dayline to obtain a new calendar authorization. Google reviews external production branding before displaying the logo to everyone. [Dayline logo](docs/dayline-google-logo.png) · [Google’s branding guidance](https://support.google.com/cloud/answer/15549049?hl=en)

To distribute a build with the company’s Desktop client already configured, set the environment variable `DAYLINE_GOOGLE_CLIENT_FILE` to the JSON file’s local path when running the Mac packaging command. Each teammate still signs in to Google. Keep the downloaded file out of source control.

## Plan a task

- Press **Enter** to capture a task and keep typing. Dayline saves each entry on your Mac, then creates a short title and estimates the work in the background. Open the task to see your original wording or edit the title. Changing just the title uses no model quota.
- **“Draft a proposal by Friday”** lets Dayline estimate the duration and choose an opening before the deadline. **“Call Morgan for 20 minutes tomorrow afternoon”** sets the duration and narrows the search to tomorrow afternoon.
- **“Call the hotel tomorrow morning for 10 minutes, as early as possible”** puts the call first among flexible tasks in that morning’s plan. Dayline finds the first opening long enough, within working hours and around fixed appointments.
- **“Eat breakfast for 30 minutes at 10:15”** reserves 10:15–10:45 on the requested day. Two queued thirty-minute tasks can then start at 10:45 and 11:15, leaving fifteen minutes before a noon meeting. An overlapping meeting, an existing fixed task, or working hours can prevent an exact booking. The task shows the conflict in **Unscheduled**.
- In **Day agenda**, a task without a date in its text uses the day you are viewing. Choose a date in the entry field to pin the task to that day, or choose **Auto-schedule** to let Dayline find the next opening. Queued tasks keep their dates across reloads and restarts.
- When an unfinished task’s scheduled time has passed, select **Move to…** and choose a later day. The original day keeps a dashed **Moved** block with its start, end, and duration. Select the block to open the destination day. The task carries its checklist and duration with it. If that day has no opening, the link takes you to the task in **Unscheduled**.
- A task with several named items gets a checklist automatically. For example, **“Review access in Docs, Slack, and GitHub”** gets three checkboxes in one scheduled block. Use the pencil beside the task title to edit it. Under **Subtasks**, you can add your own steps, rename a step with its pencil, or remove one. On a task with an empty checklist, choose **Add subtask**. Check the last item to complete the task, or reopen an item to resume that work. Your checklist edits are saved on this Mac.
- Each task type has a consistent color. Select a task to see how its duration was estimated or edit its text, duration, type, or preferred day. If there is no opening long enough, the task appears under **Unscheduled**.
- You can start using the planner before connecting a calendar. It finds time within your work hours and around your other tasks. After you connect, it also checks for conflicts with meetings.

### Change a plan from the task field

Enter **“Move the budget review task to Wednesday”** to reschedule the existing task with its estimate and checklist. You can specify a clock time, move one task before or after another in the same day, resize or rename a task, mark it done, reopen it, or move an explicitly named group. For example, **“Give the budget review 10 more minutes”** adjusts the existing reservation. **“Move all unfinished tasks from Tuesday to Friday”** moves the eligible group.

Dayline resolves direct instructions locally. For indirect phrasing such as **“Wednesday would work better for the budget review”**, the selected subscription agent can interpret the sentence and its date/time context. Task matching and availability checks happen on your Mac. If two tasks match, their names and scheduling details appear under the entry field. Select the one you mean, edit the request, or explicitly choose **Add as new task**. You can keep entering other tasks while a choice is open.

For a planning question or a request with several parts, type it in your own words. For example, **“Break the budget review into three steps, give it ten more minutes and move it to Friday.”** The agent proposes specific changes to the existing task. Review the list and choose **Apply changes**. A question such as **“Which tasks on this day are short enough to do first?”** gets a written answer. Use **Quick entry → Ask planner** under the field to send any wording directly to your selected model. If you edit a task while its proposal is open, Dayline checks your current version before applying the changes.

The day you’re viewing helps identify the task, including when your wording uses a familiar abbreviation, a typo or a checklist item. When viewing tomorrow, **“Move the IC presentation prep to today”** moves the matching task to your actual local date. For an earlier unmatched request, choose **Try matching again**.

### Read the week

**Week** is a time grid. Hours run down the left edge and each day is a column. A task or meeting sits at its time and is as tall as it is long, so a free hour looks like a free hour. Meetings are grey. Tasks carry their category colour and a checkbox. Meetings that overlap share the column side by side. Time outside your working hours is tinted, and a red line marks the current time. All-day entries sit in a row above the grid. Tasks you finished early are listed under their day.

Select a task’s title to open it and change its text, duration, type or day. Select a day’s name to open **Day agenda**, where each task also shows its reorder grip, five-minute buttons and checklist. From the keyboard, Tab into a task block in **Week** to open those controls in place.

### Reorder the day

In **Day agenda**, drag the grip on the left edge of a flexible task to the top of its day, or drop it above or below another task. You can also click the grip and choose **Move to top**, **Move earlier** or **Move later**. With the grip focused, press **Home** to move to the top or use the up and down arrow keys to move one place. The same controls let you prioritize tasks in **Unscheduled**. The desktop and browser save one order. Working hours, time windows, fixed tasks and Google meetings determine where that order fits.

Dayline packs flexible work into the earliest available slots and replans when a meeting appears, moves or disappears. Already-queued work can start at the end of the preceding block when a refresh comes a few minutes later and that task would still be underway. A newly entered task starts from its capture time or later. Short blocks in the day agenda take less vertical space than long ones.

Overlapping meetings appear side by side in **Day agenda** and **Week**. Meetings with the same start line up. A later start appears lower in its column. Each meeting has its own details and join link when one is available.

In today’s plan, a red dot and line show the current time in your planner’s time zone. The line advances every minute through the scheduled block. An outline identifies the task currently underway.

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

## Booking links

Give people a link where they pick a time with you. The meeting lands in your Google Calendar with a Google Meet link, and Google sends the invitation. Your Google Calendar is the only store of bookings: a booking is a calendar event.

1. Connect your Google accounts under **Settings → Calendars**, your Antaia account among them. Then open the **Bookings** tab, beside **Week** and **Day agenda**. Under **Page settings**, enter the **Name guests see** and choose **Save page settings**.
2. The tab has one section for each connected Google address, each with its own meeting types. A meeting booked through a type lands in that address’s calendar, and Google invites the guest from that address. So you choose which address people book you with by choosing which link you send.
3. In the section of each address you want to be booked with, choose **Allow booked meetings** and approve event access in Google. This permission is separate from **Sync tasks as calendar events**: your tasks stay local unless you turn that on too. An address without it offers no times. If the address has several calendars, pick one under **Bookings go to**; otherwise its main calendar is used.
4. Switch on **Offer booking links**.
5. Each meeting type is a card with its own link. Choose **Copy link** on a card and send it. The link of your whole page, at the top, lists the types of every address that are not **Hidden**. Your page is at `https://dayline-calendar.antaia-space.workers.dev/` followed by the part of your Antaia address before the `@`.

Each card carries the actions for its meeting type:

| On the card | What it does |
| --- | --- |
| Calendar with a plus | **Book a meeting for someone.** Opens the type’s public page; pick the time and enter their name and email address. |
| Arrow | **Share.** Shows the link and a short text with a few of your next free times, ready to paste into an email. |
| **Copy link** | Copies the type’s link. |
| Square with an arrow | **Preview.** Opens the public page as a guest sees it. |
| Three dots | **Edit**, **Duplicate**, **Turn off** or **Turn on**, and **Delete**. A type that is off is not published; its link stops answering until you turn it on. |

These need **Offer booking links** switched on and a published page. Until then they are greyed out and say why.

Whichever address a guest books, every calendar you check for conflicts blocks time. A meeting booked with one address is busy time for the others.

Select a card to edit that meeting type in the panel on the right, or choose **New meeting type** in an address’s section. The panel holds the address it is booked with, the title, the link name, the length, how many days ahead it can be booked and with how much notice, how often a start time is offered, and the gap kept around your other meetings. Under **Weekly hours** a type follows your working hours, or keeps its own: choose **Custom hours for this type**, mark the days and set a start and an end for each. **Save changes** applies it at once. A **Hidden** type is left off your page; only people with its link can book it. **Notes may be copied to the company wiki** decides the first three characters of the event’s ID: `bkb` when on, `bkp` when off. The meeting-notes job in `antaia-brain` reads that prefix and never copies notes of `bkp` meetings.

Below the cards, **Upcoming booked meetings** lists who booked what, read from your Google Calendar.

### Which times are offered

Dayline offers start times inside your working hours, or inside a meeting type’s own weekly hours, on the calendars you check for conflicts. It reads those calendars as busy or free only. A private account you connected blocks time, and its events are never read for booking.

A task with an exact time in its text, such as “at 10:15”, blocks that time. Other tasks do not: a booking is a meeting, and Dayline replans flexible tasks around it. If a calendar cannot be read, your page offers no times until it can. Offering times blind could double-book you.

### What a guest sees

The guest picks a meeting type, a day and a time, and enters a name, an email address and optional notes.

- **Your Mac is awake and Dayline is running.** Dayline checks your calendar again and creates the event. Within seconds the page says **You are booked**, and Google emails the invitation with the Meet link.
- **Your Mac is asleep or Dayline is closed.** The page still shows your free times as of the last time Dayline published them. The guest’s time is held, so nobody else can take it, and the page says **Request received**: the Google Calendar invitation is the confirmation, and without one the meeting is not booked. When Dayline next runs, it checks your calendar and creates the event.

A request that waits lapses 30 minutes before its start, or after 72 hours. If your calendar took the time in the meantime, the request is declined. In both cases the guest’s link says so, and Dayline shows you who asked under the **Bookings** tab so you can write to them. Dayline does not send email itself. After 72 hours without contact from your Mac, the page stops offering times.

Every invitation and confirmation carries a **Reschedule or cancel** link. A change made there reaches your calendar the same way, and Google emails the update. If you move or delete a booked meeting in Google Calendar yourself, the guest’s link follows.

Two guests cannot take the same time. The receiver handles one request at a time and removes a requested time, plus its gap, for everyone. Dayline then reads your calendar once more before it writes.

### What leaves your Mac

Antaia’s receiver on Cloudflare serves the page. It stores the following, per person:

| Data | Fields | Kept until |
| --- | --- | --- |
| Page profile | The name guests see and the headline | Your next change. Deleted when you switch off **Offer booking links**, and after 30 days without contact from your Mac |
| Meeting types | Title, link name, description, length, gap, minimum notice, days ahead, hidden or not | Same |
| Free times | For each type, the start times that are free, and when they were published | Replaced whenever your availability changes and at least every 5 minutes while Dayline runs. Not offered after 72 hours |
| Waiting request | Request ID, meeting type, start, and the guest’s name, email address, time zone and notes | Deleted when your Mac has answered. If it never does, after 7 days |
| Booking record | Request ID, meeting type, start, end, status | The end of the meeting. A declined, cancelled or lapsed request: 7 days, so the guest’s link can explain |

These never leave your Mac: Google access and refresh tokens, the titles, descriptions and guests of any event, your tasks, calendar names and IDs, your busy times themselves, the `bkb`/`bkp` choice and the Meet link. Dayline composes the booked event on your Mac and sends it to Google only. The guest gets the Meet link in Google’s invitation.

The receiver does not store guests’ IP addresses and writes no logs. The live connection still carries only a signal that says “a request is waiting”; your Mac collects the request itself over HTTPS. Your Mac does not trust the receiver: it checks every request against your settings and your calendar, and it only creates, moves or deletes events that are bookings.

### Limits

- With an **External** Google client in **Testing**, Google ends Dayline’s access after seven days. The page then pauses and the **Bookings** tab asks you to reconnect.
- Offer booking links from one Mac. Two Macs signed in to the same Antaia account would publish the same page in turn.
- The page limits how many requests one address can send and holds at most ten unanswered requests. It has no CAPTCHA.

## Run from source

With Node.js 22.13 or later, run these commands on your Mac.

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
| `node scripts/booking-preview.mjs` | Preview the public booking page at `http://127.0.0.1:43129/demo`, without Cloudflare or Google. |

The app and **File → Open in Browser** share the desktop profile on loopback port 43127. The development server runs on `127.0.0.1:43128` and stores its separate profile in `~/Library/Application Support/Dayline Development`.

### Maintain the Antaia receiver

The Mac app uses the `dayline-calendar` Worker in Antaia’s Cloudflare account. Google delivers callbacks to its public HTTPS address. Each running Mac opens an authenticated outbound WebSocket. The Worker checks the Dayline client ID and the account’s verified Antaia Workspace membership before issuing separate, expiring receive and notification tickets. A Durable Object forwards signals to each connected Mac and can hibernate between messages. A second Durable Object per person holds their booking page; the page’s script and stylesheet are static assets in `relay/public`. The receiver names a booking page after the verified Antaia address of the Mac that publishes it, and signs the reschedule links with a key derived from `RELAY_SECRET`.

For an update, run `npm ci`, sign in to Wrangler as an Antaia administrator, and run `npx wrangler@4.167.0 deploy --config relay/wrangler.jsonc`. Cloudflare holds the existing `RELAY_SECRET`. A new installation of the receiver needs a cryptographically random secret with at least 32 bytes and the public Dayline Desktop OAuth client ID. The Mac app reads `DAYLINE_PUSH_RELAY` as an optional HTTPS origin override. The browser-only development server enables the hosted receiver only when this variable is set. [Receiver health](https://dayline-calendar.antaia-space.workers.dev/health)

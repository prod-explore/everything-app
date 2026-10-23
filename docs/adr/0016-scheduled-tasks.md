# ADR 0016 — Scheduled tasks: agents that run on a timetable

Status: accepted

## Context

Everything in the app assumed a person at the keyboard: a chat that never ends is the only way to have an agent "check this every day", and it burns context for nothing between the checks. What was wanted: *every morning look for new job offers*, *report a few stock prices at 17:00* — a prompt, a timetable, and the answer waiting in Gazeta.

## Decision

1. **A schedule is a saved prompt plus a timetable** (`schedules.ts`, tables `schedules` and `schedule_runs`, migration 2): name, prompt (≤ 8000 characters), a 5-field cron expression or `@hourly`/`@daily`/`@weekly`/`@monthly`, an IANA time zone, optionally a model and a project, and `allowPaid`. Cron is parsed by `croner`, in the schedule's own zone, so daylight-saving changes do what a person expects. At most 50 schedules, and no more often than every 15 minutes: every firing is a full agent turn.
2. **Every run is an ordinary chat** titled `⏰ <name> · <time>`, created fresh with the prompt as its first message. The result is therefore inspectable and can be continued by hand; nothing about a run lives in a private format. A run's history (100 kept per schedule) links to its chat.
3. **Nobody is watching, so nothing may wait for a person.** A turn started by a schedule is *unattended*: `WebApprovalGate.confirmDetailed` refuses at once — and says why, so the model does not retry — whatever is not already allowed by a standing grant (the user's earlier "Always") or by `policy.json`; a dangerous-looking call is always refused. `request_human_input` is forced non-blocking. The system prompt says all this and gives the step limit, and asks for one complete final answer, because that answer is the report.
4. **The result goes to Gazeta** as a `report` from the agent `schedule` (unless the agent posted its own report). A failure — no usable model, a refused paid model, a turn that errored — also lands there as "Scheduled task failed: <name>", so a daily job never goes quiet unnoticed.
5. **The cost guard applies.** With no model chosen, a run uses the *Agents* slot; unless the task says `allowPaid`, a model that is not tagged `free` is refused with a message that names the checkbox. There is no silent fallback to another model. A run is capped at `SCHEDULE_MAX_STEPS` model steps (default 25).
6. **The scheduler is conservative** (`scheduler.ts`). It looks at the clock every 30 s. A schedule's next time is moved forward *before* its run starts, so a crash or a slow run can never fire the same slot twice. A run still going when the next slot comes is skipped, not stacked, and the history says so. If the app was down, a slot missed by up to 2 h is run once, late; older ones are skipped with a reason. At most 2 scheduled runs go at once. Runs cut off by a shutdown are marked as interrupted at the next start. "Run now" starts a run without touching the timetable.
7. **The UI** is a *Scheduled tasks* window (sidebar): list with next run, last result, run now, pause, edit, delete with confirmation, per-task history that opens the run's chat, and a form with presets, a custom cron field and a live preview of the next five times from the server's own parser. It refreshes on the `schedule:changed` event and polls while open.
8. **Ghost projects cannot have schedules**: a ghost chat is promised never to leave the machine and is created by a person present.

## Consequences

- A scheduled task can do what the person already allowed in normal chats and nothing more; the first run is the moment to find out what is missing (the chat shows which call was refused), then answer "Always" to it once in a normal chat.
- Costs are bounded by the interval floor, the step limit and the free-model default, but a task that is allowed paid models and runs every 15 minutes still adds up; each run is a chat, so its usage shows up like any other chat's.
- Timetables are evaluated by the app, so nothing runs while it is down; a short outage is covered by the catch-up, a long one is reported as skipped.
- A local bridge, voice and the mobile assistant can reuse the same mechanism (a prompt run unattended with a result in Gazeta); none of them is part of this decision.

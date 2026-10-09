# crons

Routines for an agent. Each job runs at a wall-clock time in one timezone: every day, on some days of
the week, or once. The pack hands it to your `run` function and sends the result to the owner as a
notification. Jobs live in SQLite and the model edits them with the `cron_*` tools. Back to
[plugins](../../README.md).

## Mount

```ts
const crons = cron({
    tz: "America/New_York",
    jobs: [{ id: "morning-brief", title: "Morning brief", when: "08:00", instruction: "Write a three-line brief.",
             notify: true, enabled: true, catchUp: true }],
    run: (job, rt) => rt.ask(job.instruction).then((r) => r.text),
});
await runAgent({ packs: [crons] });
```

## Options

| Option | Meaning |
| --- | --- |
| `tz` | IANA zone, e.g. `"America/New_York"`. Omitted: host-local time. |
| `jobs` | `CronJob[]` that seed a fresh `crons.db` once. After that the database wins; delete it to seed again. |
| `run(job, rt)` | Runs one job, resolves with its result text. A rejection retries after 2, 15 and 60 minutes, the same day; one with `status: "denied"` settles the job for the day (a one-off for good). |

`CronJob`: `id` (slug), `title` (heads every notification), `when` (see below), `instruction`,
`notify` (send the result, or log it), `enabled`, `catchUp` (a run missed while the agent was
down runs when it starts again the same day). `job.instruction` reaches `run` behind a header line
with the schedule, the run time, the day and, on a retry, the attempt. A routine that calls
tools runs its own loop: `rt.ask` with `tools`, then `runToolCalls` from the sdk.

## Schedule

`when` is a 24-hour time in `tz`, in one of three forms; the store keeps it normalized.

| Form | Runs |
| --- | --- |
| `"08:00"` | every day |
| `"mon-fri 08:00"`, `"sat,sun 10:00"`, `"mon,wed,fri 07:30"` | on those days: three-letter English names, ranges and lists, any case |
| `"2026-10-10 15:00"` | once; then the job turns itself off and stays listed as ran, until it is re-timed |

A one-off set to a moment already past is refused, unless it is earlier today with `catchUp` on: then it
runs at once. Re-timing a one-off keeps it on or off, so one that has run needs `enabled: true` to run
again. With `catchUp` on, a missed run catches up the same day. A one-off missed while the agent was
offline, on an earlier day or with `catchUp` off, is turned off instead, and the owner gets a notice; one
that fell due while the agent was up runs late, even past midnight. The check reads the wall clock in
`tz`, so DST never moves a run: a time the clock skips runs as it jumps past, and a time it repeats runs
once.

## Tools

| Tool | Does |
| --- | --- |
| `cron_look` | Lists the jobs: on or off, `when` as stored, id, title, and the next run (a one-off that ran says `ran`). |
| `cron_add` | Adds a job: `title`, `when`, `instruction` required; `id` from the title when omitted; `notify` defaults to false. Answers with the next run. |
| `cron_edit` | Changes the fields passed for one `id`; the rest stay as they are. Answers with the next run. |
| `cron_remove` | Deletes a job. |
| `cron_run_now` | Runs a job now in the background; its result always reaches the owner. |

`cron_add`, `cron_edit`, `cron_remove` and `cron_run_now` wait for the owner's approval unless listed in
`runAgent({ unasked })`. Text in the system prompt section `pack:crons` tells the model to confirm before
it changes the schedule.

## Data and scheduler

`data/packs/crons/crons.db`: SQLite in WAL mode, tables `jobs` and `runs` (last settled day per job;
for a one-off, the moment of its own run).
The scheduler starts when the agent first connects to the gateway, checks at once and then every 60
seconds, and runs due jobs one at a time while the agent is connected. Until it starts, and when `tz`
is not a valid zone, every tool answers `Error: scheduler not started yet.`

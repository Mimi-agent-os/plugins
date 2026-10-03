# crons

Daily routines for an agent. Each job runs once a day at a wall-clock `HH:MM` in one timezone: the
pack hands it to your `run` function and sends the result to the owner as a notification. Jobs live
in SQLite and the model edits them with the `cron_*` tools. Back to [plugins](../../README.md).

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
| `run(job, rt)` | Runs one job, resolves with its result text. A rejection retries after 2, 15 and 60 minutes, the same day; one with `status: "denied"` settles the job for the day. |

`CronJob`: `id` (slug), `title` (heads every notification), `when` (`"HH:MM"`, 24-hour), `instruction`,
`notify` (send the result, or log it), `enabled`, `catchUp` (a run missed while the agent was
down runs when it starts again the same day). `job.instruction` reaches `run` behind a header line
with the scheduled time, the run time, the day and, on a retry, the attempt. A routine that calls
tools runs its own loop: `rt.ask` with `tools`, then `runToolCalls` from the sdk.

## Tools

| Tool | Does |
| --- | --- |
| `cron_look` | Lists the jobs. |
| `cron_add` | Adds a job: `title`, `when`, `instruction` required; `id` from the title when omitted; `notify` defaults to false. |
| `cron_edit` | Changes the fields passed for one `id`; the rest stay as they are. |
| `cron_remove` | Deletes a job. |
| `cron_run_now` | Runs a job now in the background; its result always reaches the owner. |

`cron_add`, `cron_edit`, `cron_remove` and `cron_run_now` wait for the owner's approval unless listed in
`runAgent({ unasked })`. Text in the system prompt section `pack:crons` tells the model to confirm before
it changes the schedule.

## Data and schedule

`data/packs/crons/crons.db`: SQLite in WAL mode, tables `jobs` and `runs` (last settled day per job).
The scheduler starts when the agent first connects to the gateway, checks at once and then every 60
seconds, and runs due jobs one at a time while the agent is connected. Until it starts, and when `tz`
is not a valid zone, every tool answers `Error: scheduler not started yet.`

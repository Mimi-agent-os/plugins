/** The crons pack: mimi's schedule as a code-first pack. The engine (core.ts) and the sqlite store
 *  (store.ts) are pure and sdk-free; only this file pulls @mimi-os/sdk in as a value to build the tools
 *  and the PackDef. The tools and start() share one engine created lazily in start() and held in a ref:
 *  a tool that runs before start(), or after a start() that failed, returns a clear error, never crashes. */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { definePack, defineTool } from "@mimi-os/sdk";
import type { PackDef, PackRuntime } from "@mimi-os/sdk";

import { createCrons } from "./core.ts";
import type { Crons } from "./core.ts";
import type { CronJob } from "./store.ts";
import { SqliteCronStore } from "./store.ts";

export type { CronJob } from "./store.ts";

const SKILL = `# Your schedule (crons)

You run on a schedule you can see and change. Each routine is a cron: a daily wall-clock time and a
plain instruction you carry out when it fires.

- \`cron_look\` — see every routine: its id, time, on/off, whether it notifies, and its title.
- \`cron_add\` / \`cron_edit\` / \`cron_remove\` — shape the schedule.
- \`cron_run_now\` — start one now, ignoring its time (useful to test a routine or re-run a failed one;
  a successful re-run of one that failed today counts as today's run); its result arrives in the owner's Inbox.

Each field:
- **when** — 24h \`"HH:MM"\`, fired once a day at that time in the owner's timezone.
- **notify** — true pushes the result to the owner's Inbox; false only logs it. A failed routine
  retries a few times that day with growing pauses, and the owner hears of its first failure and of
  giving up either way.
- **catchUp** — if the process was down when a routine's time passed, true makes it up on the next
  start; false skips it until the next day.
- **enabled** — false pauses a routine without deleting it.

Changing the schedule is a real change to how you act every day, so confirm the owner's intent before
you add, edit, or remove a routine — do not reshape it on a vague hint. Routines only fire while the
process is alive; a routine you add, re-time or re-enable takes effect from the next time its clock
comes round.`;

type Args = Record<string, unknown>;
const str = (a: Args, k: string): string | undefined => (typeof a[k] === "string" ? (a[k] as string) : undefined);
const bool = (a: Args, k: string): boolean | undefined => (typeof a[k] === "boolean" ? (a[k] as boolean) : undefined);
const NOT_STARTED = "Error: scheduler not started yet.";

export function cronsPack(opts: {
    tz?: string | undefined;
    /** Seed a fresh crons database once; afterwards the database (the owner's and the model's edits) wins. */
    jobs?: CronJob[] | undefined;
    run: (job: CronJob, rt: PackRuntime) => Promise<string>;
}): PackDef {
    let engine: Crons | null = null;

    const tools = [
        defineTool(
            "cron_look",
            "List the scheduled routines (crons): each one's id, time, on/off, whether it notifies, and its title.",
            { type: "object", properties: {} },
            () => {
                if (!engine) return NOT_STARTED;
                const jobs = engine.list();
                if (jobs.length === 0) return "No cron jobs.";
                return jobs
                    .map((j) => `${j.enabled ? "on " : "off"} ${j.when} ${j.id} — ${j.title}${j.notify ? " (notifies)" : ""}`)
                    .join("\n");
            },
        ),
        defineTool(
            "cron_add",
            "Add a scheduled routine. `when` is 24h \"HH:MM\", fired daily in the agent's timezone; `instruction` is " +
                "the plain-language task the routine runs. Confirm intent with the owner first — this changes the schedule.",
            {
                type: "object",
                properties: {
                    id: { type: "string", description: "optional short slug; derived from the title if omitted" },
                    title: { type: "string" },
                    when: { type: "string", description: '24h "HH:MM"' },
                    instruction: { type: "string" },
                    notify: { type: "boolean", description: "push the result to the owner (default false — result is only logged)" },
                    enabled: { type: "boolean", description: "default true" },
                    catchUp: { type: "boolean", description: "make up a run missed while the process was down (default true)" },
                },
                required: ["title", "when", "instruction"],
            },
            (a) => {
                if (!engine) return NOT_STARTED;
                const title = str(a, "title");
                const when = str(a, "when");
                const instruction = str(a, "instruction");
                if (!title || !when || !instruction) return "Error: title, when and instruction are required.";
                const id = str(a, "id") ?? title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
                try {
                    const job = engine.add({
                        id,
                        title,
                        when,
                        instruction,
                        notify: bool(a, "notify") ?? false,
                        enabled: bool(a, "enabled") ?? true,
                        catchUp: bool(a, "catchUp") ?? true,
                    });
                    return `Added "${job.id}" at ${job.when}${job.enabled ? "" : " (disabled)"}.`;
                } catch (e) {
                    return `Error: ${(e as Error).message}`;
                }
            },
            { writes: true },
        ),
        defineTool(
            "cron_edit",
            "Change fields of an existing routine — pass its id and only the fields to change. Confirm intent with the owner.",
            {
                type: "object",
                properties: {
                    id: { type: "string" },
                    title: { type: "string" },
                    when: { type: "string", description: '24h "HH:MM"' },
                    instruction: { type: "string" },
                    notify: { type: "boolean" },
                    enabled: { type: "boolean", description: "false pauses the routine without deleting it" },
                    catchUp: { type: "boolean" },
                },
                required: ["id"],
            },
            (a) => {
                if (!engine) return NOT_STARTED;
                const id = str(a, "id");
                if (!id) return "Error: id is required.";
                const patch: Partial<CronJob> = {};
                const title = str(a, "title");
                if (title !== undefined) patch.title = title;
                const when = str(a, "when");
                if (when !== undefined) patch.when = when;
                const instruction = str(a, "instruction");
                if (instruction !== undefined) patch.instruction = instruction;
                const notify = bool(a, "notify");
                if (notify !== undefined) patch.notify = notify;
                const enabled = bool(a, "enabled");
                if (enabled !== undefined) patch.enabled = enabled;
                const catchUp = bool(a, "catchUp");
                if (catchUp !== undefined) patch.catchUp = catchUp;
                if (Object.keys(patch).length === 0) return "Error: nothing to change — pass a field to edit.";
                try {
                    const job = engine.edit(id, patch);
                    return job ? `Updated "${job.id}".` : `Error: no cron job "${id}".`;
                } catch (e) {
                    return `Error: ${(e as Error).message}`;
                }
            },
            { writes: true },
        ),
        defineTool(
            "cron_remove",
            "Delete a scheduled routine by id. Confirm intent with the owner.",
            { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
            (a) => {
                if (!engine) return NOT_STARTED;
                const id = str(a, "id");
                if (!id) return "Error: id is required.";
                return engine.remove(id) ? `Removed "${id}".` : `Error: no cron job "${id}".`;
            },
            { writes: true },
        ),
        defineTool(
            "cron_run_now",
            "Start a routine now in the background, ignoring its schedule; its result or failure arrives in the owner's Inbox. " +
                "A success settles a run that failed today and waits to retry; otherwise the daily schedule is untouched.",
            { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
            (a) => {
                if (!engine) return NOT_STARTED;
                const id = str(a, "id");
                if (!id) return "Error: id is required.";
                try {
                    return engine.runNow(id);
                } catch (e) {
                    return `Error: ${(e as Error).message}`;
                }
            },
            { writes: true },
        ),
    ];

    return definePack({
        name: "crons",
        toolPrefix: "cron",
        tools,
        skill: SKILL,
        start(rt: PackRuntime): () => void {
            mkdirSync(rt.dataDir, { recursive: true }); // PackRuntime does not create dataDir for us
            const s = new SqliteCronStore(join(rt.dataDir, "crons.db"));
            try {
                const crons = createCrons({
                    store: s,
                    tz: opts.tz,
                    fire: (job) => opts.run(job, rt),
                    notify: (job, result) => rt.notify({ title: job.title, body: result }),
                    connected: () => rt.connected(),
                    log: (m) => rt.log(m),
                });
                crons.seed(opts.jobs ?? []);
                const stopTimer = crons.start();
                engine = crons; // published last: a start that throws leaves the tools on NOT_STARTED
                return () => {
                    stopTimer();
                    s.close();
                    engine = null;
                };
            } catch (e) {
                s.close();
                throw e;
            }
        },
    });
}

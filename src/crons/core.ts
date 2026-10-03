/** The deterministic half of the crons pack: a once-a-minute check that fires due jobs THROUGH an
 *  injected `fire` (the host's routine runner), gated once-per-day, timezone-aware, with boot catch-up.
 *  No LLM, no agent coupling, no I/O of its own — the store and the fire/notify sinks are all passed in.
 *  Jobs run serially so an earlier one finishes before a later; a failed job retries with growing
 *  pauses up to a daily cap, and its day is stamped once it succeeds or gives up. */

import type { CronJob, CronStore } from "./store.ts";

export type { CronJob, CronStore } from "./store.ts";

export interface CronsOptions {
    store: CronStore;
    /** IANA zone (e.g. "America/New_York") for the wall clock; omitted = host-local time. A bad zone throws here. */
    tz?: string | undefined;
    /** Runs the job and resolves with the result text. `job.instruction` arrives prefixed with the run's
     *  clock and, on a retry, its attempt number; a rejection whose `status` is "denied" is not retried that day. */
    fire: (job: CronJob) => Promise<string>;
    /** Deliver a run's result (or a failure notice) to the owner. */
    notify: (job: CronJob, result: string) => void;
    /** False while the agent's gateway session is down; ticks (and the boot catch-up) wait for it. */
    connected: () => boolean;
    /** Test seam: current epoch ms; defaults to Date.now. */
    now?: (() => number) | undefined;
    log: (m: string) => void;
}

export interface Crons {
    /** Start the minute timer and run one immediate catch-up tick; returns a stop fn that clears it. */
    start(): () => void;
    list(): CronJob[];
    add(job: CronJob): CronJob;
    edit(id: string, patch: Partial<CronJob>): CronJob | null;
    remove(id: string): boolean;
    /** Add `jobs` once per database, the first time it is opened. */
    seed(jobs: CronJob[]): void;
    /** Start a job in the background regardless of schedule or enabled state; its result or failure
     *  always reaches the owner. A success stamps the day only when it settles a scheduled run that
     *  failed today and still waits to retry. */
    runNow(id: string): string;
    /** One scheduling check — what the timer calls. Exposed so a host can force it and tests can drive it. */
    tick(): Promise<void>;
}

// minutes to wait before attempts 2, 3 and 4; the fourth failure gives the day up
const RETRY_MINUTES = [2, 15, 60];
const MAX_ATTEMPTS = RETRY_MINUTES.length + 1;

export function createCrons(opts: CronsOptions): Crons {
    const { store, fire, notify, connected, log } = opts;
    const now = opts.now ?? Date.now;
    const fmt = new Intl.DateTimeFormat("en-CA", {
        timeZone: opts.tz,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    });
    const zone = opts.tz ?? (fmt.resolvedOptions().timeZone || "host-local time");

    const clock = (at = now()): { day: string; time: string; minutes: number } => {
        const parts = fmt.formatToParts(at);
        const get = (type: string): string => parts.find((x) => x.type === type)?.value ?? "";
        const day = `${get("year")}-${get("month")}-${get("day")}`;
        return { day, time: `${get("hour")}:${get("minute")}`, minutes: (Number(get("hour")) % 24) * 60 + Number(get("minute")) };
    };

    const retries = new Map<string, { day: string; attempts: number; nextAt: number }>();
    // today's holds with the mark each overwrote, to release a job moved ahead again; a real run's stamp drops it; lost on restart
    const held = new Map<string, { day: string; prev: string | null }>();
    const skipped = new Set<string>(); // catchUp:false jobs missed at boot — held out until tomorrow
    const inFlight = new Set<string>(); // shared by the schedule and runNow, so one job never runs twice at once
    let stopped = false;

    // a job put at a time already gone today waits for tomorrow; one put ahead again runs at its new time
    const holdIfPassed = (job: CronJob): void => {
        const { day, minutes } = clock();
        const hold = held.get(job.id);
        if (Number(job.when.slice(0, 2)) * 60 + Number(job.when.slice(3)) < minutes) {
            if (hold?.day !== day) held.set(job.id, { day, prev: store.lastRun(job.id) });
            store.setLastRun(job.id, day);
            return;
        }
        skipped.delete(job.id);
        if (hold?.day !== day) return;
        held.delete(job.id);
        store.setLastRun(job.id, hold.prev);
    };

    const runScheduled = async (job: CronJob, day: string): Promise<void> => {
        const prior = retries.get(job.id);
        const attempt = prior?.day === day ? prior.attempts + 1 : 1;
        const { day: today, time } = clock();
        let header = `Scheduled ${job.when}, running at ${time} ${zone}, today is ${today}.`;
        if (attempt > 1)
            header += ` This is attempt ${attempt} of ${MAX_ATTEMPTS}: an earlier run today failed, possibly partway — check what it already changed before writing anything again.`;
        inFlight.add(job.id);
        try {
            const result = await fire({ ...job, instruction: `${header}\n\n${job.instruction}` });
            if (stopped) return; // the store is closed once the pack stops
            retries.delete(job.id);
            held.delete(job.id);
            store.setLastRun(job.id, day);
            if (job.notify) notify(job, result);
            else log(`${job.id}: ${result}\n`);
        } catch (e) {
            const msg = (e as Error).message;
            log(`${job.id} failed on attempt ${attempt} — ${msg}\n`);
            if (stopped) return;
            const pause = RETRY_MINUTES[attempt - 1]; // undefined once every attempt is spent
            const nextAt = pause === undefined ? null : now() + pause * 60_000;
            // a retry that would land tomorrow is dropped there, so it gives the day up here instead
            if ((e as { status?: unknown }).status === "denied" || nextAt === null || clock(nextAt).day !== day) {
                retries.delete(job.id);
                held.delete(job.id);
                store.setLastRun(job.id, day);
                notify(job, `This routine failed on attempt ${attempt} and will not run again today: ${msg}`);
                return;
            }
            retries.set(job.id, { day, attempts: attempt, nextAt });
            if (attempt === 1) notify(job, `This routine failed and will retry later today: ${msg}`);
        } finally {
            inFlight.delete(job.id);
        }
    };

    let ticking = false;
    let booted = false; // set once a connected pass has checked every job; a pass the link cut short is still the boot pass
    let skipDay = "";

    const tick = async (): Promise<void> => {
        if (ticking || stopped || !connected()) return; // never overlap a long routine; boot waits for a connection
        ticking = true;
        try {
            const { day, minutes } = clock();
            if (day !== skipDay) {
                skipped.clear();
                skipDay = day;
            }
            // store.list() is ordered by `when`, so an earlier job finishes before a later one starts
            for (const job of store.list()) {
                if (stopped || !connected()) return; // the link can drop while an earlier job runs
                if (!job.enabled || skipped.has(job.id) || inFlight.has(job.id) || store.lastRun(job.id) === day) continue;
                const retry = retries.get(job.id);
                if (retry?.day === day && now() < retry.nextAt) continue;
                if (minutes < Number(job.when.slice(0, 2)) * 60 + Number(job.when.slice(3))) continue;
                if (!booted && !job.catchUp) {
                    skipped.add(job.id); // its time passed while the process was down and it opted out of catch-up
                    continue;
                }
                await runScheduled(job, day);
            }
            booted = true;
        } catch (e) {
            log(`crons: tick failed — ${(e as Error).message}\n`);
        } finally {
            ticking = false;
        }
    };

    return {
        start(): () => void {
            const timer = setInterval(() => void tick(), 60_000);
            void tick(); // catch up immediately on boot
            return () => {
                stopped = true;
                clearInterval(timer);
            };
        },
        list: () => store.list(),
        add: (job) => {
            const added = store.add(job);
            holdIfPassed(added);
            return added;
        },
        edit: (id, patch) => {
            const next = store.update(id, patch);
            if (next && (patch.when !== undefined || patch.enabled !== undefined)) holdIfPassed(next);
            return next;
        },
        remove: (id) => {
            retries.delete(id);
            held.delete(id);
            return store.remove(id);
        },
        seed: (jobs) => {
            if (store.seedIfFresh(jobs)) for (const job of jobs) holdIfPassed(job);
        },
        runNow: (id) => {
            const job = store.get(id);
            if (!job) throw new Error(`no cron job "${id}".`);
            if (inFlight.has(id)) return `"${id}" is already running — its result will arrive in your Inbox.`;
            const { day, time } = clock();
            inFlight.add(id);
            void fire({ ...job, instruction: `Run now on the owner's request at ${time} ${zone}, today is ${day}.\n\n${job.instruction}` })
                .then(
                    (result) => {
                        // a manual success settles a scheduled run that failed today, so its retry does not run it again
                        if (!stopped && retries.get(id)?.day === day) {
                            retries.delete(id);
                            held.delete(id);
                            store.setLastRun(id, day);
                        }
                        notify(job, result);
                    },
                    (e: unknown) => notify(job, `This routine failed: ${(e as Error).message}`),
                )
                .catch((e: unknown) => log(`${id}: result not delivered — ${(e as Error).message}\n`))
                .finally(() => inFlight.delete(id));
            return `Started "${id}" — the result will arrive in your Inbox.`;
        },
        tick,
    };
}

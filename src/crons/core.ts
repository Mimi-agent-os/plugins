/** The deterministic half of the crons pack: a once-a-minute check that fires due jobs THROUGH an
 *  injected `fire` (the host's routine runner), timezone-aware, with boot catch-up. A daily or weekday
 *  job runs at most once a day; a one-off runs once and then turns itself off.
 *  No LLM, no agent coupling, no I/O of its own — the store and the fire/notify sinks are all passed in.
 *  Jobs run serially so an earlier one finishes before a later; a failed job retries with growing
 *  pauses up to a daily cap, and its day (a one-off's moment) is stamped once it succeeds or gives up. */

import { firesOn, nextRun, parseWhen } from "./schedule.ts";
import type { CronJob, CronStore } from "./store.ts";

export type { CronJob, CronStore } from "./store.ts";

export interface ListedJob extends CronJob {
    /** Local "YYYY-MM-DD HH:MM" of the next scheduled run; null while the job is off. */
    next: string | null;
    /** A one-off that has had its run at its stored moment, whatever the outcome; re-timing it clears this. */
    ran: boolean;
}

export interface CronsOptions {
    store: CronStore;
    /** IANA zone (e.g. "America/New_York") for the wall clock; omitted = host-local time. A bad zone throws here. */
    tz?: string | undefined;
    /** Runs the job and resolves with the result text. `job.instruction` arrives prefixed with the run's
     *  clock and, on a retry, its attempt number; a rejection whose `status` is "denied" is not retried that day. */
    fire: (job: CronJob) => Promise<string>;
    /** Deliver a run's result (or a failure or missed one-off notice) to the owner. */
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
    list(): ListedJob[];
    /** Adding or editing a one-off to a moment already past throws, unless it is earlier today and
     *  catchUp runs it at once. */
    add(job: CronJob): ListedJob;
    edit(id: string, patch: Partial<CronJob>): ListedJob | null;
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

    // a repeating job put at a time already gone today waits for its next day; one put ahead again runs at its new time
    const holdIfPassed = (job: CronJob): void => {
        const s = parseWhen(job.when);
        const { day, minutes } = clock();
        const hold = held.get(job.id);
        if (s.kind !== "once" && firesOn(s, day) && s.minutes < minutes) {
            if (hold?.day !== day) held.set(job.id, { day, prev: store.lastRun(job.id) });
            store.setLastRun(job.id, day);
            return;
        }
        skipped.delete(job.id);
        if (hold?.day !== day) return;
        held.delete(job.id);
        store.setLastRun(job.id, hold.prev);
    };

    // an add or edit that arms a one-off needs its moment ahead, or earlier today with catchUp on to run it at once
    const assertAhead = (job: CronJob, was: CronJob | null): void => {
        const s = parseWhen(job.when);
        if (s.kind !== "once" || !job.enabled || (was?.enabled && was.when === s.when)) return;
        const { day, time, minutes } = clock();
        if (s.date > day || (s.date === day && (s.minutes >= minutes || job.catchUp))) return;
        throw new Error(
            `"${s.when}" has already passed (now ${day} ${time} ${zone}) — a one-off needs a moment ahead; ` +
                "one earlier today is accepted with catchUp on and runs at once.",
        );
    };

    const listed = (job: CronJob): ListedJob => {
        const s = parseWhen(job.when);
        const { day } = clock();
        const mark = store.lastRun(job.id);
        return {
            ...job,
            next: job.enabled ? nextRun(s, day, mark === day || skipped.has(job.id)) : null,
            ran: s.kind === "once" && mark === s.when,
        };
    };

    // a run settled: a one-off is stamped with its moment and turns off, unless the owner re-timed it while it ran
    const settle = (job: CronJob, day: string): void => {
        const once = parseWhen(job.when).kind === "once";
        retries.delete(job.id);
        held.delete(job.id);
        store.setLastRun(job.id, once ? job.when : day);
        if (once && store.get(job.id)?.when === job.when) store.update(job.id, { enabled: false });
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
            settle(job, day);
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
                settle(job, day);
                const again = parseWhen(job.when).kind === "once" ? "" : " today";
                notify(job, `This routine failed on attempt ${attempt} and will not run again${again}: ${msg}`);
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
    let liveSince = ""; // day of the pass that began this connected stretch: a one-off due since then runs late, not missed

    const tick = async (): Promise<void> => {
        if (ticking || stopped) return; // never overlap a long routine
        if (!connected()) {
            liveSince = ""; // boot waits for a connection, and what falls due meanwhile was missed offline
            return;
        }
        ticking = true;
        try {
            const { day, minutes } = clock();
            if (day !== skipDay) {
                skipped.clear();
                skipDay = day;
            }
            liveSince ||= day;
            // store.list() is ordered by time of day, so an earlier job finishes before a later one starts
            for (const job of store.list()) {
                if (stopped || !connected()) return; // the link can drop while an earlier job runs
                if (!job.enabled || skipped.has(job.id) || inFlight.has(job.id)) continue;
                const retry = retries.get(job.id);
                if (retry?.day === day && now() < retry.nextAt) continue;
                const s = parseWhen(job.when);
                if (s.kind === "once") {
                    // a one-off is gated by its on/off switch, which its run turns off
                    if (s.date > day || (s.date === day && minutes < s.minutes)) continue;
                    if (s.date < liveSince || (!booted && !job.catchUp)) {
                        // it fell due, or was due to retry, while the agent was down and can no longer catch up: reported, never dropped
                        if (retry?.day === s.date) {
                            settle(job, s.date);
                            notify(
                                job,
                                `This routine failed on attempt ${retry.attempts} and will not run again: the agent was offline when it was due to retry.`,
                            );
                        } else {
                            store.update(job.id, { enabled: false });
                            notify(job, `This one-off was due at ${s.when} ${zone} and was missed while the agent was offline. It is now off.`);
                        }
                        continue;
                    }
                } else {
                    if (store.lastRun(job.id) === day || !firesOn(s, day) || minutes < s.minutes) continue;
                    if (!booted && !job.catchUp) {
                        skipped.add(job.id); // its time passed while the process was down and it opted out of catch-up
                        continue;
                    }
                }
                await runScheduled(job, s.kind === "once" ? s.date : day); // a one-off's attempts belong to its own date
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
        list: () => store.list().map(listed),
        add: (job) => {
            assertAhead(job, null);
            const added = store.add(job);
            holdIfPassed(added);
            return listed(added);
        },
        edit: (id, patch) => {
            const was = store.get(id);
            if (!was) return null;
            assertAhead({ ...was, ...patch }, was);
            const next = store.update(id, patch);
            if (!next) return null;
            if (patch.when !== undefined || patch.enabled !== undefined) holdIfPassed(next);
            return listed(next);
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
                        if (!stopped && retries.get(id)?.day === day) settle(job, day);
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

import { test } from "node:test";
import assert from "node:assert/strict";

import { SqliteCronStore } from "./store.ts";
import type { CronJob } from "./store.ts";
import { createCrons } from "./core.ts";
import type { Crons } from "./core.ts";

const at = (h: number, m: number): number => Date.UTC(2026, 0, 15, h, m); // fixed day, so tz "UTC" is deterministic
const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

const job = (over: Partial<CronJob> = {}): CronJob => ({
    id: "brief",
    title: "Morning brief",
    when: "08:00",
    instruction: "write the brief",
    notify: false,
    enabled: true,
    catchUp: true,
    ...over,
});

interface Harness {
    crons: Crons;
    store: SqliteCronStore;
    fired: string[];
    prompts: string[];
    notified: string[];
    logs: string[];
    setNow: (ms: number) => void;
    failNext: (n: number, error?: Error) => void;
    setConnected: (up: boolean) => void;
    /** Hold every fire from now until the returned release is called. */
    hold: () => () => void;
}
function harness(tz: string | undefined, seed: CronJob[]): Harness {
    const store = new SqliteCronStore(":memory:");
    for (const j of seed) store.add(j);
    const fired: string[] = [];
    const prompts: string[] = [];
    const notified: string[] = [];
    const logs: string[] = [];
    let nowMs = 0;
    let fails = 0;
    let failure = new Error("boom");
    let up = true;
    let gate: Promise<void> = Promise.resolve();
    const crons = createCrons({
        store,
        tz,
        now: () => nowMs,
        connected: () => up,
        fire: async (j) => {
            fired.push(j.id);
            prompts.push(j.instruction);
            if (!up) throw new Error("not connected to the gateway"); // what the sdk client's ask does
            await gate;
            if (fails > 0) {
                fails--;
                throw failure;
            }
            return `${j.id} done`;
        },
        notify: (j, result) => notified.push(`${j.id}:${result}`),
        log: (m) => logs.push(m),
    });
    return {
        crons,
        store,
        fired,
        prompts,
        notified,
        logs,
        setNow: (ms) => (nowMs = ms),
        failNext: (n, error = new Error("boom")) => {
            fails = n;
            failure = error;
        },
        setConnected: (u) => (up = u),
        hold: () => {
            let release = (): void => {};
            gate = new Promise((r) => (release = r));
            return () => release();
        },
    };
}

test("a job fires once its minute passes, and not again the same day", async () => {
    const h = harness("UTC", [job()]);
    h.setNow(at(7, 59));
    await h.crons.tick();
    assert.deepEqual(h.fired, []); // before its time

    h.setNow(at(8, 0));
    await h.crons.tick();
    assert.deepEqual(h.fired, ["brief"]); // fires as the minute arrives

    h.setNow(at(8, 1));
    await h.crons.tick();
    assert.deepEqual(h.fired, ["brief"]); // gated for the rest of the day
    h.store.close();
});

test("each run is told its scheduled time, the real clock and today's date", async () => {
    const h = harness("UTC", [job()]);
    h.setNow(at(8, 3)); // a late (caught-up) run
    await h.crons.tick();
    assert.equal(h.prompts[0], "Scheduled 08:00, running at 08:03 UTC, today is 2026-01-15.\n\nwrite the brief");
    h.store.close();

    const ny = harness("America/New_York", [job()]);
    ny.setNow(Date.UTC(2026, 0, 16, 4, 30)); // 23:30 on the 15th in New York
    await ny.crons.tick();
    assert.match(ny.prompts[0] ?? "", /^Scheduled 08:00, running at 23:30 America\/New_York, today is 2026-01-15\./);
    ny.store.close();
});

test("a failing job backs off, tells the owner once, and gives the day up at the cap", async () => {
    const h = harness("UTC", [job()]);
    h.failNext(4);
    h.setNow(at(8, 0));
    await h.crons.tick(); // attempt 1 fails
    assert.equal(h.fired.length, 1);
    assert.equal(h.store.lastRun("brief"), null);
    assert.deepEqual(h.notified, ["brief:This routine failed and will retry later today: boom"]);

    h.setNow(at(8, 1));
    await h.crons.tick(); // still backing off
    assert.equal(h.fired.length, 1);

    h.setNow(at(8, 2));
    await h.crons.tick(); // attempt 2 fails quietly
    assert.equal(h.fired.length, 2);
    assert.match(h.prompts[1] ?? "", /attempt 2 of 4: an earlier run today failed, possibly partway/);
    assert.equal(h.notified.length, 1);

    h.setNow(at(8, 16));
    await h.crons.tick();
    assert.equal(h.fired.length, 2);
    h.setNow(at(8, 17));
    await h.crons.tick(); // attempt 3
    assert.equal(h.fired.length, 3);

    h.setNow(at(9, 16));
    await h.crons.tick();
    assert.equal(h.fired.length, 3);
    h.setNow(at(9, 17));
    await h.crons.tick(); // attempt 4 — the cap
    assert.equal(h.fired.length, 4);
    assert.equal(h.notified.length, 2);
    assert.match(h.notified[1] ?? "", /failed on attempt 4 and will not run again today: boom/);
    assert.equal(h.store.lastRun("brief"), "2026-01-15");

    h.setNow(at(12, 0));
    await h.crons.tick(); // given up for the day
    assert.equal(h.fired.length, 4);

    h.setNow(Date.UTC(2026, 0, 16, 8, 0));
    await h.crons.tick(); // a new day starts from attempt 1
    assert.equal(h.fired.length, 5);
    assert.doesNotMatch(h.prompts[4] ?? "", /attempt/);
    h.store.close();
});

test("a retry that succeeds is stamped and delivers its result", async () => {
    const h = harness("UTC", [job({ notify: true })]);
    h.failNext(1);
    h.setNow(at(8, 0));
    await h.crons.tick();
    assert.match(h.notified[0] ?? "", /This routine failed and will retry .*: boom/);

    h.setNow(at(8, 2));
    await h.crons.tick();
    assert.deepEqual(h.notified.at(-1), "brief:brief done");
    assert.equal(h.store.lastRun("brief"), "2026-01-15");

    h.setNow(at(9, 0));
    await h.crons.tick();
    assert.equal(h.fired.length, 2);
    h.store.close();
});

test("a late job whose next retry would land tomorrow gives the day up and says so", async () => {
    const h = harness("UTC", [job({ id: "carry", when: "23:00" })]);
    h.failNext(99);
    h.setNow(at(23, 0));
    await h.crons.tick();
    h.setNow(at(23, 2));
    await h.crons.tick();
    assert.equal(h.fired.length, 2);
    assert.equal(h.store.lastRun("carry"), null);

    h.setNow(at(23, 17));
    await h.crons.tick(); // attempt 3: attempt 4 would fall at 00:17 tomorrow
    assert.equal(h.fired.length, 3);
    assert.deepEqual(h.notified, [
        "carry:This routine failed and will retry later today: boom",
        "carry:This routine failed on attempt 3 and will not run again today: boom",
    ]);
    assert.equal(h.store.lastRun("carry"), "2026-01-15");

    h.setNow(Date.UTC(2026, 0, 16, 0, 17));
    await h.crons.tick();
    h.setNow(Date.UTC(2026, 0, 16, 22, 59));
    await h.crons.tick();
    assert.equal(h.fired.length, 3); // nothing more until its own time tomorrow

    const last = harness("UTC", [job({ id: "last", when: "23:59" })]);
    last.failNext(1);
    last.setNow(at(23, 59));
    await last.crons.tick(); // even the first retry would be tomorrow
    assert.deepEqual(last.notified, ["last:This routine failed on attempt 1 and will not run again today: boom"]);
    assert.equal(last.store.lastRun("last"), "2026-01-15");
    h.store.close();
    last.store.close();
});

test("a link lost mid-tick holds the later due jobs for the next connected tick", async () => {
    const h = harness("UTC", [job({ id: "a" }), job({ id: "b" })]);
    h.setNow(at(8, 0));
    const release = h.hold();
    const ticking = h.crons.tick();
    assert.deepEqual(h.fired, ["a"]);
    h.setConnected(false); // the gateway drops while "a" runs
    h.failNext(1, new Error("connection lost"));
    release();
    await ticking;
    assert.deepEqual(h.fired, ["a"]); // "b" is not burned against a dead link
    assert.deepEqual(h.notified, ["a:This routine failed and will retry later today: connection lost"]);

    h.setConnected(true);
    h.setNow(at(8, 1));
    await h.crons.tick();
    assert.deepEqual(h.fired, ["a", "b"]);
    assert.doesNotMatch(h.prompts[1] ?? "", /attempt/); // "b" runs as its first attempt
    assert.equal(h.store.lastRun("b"), "2026-01-15");
    h.store.close();
});

test("a boot catch-up cut short by a lost link still skips the catchUp:false job it had not reached", async () => {
    const h = harness("UTC", [job({ id: "a", when: "08:00" }), job({ id: "b", when: "08:30", catchUp: false })]);
    h.setNow(at(9, 0));
    const release = h.hold();
    const ticking = h.crons.tick(); // the boot catch-up starts "a"
    h.setConnected(false);
    h.failNext(1, new Error("connection lost"));
    release();
    await ticking;

    h.setConnected(true);
    h.setNow(at(9, 1));
    await h.crons.tick();
    h.setNow(at(9, 2));
    await h.crons.tick(); // "a" retries; "b" passed while the process was down and opted out of catch-up
    assert.deepEqual(h.fired, ["a", "a"]);
    h.store.close();
});

test("boot catch-up runs a missed catchUp:true job and skips a catchUp:false one until tomorrow", async () => {
    const h = harness("UTC", [
        job({ id: "makeup", when: "08:00", catchUp: true }),
        job({ id: "skipme", when: "08:00", catchUp: false }),
    ]);
    h.setNow(at(9, 0)); // both times already passed when the process starts
    await h.crons.tick(); // the immediate boot tick
    assert.deepEqual(h.fired, ["makeup"]);
    assert.equal(h.crons.list().find((j) => j.id === "skipme")?.next, "2026-01-16 08:00");

    h.setNow(at(9, 1));
    await h.crons.tick(); // a later tick the same day must not resurrect the skipped job
    assert.deepEqual(h.fired, ["makeup"]);

    // next day the skipped job is eligible again and fires at its time (makeup fires again too, its new day)
    h.setNow(Date.UTC(2026, 0, 16, 8, 0));
    await h.crons.tick();
    assert.equal(h.fired.filter((id) => id === "skipme").length, 1, "skipme runs exactly once, on the new day");
    h.store.close();
});

test("while disconnected a tick does nothing, and the boot catch-up waits for the connection", async () => {
    const h = harness("UTC", [
        job({ id: "makeup", when: "08:00", catchUp: true }),
        job({ id: "skipme", when: "08:00", catchUp: false }),
    ]);
    h.setConnected(false);
    h.setNow(at(7, 0));
    await h.crons.tick(); // not connected: must not count as the boot tick
    h.setNow(at(9, 0));
    await h.crons.tick();
    assert.deepEqual(h.fired, []);

    h.setConnected(true);
    await h.crons.tick(); // the real boot tick: catch-up rules apply now
    assert.deepEqual(h.fired, ["makeup"]);
    h.store.close();
});

test("a catchUp:false job still fires normally at its time on a running process (not a boot miss)", async () => {
    const h = harness("UTC", [job({ catchUp: false })]);
    h.setNow(at(7, 59));
    await h.crons.tick(); // boot tick, below time — not a miss, so not skipped

    h.setNow(at(8, 0));
    await h.crons.tick(); // its minute arrives while running → fires despite catchUp:false
    assert.deepEqual(h.fired, ["brief"]);
    h.store.close();
});

test("the fire decision follows the given timezone, not the host clock", async () => {
    // 12:00 UTC on 2026-01-15 is 07:00 in New York (before 08:00) and 21:00 in Tokyo (after 08:00).
    const epoch = Date.UTC(2026, 0, 15, 12, 0);

    const ny = harness("America/New_York", [job()]);
    ny.setNow(epoch);
    await ny.crons.tick();
    assert.deepEqual(ny.fired, []); // 07:00 local — not yet
    ny.store.close();

    const tokyo = harness("Asia/Tokyo", [job()]);
    tokyo.setNow(epoch);
    await tokyo.crons.tick();
    assert.deepEqual(tokyo.fired, ["brief"]); // 21:00 local — its time has passed
    tokyo.store.close();
});

test("a bad timezone throws when the engine is built, not later inside a tick", () => {
    const store = new SqliteCronStore(":memory:");
    const opts = { store, fire: async () => "", notify: () => {}, connected: () => true, log: () => {} };
    assert.throws(() => createCrons({ ...opts, tz: "Mars/Base" }), RangeError);
    store.close();
});

test("a tick that hits a store error logs it instead of rejecting", async () => {
    const h = harness("UTC", [job()]);
    h.store.close();
    h.setNow(at(8, 0));
    await h.crons.tick();
    assert.match(h.logs.join(""), /tick failed/);
});

test("after stop, a finishing run and later ticks leave the closed store alone", async () => {
    const h = harness("UTC", [job()]);
    h.setNow(at(8, 0));
    const release = h.hold();
    const stop = h.crons.start(); // the boot tick starts the job and waits on it
    assert.deepEqual(h.fired, ["brief"]);

    stop();
    h.store.close(); // what the pack does on shutdown
    release();
    await settle();
    await h.crons.tick();
    assert.deepEqual(h.logs, []); // no stamp, no list on the closed store
    assert.deepEqual(h.notified, []);
});

test("adding, re-timing or re-enabling a job at a time already gone today holds it until tomorrow", async () => {
    const h = harness("UTC", []);
    h.setNow(at(15, 0));
    h.crons.add(job({ id: "early", when: "07:00" }));
    h.crons.add(job({ id: "now", when: "15:00" }));
    h.crons.add(job({ id: "late", when: "16:00" }));
    h.crons.add(job({ id: "paused", when: "16:00", enabled: false }));
    assert.equal(h.store.lastRun("early"), "2026-01-15");
    assert.equal(h.store.lastRun("now"), null); // this very minute still counts as ahead
    assert.equal(h.store.lastRun("late"), null);

    await h.crons.tick();
    assert.deepEqual(h.fired, ["now"]);

    h.crons.edit("late", { title: "renamed" });
    assert.equal(h.store.lastRun("late"), null); // not a time or on/off change
    h.crons.edit("late", { when: "14:00" });
    h.setNow(at(17, 0));
    h.crons.edit("paused", { enabled: true });
    await h.crons.tick();
    assert.deepEqual(h.fired, ["now"]);

    h.setNow(Date.UTC(2026, 0, 16, 16, 0));
    await h.crons.tick();
    assert.deepEqual(h.fired.slice(1).sort(), ["early", "late", "now", "paused"]);
    h.store.close();
});

test("moving a held job ahead today runs it at its new time, but a job that already ran stays settled", async () => {
    const h = harness("UTC", [job({ id: "ran", when: "15:00" })]);
    h.setNow(at(15, 0));
    await h.crons.tick();
    assert.deepEqual(h.fired, ["ran"]);

    h.crons.add(job({ id: "early", when: "07:00" })); // held until tomorrow...
    h.crons.edit("early", { when: "16:00" }); // ...then put ahead again
    h.crons.edit("early", { when: "06:00" }); // held again, still releasable
    h.crons.edit("early", { when: "18:00" });
    assert.equal(h.store.lastRun("early"), null);

    h.crons.add(job({ id: "paused", when: "07:00", enabled: false }));
    h.crons.edit("paused", { when: "18:00", enabled: true });

    h.crons.edit("ran", { when: "07:00" });
    h.crons.edit("ran", { when: "18:00" }); // its real run today still counts
    assert.equal(h.store.lastRun("ran"), "2026-01-15");

    h.setNow(at(18, 0));
    await h.crons.tick();
    assert.deepEqual(h.fired.slice(1).sort(), ["early", "paused"]);
    h.store.close();
});

test("a job held while its run is in flight stays settled once that run succeeds or gives up", async () => {
    const h = harness("UTC", [job({ id: "brief", when: "08:00" }), job({ id: "last", when: "23:59" })]);
    h.setNow(at(8, 0));
    let release = h.hold();
    let ticking = h.crons.tick(); // the 08:00 run starts
    h.crons.edit("brief", { when: "07:00" }); // held while it runs
    release();
    await ticking;
    h.crons.edit("brief", { when: "09:00" }); // put ahead again: the run it just finished still counts
    h.setNow(at(9, 0));
    await h.crons.tick();
    assert.deepEqual(h.fired, ["brief"]);

    h.setNow(at(23, 59));
    h.failNext(1);
    release = h.hold();
    ticking = h.crons.tick(); // its first retry would be tomorrow, so this failure gives the day up
    h.crons.edit("last", { when: "23:00" });
    release();
    await ticking;
    h.crons.edit("last", { when: "23:59" });
    await h.crons.tick();
    assert.deepEqual(h.fired, ["brief", "last"]);
    assert.equal(h.store.lastRun("last"), "2026-01-15");
    h.store.close();
});

test("a catchUp:false job skipped at boot runs today once it is moved ahead", async () => {
    const h = harness("UTC", [job({ id: "skipme", when: "08:00", catchUp: false })]);
    h.setNow(at(9, 0));
    await h.crons.tick(); // boot: missed while down, skipped
    h.crons.edit("skipme", { when: "10:00" });
    h.setNow(at(10, 0));
    await h.crons.tick();
    assert.deepEqual(h.fired, ["skipme"]);
    h.store.close();
});

test("defaults are seeded once per database, and ones already past are held until tomorrow", () => {
    const h = harness("UTC", []);
    h.setNow(at(15, 0));
    const defaults = [job({ id: "cut", when: "07:00" }), job({ id: "review", when: "21:00" })];
    h.crons.seed(defaults);
    assert.deepEqual(h.crons.list().map((j) => j.id), ["cut", "review"]);
    assert.equal(h.store.lastRun("cut"), "2026-01-15");
    assert.equal(h.store.lastRun("review"), null);

    h.crons.remove("cut");
    h.crons.remove("review");
    h.crons.seed(defaults); // the owner removed them: they stay removed
    assert.deepEqual(h.crons.list(), []);
    h.store.close();
});

test("runNow starts the job in the background, blocks a second copy, and always reports", async () => {
    const h = harness("UTC", [job({ notify: false })]);
    h.setNow(at(1, 0));
    const release = h.hold();
    assert.equal(h.crons.runNow("brief"), 'Started "brief" — the result will arrive in your Inbox.');
    assert.deepEqual(h.fired, ["brief"]);
    assert.match(h.prompts[0] ?? "", /^Run now on the owner's request at 01:00 UTC, today is 2026-01-15\.\n\nwrite the brief$/);

    assert.match(h.crons.runNow("brief"), /already running/);
    h.setNow(at(8, 0));
    const scheduled = h.crons.tick(); // the scheduled run waits for the manual one
    assert.deepEqual(h.fired, ["brief"]);

    release();
    await scheduled;
    await settle();
    assert.deepEqual(h.notified, ["brief:brief done"]); // reported although the job's notify is off
    assert.equal(h.store.lastRun("brief"), null); // a manual run does not count as the scheduled one

    h.setNow(at(8, 1));
    await h.crons.tick();
    assert.deepEqual(h.fired, ["brief", "brief"]);

    h.failNext(1);
    h.crons.runNow("brief");
    await settle();
    assert.match(h.notified.at(-1) ?? "", /^brief:This routine failed: boom$/);
    assert.throws(() => h.crons.runNow("missing"), /no cron job/);
    h.store.close();
});

test("a manual run that succeeds settles a scheduled run waiting to retry, so it is not run again", async () => {
    const h = harness("UTC", [job()]);
    h.failNext(1);
    h.setNow(at(8, 0));
    await h.crons.tick(); // fails, retry due at 08:02
    h.setNow(at(8, 1));
    h.crons.runNow("brief");
    await settle();
    assert.equal(h.notified.at(-1), "brief:brief done");
    assert.equal(h.store.lastRun("brief"), "2026-01-15");

    h.setNow(at(8, 2));
    await h.crons.tick();
    h.setNow(at(9, 0));
    await h.crons.tick();
    assert.equal(h.fired.length, 2);
    assert.ok(h.prompts.every((p) => !p.includes("attempt 2")));
    h.store.close();
});

test("a weekday job fires on its days only, at its time, and is told its schedule", async () => {
    const h = harness("UTC", [job({ id: "standup", when: "mon-fri 08:00" })]);
    for (const day of [16, 17, 18, 19]) {
        // Friday 2026-01-16 to Monday 2026-01-19
        h.setNow(Date.UTC(2026, 0, day, 7, 59));
        await h.crons.tick();
        h.setNow(Date.UTC(2026, 0, day, 8, 0));
        await h.crons.tick();
    }
    assert.deepEqual(h.fired, ["standup", "standup"]);
    assert.equal(h.prompts[0], "Scheduled mon-fri 08:00, running at 08:00 UTC, today is 2026-01-16.\n\nwrite the brief");
    assert.match(h.prompts[1] ?? "", /today is 2026-01-19\./);
    h.store.close();
});

test("a missed weekday run catches up the same day, never on a later one", async () => {
    const h = harness("UTC", [job({ id: "fri", when: "fri 08:00" }), job({ id: "thu", when: "thu 08:00" })]);
    h.setNow(Date.UTC(2026, 0, 16, 9, 0)); // Friday: the agent starts after both times
    await h.crons.tick();
    assert.deepEqual(h.fired, ["fri"]); // Thursday's run stays missed

    const off = harness("UTC", [job({ id: "fri", when: "fri 08:00", catchUp: false })]);
    off.setNow(Date.UTC(2026, 0, 16, 9, 0));
    await off.crons.tick();
    off.setNow(Date.UTC(2026, 0, 23, 8, 0)); // the next Friday
    await off.crons.tick();
    assert.deepEqual(off.fired, ["fri"]);
    h.store.close();
    off.store.close();
});

test("a one-off runs once at its moment, then turns off and stays listed as ran", async () => {
    const h = harness("UTC", [job({ id: "trip", when: "2026-01-15 08:00", notify: true })]);
    h.setNow(at(7, 59));
    await h.crons.tick();
    assert.deepEqual(h.crons.list().map((j) => [j.next, j.ran]), [["2026-01-15 08:00", false]]);

    h.setNow(at(8, 0));
    await h.crons.tick();
    assert.equal(h.prompts[0], "Scheduled 2026-01-15 08:00, running at 08:00 UTC, today is 2026-01-15.\n\nwrite the brief");
    assert.deepEqual(h.notified, ["trip:trip done"]);
    assert.equal(h.store.get("trip")?.enabled, false);
    assert.equal(h.store.lastRun("trip"), "2026-01-15 08:00");
    assert.deepEqual(h.crons.list().map((j) => [j.enabled, j.next, j.ran]), [[false, null, true]]);

    h.setNow(at(8, 1));
    await h.crons.tick();
    h.setNow(Date.UTC(2026, 0, 16, 8, 0));
    await h.crons.tick();
    assert.deepEqual(h.fired, ["trip"]);
    h.store.close();
});

test("a one-off that keeps failing gives up for good and turns off", async () => {
    const h = harness("UTC", [job({ id: "late", when: "2026-01-15 23:59" })]);
    h.failNext(1);
    h.setNow(at(23, 59));
    await h.crons.tick(); // its first retry would be tomorrow
    assert.deepEqual(h.notified, ["late:This routine failed on attempt 1 and will not run again: boom"]);
    assert.equal(h.store.get("late")?.enabled, false);
    assert.equal(h.crons.list()[0]?.ran, true);
    h.store.close();
});

test("a manual run that settles a one-off waiting to retry turns it off", async () => {
    const h = harness("UTC", [job({ id: "trip", when: "2026-01-15 08:00" })]);
    h.failNext(1);
    h.setNow(at(8, 0));
    await h.crons.tick(); // fails, retry due at 08:02
    h.setNow(at(8, 1));
    h.crons.runNow("trip");
    await settle();
    assert.equal(h.store.get("trip")?.enabled, false);
    h.setNow(at(8, 2));
    await h.crons.tick();
    assert.equal(h.fired.length, 2);
    h.store.close();
});

test("a missed one-off catches up the same day; on a later day, or with catchUp off, it is reported and turned off", async () => {
    const h = harness("UTC", [
        job({ id: "today", when: "2026-01-15 08:00" }),
        job({ id: "yesterday", when: "2026-01-14 08:00" }),
        job({ id: "strict", when: "2026-01-15 07:00", catchUp: false }),
        job({ id: "paused", when: "2026-01-14 09:00", enabled: false }),
    ]);
    h.setNow(at(9, 0)); // the agent starts after all of them
    await h.crons.tick();
    assert.deepEqual(h.fired, ["today"]);
    assert.deepEqual(h.notified.sort(), [
        "strict:This one-off was due at 2026-01-15 07:00 UTC and was missed while the agent was offline. It is now off.",
        "yesterday:This one-off was due at 2026-01-14 08:00 UTC and was missed while the agent was offline. It is now off.",
    ]);
    assert.deepEqual(h.crons.list().map((j) => [j.id, j.enabled, j.ran]), [
        ["strict", false, false],
        ["today", false, true],
        ["yesterday", false, false],
        ["paused", false, false], // switched off by the owner: nothing to report
    ]);

    h.setNow(at(9, 1));
    await h.crons.tick();
    assert.equal(h.notified.length, 2); // reported once
    h.store.close();
});

test("a one-off whose day ends while the link is down is reported once the link is back", async () => {
    const h = harness("UTC", [job({ id: "night", when: "2026-01-15 23:30" })]);
    h.setNow(at(23, 0));
    await h.crons.tick(); // boot pass, nothing due yet
    h.setConnected(false);
    h.setNow(at(23, 30));
    await h.crons.tick();
    h.setConnected(true);
    h.setNow(Date.UTC(2026, 0, 16, 0, 10));
    await h.crons.tick();
    assert.deepEqual(h.fired, []);
    assert.match(h.notified[0] ?? "", /^night:This one-off was due at 2026-01-15 23:30 UTC and was missed while the agent was offline/);
    h.store.close();
});

test("a one-off that falls due while the agent is up runs late past midnight instead of being reported missed", async () => {
    const h = harness("UTC", [job({ id: "nightly", when: "23:50" }), job({ id: "trip", when: "2026-01-15 23:58" })]);
    h.setNow(at(23, 50));
    const release = h.hold();
    const ticking = h.crons.tick(); // "nightly" runs past midnight, so this pass never sees "trip" due
    h.setNow(Date.UTC(2026, 0, 16, 0, 11));
    release();
    await ticking;
    await h.crons.tick();
    assert.deepEqual(h.fired, ["nightly", "trip"]);
    assert.match(h.prompts[1] ?? "", /^Scheduled 2026-01-15 23:58, running at 00:11 UTC, today is 2026-01-16\./);
    assert.deepEqual(h.notified, []);
    assert.deepEqual(h.crons.list().map((j) => [j.id, j.enabled, j.ran]), [
        ["nightly", true, false],
        ["trip", false, true],
    ]);
    h.store.close();

    const late = harness("UTC", []);
    late.setNow(at(23, 59) + 10_000);
    await late.crons.tick(); // the day's last pass
    late.setNow(at(23, 59) + 30_000);
    late.crons.add(job({ id: "now", when: "2026-01-15 23:59" })); // this minute still counts as ahead
    late.crons.add(job({ id: "makeup", when: "2026-01-15 20:00" })); // earlier today with catchUp on: runs at once
    late.setNow(Date.UTC(2026, 0, 16, 0, 0) + 10_000);
    await late.crons.tick();
    assert.deepEqual(late.fired, ["makeup", "now"]);
    assert.deepEqual(late.notified, []);
    late.store.close();
});

test("a one-off whose retry is lost while the agent is offline says it gave up, never that it did not run", async () => {
    const h = harness("UTC", [job({ id: "night", when: "2026-01-15 23:40" })]);
    h.failNext(1);
    h.setNow(at(23, 40));
    await h.crons.tick(); // fails, retry due at 23:42
    h.setConnected(false);
    h.setNow(at(23, 42));
    await h.crons.tick();
    h.setConnected(true);
    h.setNow(Date.UTC(2026, 0, 16, 0, 5));
    await h.crons.tick();
    assert.deepEqual(h.fired, ["night"]);
    assert.deepEqual(h.notified, [
        "night:This routine failed and will retry later today: boom",
        "night:This routine failed on attempt 1 and will not run again: the agent was offline when it was due to retry.",
    ]);
    assert.deepEqual(h.crons.list().map((j) => [j.enabled, j.ran]), [[false, true]]);
    h.store.close();

    // a restart forgets the pending retry, so a catchUp:false one-off is reported as missed, not as never run
    const strict = harness("UTC", [job({ id: "trip", when: "2026-01-15 08:00", catchUp: false })]);
    strict.failNext(1);
    strict.setNow(at(7, 59));
    await strict.crons.tick();
    strict.setNow(at(8, 0));
    await strict.crons.tick(); // fails, retry due at 08:02
    const notified: string[] = [];
    const restarted = createCrons({
        store: strict.store,
        tz: "UTC",
        now: () => at(8, 1),
        connected: () => true,
        fire: async () => "",
        notify: (j, result) => notified.push(`${j.id}:${result}`),
        log: () => {},
    });
    await restarted.tick();
    assert.deepEqual(notified, ["trip:This one-off was due at 2026-01-15 08:00 UTC and was missed while the agent was offline. It is now off."]);
    strict.store.close();
});

test("adding or re-arming a one-off at a moment already past is refused, unless catchUp runs it today", async () => {
    const h = harness("UTC", []);
    h.setNow(at(15, 0));
    await h.crons.tick(); // the boot pass, so the catchUp:false job below is not a boot miss
    assert.throws(
        () => h.crons.add(job({ id: "old", when: "2026-01-14 10:00" })),
        /^Error: "2026-01-14 10:00" has already passed \(now 2026-01-15 15:00 UTC\) — a one-off needs a moment ahead/,
    );
    assert.throws(() => h.crons.add(job({ id: "strict", when: "2026-01-15 14:00", catchUp: false })), /has already passed/);
    assert.equal(h.store.get("old"), null);
    assert.equal(h.store.get("strict"), null);

    const now = h.crons.add(job({ id: "now", when: "2026-01-15 15:00", catchUp: false }));
    assert.equal(now.next, "2026-01-15 15:00"); // this minute is still ahead
    assert.equal(h.crons.add(job({ id: "makeup", when: "2026-01-15 14:00" })).next, "2026-01-15 14:00");
    await h.crons.tick();
    assert.deepEqual(h.fired, ["makeup", "now"]); // the catchUp one runs at once

    h.setNow(at(15, 1));
    assert.throws(() => h.crons.edit("now", { enabled: true }), /has already passed/); // it ran and is off
    assert.equal(h.crons.edit("now", { title: "renamed" })?.ran, true); // not re-armed: allowed
    const again = h.crons.edit("now", { when: "2026-01-16 09:00", enabled: true });
    assert.deepEqual([again?.enabled, again?.next], [true, "2026-01-16 09:00"]);
    assert.throws(() => h.crons.edit("now", { when: "2026-01-14 09:00" }), /has already passed/);
    assert.equal(h.store.get("now")?.when, "2026-01-16 09:00");

    h.setNow(Date.UTC(2026, 0, 16, 9, 0));
    await h.crons.tick();
    assert.deepEqual(h.fired, ["makeup", "now", "now"]);
    h.store.close();
});

test("an armed one-off waiting to retry past its moment can still be edited, catchUp off or not", async () => {
    const h = harness("UTC", [job({ id: "trip", when: "2026-01-15 08:00", catchUp: false })]);
    h.failNext(1);
    h.setNow(at(7, 59));
    await h.crons.tick(); // the boot pass, so 08:00 is not a boot miss
    h.setNow(at(8, 0));
    await h.crons.tick(); // fails, retry due at 08:02
    h.setNow(at(8, 1));
    assert.equal(h.crons.edit("trip", { title: "Trip home" })?.enabled, true);
    h.setNow(at(8, 2));
    await h.crons.tick();
    assert.deepEqual(h.fired, ["trip", "trip"]);
    assert.equal(h.store.get("trip")?.enabled, false);
    h.store.close();
});

test("a one-off re-timed while it runs stays on for its new moment", async () => {
    const h = harness("UTC", [job({ id: "trip", when: "2026-01-15 08:00" })]);
    h.setNow(at(8, 0));
    const release = h.hold();
    const ticking = h.crons.tick();
    h.crons.edit("trip", { when: "2026-01-15 18:00" });
    release();
    await ticking;
    assert.equal(h.store.get("trip")?.enabled, true);

    h.setNow(at(18, 0));
    await h.crons.tick();
    assert.deepEqual(h.fired, ["trip", "trip"]);
    assert.equal(h.store.get("trip")?.enabled, false);
    h.store.close();
});

test("a one-off that ran stays off when re-timed and no longer reads as ran; made repeating, it runs from today", async () => {
    const h = harness("UTC", [job({ id: "trip", when: "2026-01-15 08:00" }), job({ id: "walk", when: "2026-01-15 08:00" })]);
    h.setNow(at(8, 0));
    await h.crons.tick();
    h.setNow(at(9, 0));
    const moved = h.crons.edit("trip", { when: "2026-01-15 18:00" });
    assert.deepEqual([moved?.enabled, moved?.next, moved?.ran], [false, null, false]);
    const daily = h.crons.edit("walk", { when: "18:00", enabled: true });
    assert.equal(daily?.next, "2026-01-15 18:00");

    h.setNow(at(18, 0));
    await h.crons.tick();
    assert.deepEqual(h.fired, ["trip", "walk", "walk"]);
    assert.equal(h.crons.edit("trip", { when: "2026-01-15 08:00" })?.ran, true); // back at the moment it ran
    h.store.close();
});

test("a job switched from a repeating schedule to a one-off later today runs then", async () => {
    const h = harness("UTC", [job({ id: "skipme", when: "08:00", catchUp: false })]);
    h.setNow(at(9, 0));
    await h.crons.tick(); // boot: missed while down, skipped for today
    h.crons.add(job({ id: "early", when: "07:00" })); // held until tomorrow
    h.crons.edit("skipme", { when: "2026-01-15 10:00" });
    h.crons.edit("early", { when: "2026-01-15 10:00" });
    h.setNow(at(10, 0));
    await h.crons.tick();
    assert.deepEqual(h.fired, ["early", "skipme"]);
    h.store.close();
});

test("list gives each job's next run: today while pending, else the next day its schedule fires", () => {
    const h = harness("UTC", []);
    h.setNow(Date.UTC(2026, 0, 16, 9, 0)); // Friday 09:00
    h.crons.add(job({ id: "a-daily-gone", when: "08:00" }));
    h.crons.add(job({ id: "b-daily-ahead", when: "10:00" }));
    h.crons.add(job({ id: "c-workdays-gone", when: "mon-fri 08:00" }));
    h.crons.add(job({ id: "d-weekend", when: "sat,sun 07:00" }));
    h.crons.add(job({ id: "e-once", when: "2026-01-20 15:00" }));
    h.crons.add(job({ id: "f-off", when: "09:30", enabled: false }));
    assert.deepEqual(
        Object.fromEntries(h.crons.list().map((j) => [j.id, j.next])),
        {
            "a-daily-gone": "2026-01-17 08:00",
            "b-daily-ahead": "2026-01-16 10:00",
            "c-workdays-gone": "2026-01-19 08:00",
            "d-weekend": "2026-01-17 07:00",
            "e-once": "2026-01-20 15:00",
            "f-off": null,
        },
    );
    h.store.close();
});

test("across the Europe/Kyiv DST changes a weekday job and a one-off fire once, at their wall-clock time", async () => {
    // Kyiv turns its clocks back at 01:00 UTC on Sunday 2026-10-25 (04:00 EEST becomes 03:00 EET)
    const fall = harness("Europe/Kyiv", [
        job({ id: "weekend", when: "sat,sun 10:00" }),
        job({ id: "night", when: "sun 03:30" }),
        job({ id: "trip", when: "2026-10-25 03:30" }),
    ]);
    const steps: Array<[number, number, number, string[]]> = [
        [24, 6, 59, []], // Saturday 09:59 EEST
        [24, 7, 0, ["weekend"]], // Saturday 10:00 EEST
        [25, 0, 29, []], // Sunday 03:29 EEST
        [25, 0, 30, ["night", "trip"]], // the first 03:30
        [25, 1, 30, []], // the second 03:30, now EET
        [25, 7, 0, []], // 09:00 EET: an hour before its time
        [25, 8, 0, ["weekend"]], // 10:00 EET
    ];
    for (const [day, hour, minute, fires] of steps) {
        const before = fall.fired.length;
        fall.setNow(Date.UTC(2026, 9, day, hour, minute));
        await fall.crons.tick();
        assert.deepEqual(fall.fired.slice(before), fires, `2026-10-${day} ${hour}:${minute} UTC`);
    }
    assert.match(fall.prompts.at(-1) ?? "", /^Scheduled sat,sun 10:00, running at 10:00 Europe\/Kyiv, today is 2026-10-25\./);
    assert.equal(fall.store.get("trip")?.enabled, false);
    fall.store.close();

    // and forward at 01:00 UTC on Sunday 2026-03-29: 03:30 never shows on the clock, so both run at 04:00
    const spring = harness("Europe/Kyiv", [job({ id: "night", when: "sun 03:30" }), job({ id: "trip", when: "2026-03-29 03:30" })]);
    spring.setNow(Date.UTC(2026, 2, 29, 0, 59)); // 02:59 EET
    await spring.crons.tick();
    spring.setNow(Date.UTC(2026, 2, 29, 1, 0)); // 04:00 EEST
    await spring.crons.tick();
    spring.setNow(Date.UTC(2026, 2, 29, 1, 30));
    await spring.crons.tick();
    assert.deepEqual(spring.fired, ["night", "trip"]);
    assert.match(spring.prompts[0] ?? "", /^Scheduled sun 03:30, running at 04:00 Europe\/Kyiv, today is 2026-03-29\./);
    assert.match(spring.prompts[1] ?? "", /^Scheduled 2026-03-29 03:30, running at 04:00 Europe\/Kyiv/);
    spring.store.close();
});

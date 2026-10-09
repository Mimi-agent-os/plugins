import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DeniedError, runAgent } from "@mimi-os/sdk";
import type { PackRuntime } from "@mimi-os/sdk";
import { HandshakeSocket } from "@mimi-os/sdk/testing";

import { cronsPack } from "./pack.ts";
import { SqliteCronStore } from "./store.ts";

function packRuntime(): PackRuntime {
    return {
        ask: () => Promise.reject(new Error("no gateway in this test")),
        notify: () => {},
        connected: () => true,
        dataDir: mkdtempSync(join(tmpdir(), "mimi-crons-pack-")),
        redescribe: () => {},
        log: () => {},
    };
}

// throws "database is locked" while any other connection still holds the file open
function assertReleased(db: string): void {
    const probe = new DatabaseSync(db);
    try {
        probe.exec("PRAGMA locking_mode = EXCLUSIVE");
        probe.exec("BEGIN EXCLUSIVE");
        probe.exec("COMMIT");
    } finally {
        probe.close();
    }
}

test("a start with a bad timezone throws, releases crons.db, and leaves the tools not started", async () => {
    const pack = cronsPack({ tz: "Not/AZone", run: async () => "" });
    const rt = packRuntime();
    assert.throws(() => pack.start!(rt), RangeError);
    assertReleased(join(rt.dataDir, "crons.db"));
    const look = pack.tools.find((t) => t.definition.function.name === "cron_look")!;
    assert.equal(await look.execute({}), "Error: scheduler not started yet.");
    rmSync(rt.dataDir, { recursive: true, force: true });
});

test("a start whose seeding fails throws, releases crons.db, and never reports a routine as added", async () => {
    const pack = cronsPack({ tz: "UTC", run: async () => "" });
    const rt = packRuntime();
    const db = join(rt.dataDir, "crons.db");
    new SqliteCronStore(db).close();
    const holder = new DatabaseSync(db); // a second process mid-write
    holder.exec("BEGIN IMMEDIATE");
    assert.throws(() => pack.start!(rt), /database is locked/);
    holder.exec("ROLLBACK");
    holder.close();

    assertReleased(db);
    const add = pack.tools.find((t) => t.definition.function.name === "cron_add")!;
    assert.equal(await add.execute({ title: "Walk", when: "08:00", instruction: "remind me to walk" }), "Error: scheduler not started yet.");
    rmSync(rt.dataDir, { recursive: true, force: true });
});

test("a routine whose ask the gateway denies is not retried that day", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mimi-crons-agent-"));
    writeFileSync(join(dir, "agent.json"), JSON.stringify({ name: "alpha" }));
    const db = join(dir, "data", "packs", "crons", "crons.db");
    const seeded = new SqliteCronStore(db);
    seeded.add({ id: "brief", title: "Morning brief", when: "00:00", instruction: "brief me", notify: true, enabled: true, catchUp: true });
    seeded.close();

    // a chat is answered the way gateway/src/registry/peer.ts replies to oneShot's PeerError("…", "denied")
    const gateway = new HandshakeSocket({
        chat: () => {
            throw new DeniedError('"alpha" is paused — no model calls until it is resumed');
        },
    });
    const notices = (): unknown[] => gateway.sent.filter((f) => f.type === "notify").map((f) => (f.payload as { body?: string }).body);
    const pack = cronsPack({ tz: "UTC", run: (job, rt) => rt.ask(job.instruction).then((r) => r.text) });
    const agent = await runAgent({ dir, socket: () => gateway, packs: [pack], log: () => {} });
    // the run may straddle 00:00 UTC, so the day it settles is the day it started or the next one
    const started = Date.now();
    const days = [started, started + 86_400_000].map((ms) => new Date(ms).toISOString().slice(0, 10));
    try {
        gateway.accept(); // the pack starts on the ready session and its boot tick fires "brief"
        for (let i = 0; i < 100 && notices().length === 0; i++) await new Promise((r) => setTimeout(r, 10));
        assert.deepEqual(notices(), [
            'This routine failed on attempt 1 and will not run again today: chat_ok: "alpha" is paused — no model calls until it is resumed',
        ]);
    } finally {
        await agent.stop();
    }
    const store = new SqliteCronStore(db);
    assert.ok(days.includes(store.lastRun("brief") ?? ""), `settled on ${store.lastRun("brief")}, not ${days.join(" or ")}`);
    store.close();
    rmSync(dir, { recursive: true, force: true });
});

test("the tools take every schedule form, cron_look shows each as stored with its next run, and a one-off ends as ran", async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.UTC(2026, 9, 9, 12, 0) }); // Friday 15:00 in Kyiv
    const notices: unknown[] = [];
    const rt = { ...packRuntime(), notify: (notice: unknown) => void notices.push(notice) } as PackRuntime;
    const pack = cronsPack({ tz: "Europe/Kyiv", run: async (job) => `done: ${job.id}` });
    const stop = pack.start!(rt);
    t.after(() => {
        stop?.();
        rmSync(rt.dataDir, { recursive: true, force: true });
    });
    const call = async (name: string, args: Record<string, unknown>): Promise<unknown> =>
        pack.tools.find((tool) => tool.definition.function.name === name)!.execute(args);

    assert.equal(
        await call("cron_add", { title: "Standup", when: "MON-Fri 08:00", instruction: "plan the day" }),
        'Added "standup": mon-fri 08:00, next run 2026-10-12 08:00.',
    );
    assert.equal(
        await call("cron_add", { title: "Trip", when: "2026-10-10 15:00", instruction: "remind me to pack", notify: true }),
        'Added "trip": 2026-10-10 15:00, next run 2026-10-10 15:00.',
    );
    assert.equal(
        await call("cron_add", { title: "Diary", when: "21:00", instruction: "ask about the day" }),
        'Added "diary": 21:00, next run 2026-10-09 21:00.',
    );
    assert.match(
        String(await call("cron_add", { title: "Late", when: "2026-10-08 09:00", instruction: "x" })),
        /^Error: "2026-10-08 09:00" has already passed \(now 2026-10-09 15:00 Europe\/Kyiv\)/,
    );
    assert.match(
        String(await call("cron_add", { title: "Bad", when: "tues 08:00", instruction: "x" })),
        /^Error: bad schedule "tues 08:00" — use "HH:MM"/,
    );
    assert.equal(await call("cron_edit", { id: "diary", when: "Sun 20:00" }), 'Updated "diary": sun 20:00, next run 2026-10-11 20:00.');
    assert.equal(
        await call("cron_look", {}),
        [
            "on  mon-fri 08:00 standup — Standup · next 2026-10-12 08:00",
            "on  2026-10-10 15:00 trip — Trip (notifies) · next 2026-10-10 15:00",
            "on  sun 20:00 diary — Diary · next 2026-10-11 20:00",
        ].join("\n"),
    );

    t.mock.timers.setTime(Date.UTC(2026, 9, 10, 11, 59)); // Saturday 14:59 in Kyiv
    t.mock.timers.tick(60_000);
    for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(notices, [{ title: "Trip", body: "done: trip" }]);
    assert.match(String(await call("cron_look", {})), /^off 2026-10-10 15:00 trip — Trip \(notifies\) · ran$/m);
    assert.equal(await call("cron_edit", { id: "trip", title: "Trip home" }), 'Updated "trip": 2026-10-10 15:00 (off).');
});

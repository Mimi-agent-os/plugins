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

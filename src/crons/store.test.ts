import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteCronStore } from "./store.ts";
import type { CronJob } from "./store.ts";

const job = (over: Partial<CronJob> = {}): CronJob => ({
    id: "brief",
    title: "Morning brief",
    when: "08:00",
    instruction: "write the brief",
    notify: true,
    enabled: true,
    catchUp: true,
    ...over,
});

test("add / get / update / remove round-trip", () => {
    const store = new SqliteCronStore(":memory:");
    store.add(job());

    assert.deepEqual(store.get("brief"), job());
    assert.equal(store.get("missing"), null);

    const updated = store.update("brief", { when: "09:15", notify: false, enabled: false });
    assert.deepEqual(updated, job({ when: "09:15", notify: false, enabled: false }));
    assert.deepEqual(store.get("brief"), job({ when: "09:15", notify: false, enabled: false }));

    assert.equal(store.update("missing", { when: "09:00" }), null);
    assert.equal(store.remove("brief"), true);
    assert.equal(store.remove("brief"), false);
    assert.equal(store.get("brief"), null);
    store.close();
});

test("list is ordered by time then id", () => {
    const store = new SqliteCronStore(":memory:");
    store.add(job({ id: "review", when: "21:00" }));
    store.add(job({ id: "cut", when: "07:55" }));
    store.add(job({ id: "brief", when: "08:00" }));
    assert.deepEqual(store.list().map((j) => j.id), ["cut", "brief", "review"]);
    store.close();
});

test("a patch never rewrites the id", () => {
    const store = new SqliteCronStore(":memory:");
    store.add(job());
    const updated = store.update("brief", { id: "hijacked", title: "renamed" } as Partial<CronJob>);
    assert.equal(updated?.id, "brief");
    assert.equal(store.get("hijacked"), null);
    store.close();
});

test("validation rejects a bad id and a bad time", () => {
    const store = new SqliteCronStore(":memory:");
    assert.throws(() => store.add(job({ id: "Bad Id" })), /bad cron id/);
    assert.throws(() => store.add(job({ id: "" })), /bad cron id/);
    assert.throws(() => store.add(job({ when: "24:00" })), /bad time/);
    assert.throws(() => store.add(job({ when: "8:00" })), /bad time/);
    assert.throws(() => store.add(job({ when: "08:60" })), /bad time/);

    store.add(job());
    assert.throws(() => store.add(job()), /already exists/);
    assert.throws(() => store.update("brief", { when: "nope" }), /bad time/);
    store.close();
});

test("a title must be 1-200 characters, since the gateway refuses any other notice title", () => {
    const store = new SqliteCronStore(":memory:");
    assert.throws(() => store.add(job({ title: "" })), /bad title/);
    assert.throws(() => store.add(job({ title: "   " })), /bad title/);
    assert.throws(() => store.add(job({ title: "x".repeat(201) })), /bad title/);
    store.add(job({ title: "x".repeat(200) }));

    assert.throws(() => store.update("brief", { title: " " }), /bad title/);
    assert.throws(() => store.update("brief", { title: "y".repeat(201) }), /bad title/);
    assert.equal(store.get("brief")?.title, "x".repeat(200));
    store.close();
});

test("seedIfFresh seeds a database once; removed defaults stay removed across restarts", () => {
    const dir = mkdtempSync(join(tmpdir(), "crons-"));
    const path = join(dir, "crons.db");
    try {
        const first = new SqliteCronStore(path);
        assert.equal(first.seedIfFresh([job(), job({ id: "review", when: "21:00" })]), true);
        assert.equal(first.list().length, 2);
        first.remove("brief");
        first.remove("review");
        first.close();

        const restarted = new SqliteCronStore(path);
        assert.equal(restarted.seedIfFresh([job()]), false);
        assert.deepEqual(restarted.list(), []);
        restarted.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a seed that fails part-way writes nothing and leaves the database unseeded", () => {
    const store = new SqliteCronStore(":memory:");
    assert.throws(() => store.seedIfFresh([job(), job({ id: "Bad Id" })]), /bad cron id/);
    assert.deepEqual(store.list(), []);
    assert.equal(store.seedIfFresh([job()]), true);
    assert.deepEqual(store.list().map((j) => j.id), ["brief"]);
    store.close();
});

test("last-run mark reads and writes per job", () => {
    const store = new SqliteCronStore(":memory:");
    store.add(job());
    assert.equal(store.lastRun("brief"), null);
    store.setLastRun("brief", "2026-01-15");
    assert.equal(store.lastRun("brief"), "2026-01-15");
    store.setLastRun("brief", "2026-01-16");
    assert.equal(store.lastRun("brief"), "2026-01-16");
    store.setLastRun("brief", null);
    assert.equal(store.lastRun("brief"), null);
    store.setLastRun("brief", "2026-01-16");
    // removing a job clears its mark too
    store.remove("brief");
    assert.equal(store.lastRun("brief"), null);
    store.close();
});

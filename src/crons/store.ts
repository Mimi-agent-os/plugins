/** The durable half of the crons pack: jobs and their per-day "last run" mark in one sqlite file.
 *  Pure node:sqlite + import type only, so the engine (core.ts) and this store unit-test in isolation
 *  without the sdk — only the pack (pack.ts) pulls @mimi-os/sdk in as a value. */

import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

import { parseWhen } from "./schedule.ts";

export interface CronJob {
    /** short slug, ^[a-z0-9][a-z0-9_-]{0,63}$ — stable key the tools and the last-run mark share. */
    id: string;
    title: string;
    /** The schedule, in the engine's timezone: "HH:MM" every day, "mon-fri 08:00" on days of the week, or
     *  "2026-10-10 15:00" once (schedule.ts owns the grammar); the store keeps it normalized. */
    when: string;
    instruction: string;
    /** true → the run's result is pushed to the owner; false → only logged. */
    notify: boolean;
    enabled: boolean;
    /** true → a run missed while the process was down is made up on the next start; false → skipped. */
    catchUp: boolean;
}

export interface CronStore {
    list(): CronJob[];
    get(id: string): CronJob | null;
    add(job: CronJob): CronJob;
    update(id: string, patch: Partial<CronJob>): CronJob | null;
    remove(id: string): boolean;
    /** Add `jobs` in one transaction unless this database was seeded before; true when it seeded.
     *  A removed default never comes back. */
    seedIfFresh(jobs: CronJob[]): boolean;
    /** The day-string ("YYYY-MM-DD") this job last settled — ran, gave up, or was set past its time — or null.
     *  A one-off is stamped only by its own run, with its moment ("YYYY-MM-DD HH:MM"). */
    lastRun(id: string): string | null;
    /** null clears the mark, as if the job never settled. */
    setLastRun(id: string, day: string | null): void;
    close(): void;
}

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// the gateway refuses a notice whose trimmed title is outside this, and the title heads every notice
const TITLE_MAX = 200;

function assertId(id: string): void {
    if (!ID_RE.test(id))
        throw new Error(`bad cron id "${id}" — use a slug like "morning-brief" (lowercase letters, digits, - or _, up to 64 chars).`);
}
function assertTitle(title: string): void {
    const n = title.trim().length;
    if (n < 1 || n > TITLE_MAX) throw new Error(`bad title — use 1-${TITLE_MAX} characters; it heads the routine's Inbox notices.`);
}

interface Row {
    id: string;
    title: string;
    run_at: string;
    instruction: string;
    notify: number;
    enabled: number;
    catch_up: number;
}
const toJob = (r: Row): CronJob => ({
    id: r.id,
    title: r.title,
    when: r.run_at,
    instruction: r.instruction,
    notify: r.notify === 1,
    enabled: r.enabled === 1,
    catchUp: r.catch_up === 1,
});

export class SqliteCronStore implements CronStore {
    private readonly db: DatabaseSync;

    constructor(path: string) {
        if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
        this.db = new DatabaseSync(path);
        this.db.exec("PRAGMA journal_mode = WAL");
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS jobs (
                id          TEXT PRIMARY KEY,
                title       TEXT NOT NULL,
                run_at      TEXT NOT NULL,
                instruction TEXT NOT NULL,
                notify      INTEGER NOT NULL,
                enabled     INTEGER NOT NULL,
                catch_up    INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS runs (
                id       TEXT PRIMARY KEY,
                last_day TEXT NOT NULL
            );
        `);
    }

    list(): CronJob[] {
        const rows = this.db.prepare("SELECT * FROM jobs ORDER BY id").all() as unknown as Row[];
        // by time of day, then id: the engine runs the jobs due together in this order
        return rows.map(toJob).sort((a, b) => parseWhen(a.when).minutes - parseWhen(b.when).minutes);
    }

    get(id: string): CronJob | null {
        const r = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as unknown as Row | undefined;
        return r ? toJob(r) : null;
    }

    add(job: CronJob): CronJob {
        assertId(job.id);
        assertTitle(job.title);
        const when = parseWhen(job.when).when;
        if (this.get(job.id)) throw new Error(`a cron job "${job.id}" already exists.`);
        this.db
            .prepare("INSERT INTO jobs (id, title, run_at, instruction, notify, enabled, catch_up) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .run(job.id, job.title, when, job.instruction, job.notify ? 1 : 0, job.enabled ? 1 : 0, job.catchUp ? 1 : 0);
        return { ...job, when };
    }

    update(id: string, patch: Partial<CronJob>): CronJob | null {
        const current = this.get(id);
        if (!current) return null;
        if (patch.title !== undefined) assertTitle(patch.title);
        const when = patch.when === undefined ? current.when : parseWhen(patch.when).when;
        const next: CronJob = { ...current, ...patch, id, when }; // id is the key, never rewritten by a patch
        this.db
            .prepare("UPDATE jobs SET title = ?, run_at = ?, instruction = ?, notify = ?, enabled = ?, catch_up = ? WHERE id = ?")
            .run(next.title, next.when, next.instruction, next.notify ? 1 : 0, next.enabled ? 1 : 0, next.catchUp ? 1 : 0, id);
        return next;
    }

    remove(id: string): boolean {
        this.db.prepare("DELETE FROM runs WHERE id = ?").run(id);
        return this.db.prepare("DELETE FROM jobs WHERE id = ?").run(id).changes > 0;
    }

    seedIfFresh(jobs: CronJob[]): boolean {
        const { user_version } = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
        if (user_version > 0) return false;
        this.db.exec("BEGIN IMMEDIATE");
        try {
            for (const job of jobs) this.add(job);
            this.db.exec("PRAGMA user_version = 1");
            this.db.exec("COMMIT");
        } catch (e) {
            this.db.exec("ROLLBACK");
            throw e;
        }
        return true;
    }

    lastRun(id: string): string | null {
        const r = this.db.prepare("SELECT last_day FROM runs WHERE id = ?").get(id) as unknown as { last_day: string } | undefined;
        return r ? r.last_day : null;
    }

    setLastRun(id: string, day: string | null): void {
        if (day === null) this.db.prepare("DELETE FROM runs WHERE id = ?").run(id);
        else
            this.db
                .prepare("INSERT INTO runs (id, last_day) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET last_day = excluded.last_day")
                .run(id, day);
    }

    close(): void {
        this.db.close();
    }
}

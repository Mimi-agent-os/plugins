/** The crons schedule grammar: the one place that reads a job's `when`. Three forms, each a wall-clock
 *  time in the engine's timezone: "HH:MM" every day, "<days> HH:MM" on days of the week, and
 *  "YYYY-MM-DD HH:MM" once. Calendar math runs on local day strings, so a DST change never moves a run. */

/** `when` is the normalized text the store keeps, `time` its "HH:MM" and `minutes` that time past midnight. */
export type Schedule =
    | { kind: "daily"; when: string; time: string; minutes: number }
    | { kind: "weekly"; when: string; time: string; minutes: number; days: number[] } // 0 = mon … 6 = sun
    | { kind: "once"; when: string; time: string; minutes: number; date: string };

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** Reads `when` into its normalized form: lowercase, days in week order with a run of three or more
 *  written as a range, all seven days as plain "HH:MM". Throws naming the accepted forms. */
export function parseWhen(input: string): Schedule {
    const bad =
        `bad schedule "${input}" — use "HH:MM" for every day (e.g. "08:00"); days then a time for days of the week ` +
        `(e.g. "mon-fri 08:00", "sat,sun 10:00", "mon,wed,fri 07:30", with three-letter English day names); ` +
        `or a date then a time for once (e.g. "2026-10-10 15:00"). Times are 24h in the agent's timezone.`;
    const m = /^(?:(.+?)\s+)?([01]\d|2[0-3]):([0-5]\d)$/.exec(input.trim().toLowerCase());
    if (!m) throw new Error(bad);
    const time = `${m[2]}:${m[3]}`;
    const minutes = Number(m[2]) * 60 + Number(m[3]);
    const head = m[1];
    if (head === undefined) return { kind: "daily", when: time, time, minutes };

    if (/^\d{4}-\d{2}-\d{2}$/.test(head)) {
        const ms = Date.parse(`${head}T00:00:00Z`);
        // Date.parse rolls "2026-02-30" over into March, so a real date reads back unchanged
        if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== head) throw new Error(bad);
        return { kind: "once", when: `${head} ${time}`, time, minutes, date: head };
    }

    const days = new Set<number>();
    for (const part of head.split(",")) {
        const r = /^\s*([a-z]{3})\s*(?:-\s*([a-z]{3})\s*)?$/.exec(part);
        const first = DAYS.indexOf(r?.[1] ?? "");
        const last = DAYS.indexOf(r?.[2] ?? r?.[1] ?? "");
        if (first < 0 || last < 0) throw new Error(bad);
        // a range may wrap the week's end: "fri-mon" is fri, sat, sun and mon
        for (let d = first; ; d = (d + 1) % 7) {
            days.add(d);
            if (d === last) break;
        }
    }
    if (days.size === 7) return { kind: "daily", when: time, time, minutes };
    const runs: string[] = [];
    for (let d = 0; d < 7; d++) {
        if (!days.has(d) || days.has(d - 1)) continue;
        let end = d;
        while (days.has(end + 1)) end++;
        runs.push(end - d >= 2 ? `${DAYS[d]}-${DAYS[end]}` : DAYS.slice(d, end + 1).join(","));
    }
    return { kind: "weekly", when: `${runs.join(",")} ${time}`, time, minutes, days: [...days] };
}

/** Whether the schedule fires on the local day "YYYY-MM-DD". */
export function firesOn(s: Schedule, day: string): boolean {
    if (s.kind === "once") return s.date === day;
    return s.kind === "daily" || s.days.includes((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7);
}

/** The local "YYYY-MM-DD HH:MM" of the next run from `today` on, or from tomorrow once today's run is
 *  `doneToday`; a one-off answers its own moment. */
export function nextRun(s: Schedule, today: string, doneToday: boolean): string {
    if (s.kind === "once") return s.when;
    const d = new Date(`${today}T00:00:00Z`);
    if (doneToday) d.setUTCDate(d.getUTCDate() + 1);
    while (!firesOn(s, d.toISOString().slice(0, 10))) d.setUTCDate(d.getUTCDate() + 1);
    return `${d.toISOString().slice(0, 10)} ${s.time}`;
}

import { test } from "node:test";
import assert from "node:assert/strict";

import { firesOn, nextRun, parseWhen } from "./schedule.ts";

test("the three forms parse into their kinds, with the time of day in minutes", () => {
    assert.deepEqual(parseWhen("08:00"), { kind: "daily", when: "08:00", time: "08:00", minutes: 480 });
    assert.deepEqual(parseWhen("mon-fri 08:00"), {
        kind: "weekly",
        when: "mon-fri 08:00",
        time: "08:00",
        minutes: 480,
        days: [0, 1, 2, 3, 4],
    });
    assert.deepEqual(parseWhen("2026-10-10 15:00"), {
        kind: "once",
        when: "2026-10-10 15:00",
        time: "15:00",
        minutes: 900,
        date: "2026-10-10",
    });
    assert.equal(parseWhen("23:59").minutes, 1439);
    assert.equal(parseWhen("00:00").minutes, 0);
});

test("days of the week take names, ranges and lists, and are stored normalized", () => {
    const norm = (when: string): string => parseWhen(when).when;
    assert.equal(norm("sat,sun 10:00"), "sat,sun 10:00");
    assert.equal(norm("sun 20:00"), "sun 20:00");
    assert.equal(norm("mon,wed,fri 07:30"), "mon,wed,fri 07:30");
    assert.equal(norm("MON-Fri 08:00"), "mon-fri 08:00");
    assert.equal(norm("  Sat , SUN   10:00 "), "sat,sun 10:00");
    assert.equal(norm("fri,wed,mon 07:30"), "mon,wed,fri 07:30");
    assert.equal(norm("mon,tue,wed 09:00"), "mon-wed 09:00"); // a run of three or more becomes a range
    assert.equal(norm("mon-tue 09:00"), "mon,tue 09:00");
    assert.equal(norm("mon - wed, fri 09:00"), "mon-wed,fri 09:00");
    assert.equal(norm("fri-mon 09:00"), "mon,fri-sun 09:00"); // a range may wrap the week's end
    assert.equal(norm("sun,sun 09:00"), "sun 09:00");
    assert.deepEqual(parseWhen("mon-sun 06:00"), parseWhen("06:00")); // every day is plain daily
    assert.deepEqual(parseWhen("sat-fri 06:00"), parseWhen("06:00"));
});

test("anything else is refused with a message naming the accepted forms", () => {
    for (const bad of [
        "",
        "8:00",
        "24:00",
        "08:60",
        "mon-fri",
        "tues 08:00",
        "monday 08:00",
        "daily 08:00",
        "mon,,fri 08:00",
        "mon-fri-sat 08:00",
        "08:00 mon",
        "2026-02-30 10:00",
        "2026-13-01 10:00",
        "2026-10-10T15:00",
        "2026-10-10",
    ])
        assert.throws(
            () => parseWhen(bad),
            /^Error: bad schedule ".*" — use "HH:MM" for every day .*"mon-fri 08:00".*"2026-10-10 15:00"/,
            bad,
        );
    assert.equal(parseWhen("2028-02-29 10:00").kind, "once"); // a leap day is a real date
});

test("a weekly schedule fires on its days only; a daily one every day; a one-off on its date", () => {
    // 2026-10-09 is a Friday
    const weekend = parseWhen("sat,sun 10:00");
    assert.deepEqual(
        ["2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12"].map((d) => firesOn(weekend, d)),
        [false, true, true, false],
    );
    assert.equal(firesOn(parseWhen("08:00"), "2026-10-10"), true);
    assert.equal(firesOn(parseWhen("2026-10-10 15:00"), "2026-10-10"), true);
    assert.equal(firesOn(parseWhen("2026-10-10 15:00"), "2026-10-11"), false);
});

test("the next run is today while today's run is pending, else the next day the schedule fires", () => {
    const daily = parseWhen("08:00");
    assert.equal(nextRun(daily, "2026-10-09", false), "2026-10-09 08:00");
    assert.equal(nextRun(daily, "2026-10-09", true), "2026-10-10 08:00");
    assert.equal(nextRun(daily, "2026-12-31", true), "2027-01-01 08:00");

    const workdays = parseWhen("mon-fri 08:00");
    assert.equal(nextRun(workdays, "2026-10-09", false), "2026-10-09 08:00"); // Friday, still to run
    assert.equal(nextRun(workdays, "2026-10-09", true), "2026-10-12 08:00"); // over the weekend to Monday
    assert.equal(nextRun(workdays, "2026-10-10", false), "2026-10-12 08:00"); // Saturday is not one of its days
    assert.equal(nextRun(parseWhen("sun 20:00"), "2026-10-11", true), "2026-10-18 20:00");

    const once = parseWhen("2026-10-10 15:00");
    assert.equal(nextRun(once, "2026-10-09", false), "2026-10-10 15:00");
    assert.equal(nextRun(once, "2026-10-10", true), "2026-10-10 15:00"); // a one-off answers its own moment
});

test("calendar math runs on local days, so a DST change does not shift the next run", () => {
    // Europe/Kyiv turns its clocks back on Sunday 2026-10-25 and forward on Sunday 2026-03-29
    assert.equal(nextRun(parseWhen("sun 03:30"), "2026-10-24", false), "2026-10-25 03:30");
    assert.equal(nextRun(parseWhen("sun 03:30"), "2026-03-28", false), "2026-03-29 03:30");
    assert.equal(nextRun(parseWhen("03:30"), "2026-10-25", true), "2026-10-26 03:30");
});

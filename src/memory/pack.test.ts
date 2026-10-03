import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { DescribePayload } from "@mimi-os/protocol";
import { runAgent } from "@mimi-os/sdk";
import type { PackDef, ToolInstance } from "@mimi-os/sdk";
import { HandshakeSocket } from "@mimi-os/sdk/testing";

import { memoryPack, wikiPack } from "./pack.ts";

const tempAgent = (): string => mkdtempSync(join(tmpdir(), "mimi-memory-"));
const memoryDir = (dir: string): string => join(dir, "data", "packs", "memory");
const memoryFile = (dir: string): string => join(memoryDir(dir), "memory.md");
const archiveFile = (dir: string): string => join(memoryDir(dir), "memory.archive.md");
const wikiDir = (dir: string): string => join(dir, "data", "packs", "wiki");

// mounts a pack the way runAgent does, with dataDir at <agent>/data/packs/<name>
function mount<P extends PackDef>(pack: P, dir: string, redescribe: () => void = () => {}): P {
    pack.mount!({
        ask: () => Promise.reject(new Error("no gateway in this test")),
        notify: () => {},
        connected: () => true,
        dataDir: join(dir, "data", "packs", pack.name),
        redescribe,
        log: () => {},
    });
    return pack;
}

const tool = (pack: PackDef, name: string): ToolInstance => pack.tools.find((t) => t.definition.function.name === name)!;

const part = (d: DescribePayload | undefined, name: string): string | undefined => d?.prompt.find((p) => p.name === name)?.text;

test("memory and wiki mount through runAgent: parts on the prompt, remember/forget never ask, a fact re-describes at once", async () => {
    const dir = tempAgent();
    writeFileSync(join(dir, "agent.json"), JSON.stringify({ name: "alpha" }));
    mkdirSync(wikiDir(dir), { recursive: true });
    writeFileSync(join(wikiDir(dir), "garden.md"), "workspace notes\n");
    const mem = memoryPack();
    const sock = new HandshakeSocket();
    const agent = await runAgent({ dir, socket: () => sock, packs: [mem, wikiPack()], log: () => undefined });
    try {
        await sock.open();
        const first = sock.describes[0];
        const writes = Object.fromEntries(first?.tools.map((t) => [t.name, t.writes]) ?? []);
        assert.deepEqual(
            { remember: writes["remember"], forget: writes["forget"], wiki_read: writes["wiki_read"], wiki_write: writes["wiki_write"] },
            { remember: false, forget: false, wiki_read: false, wiki_write: true },
        );
        assert.equal(part(first, "pack:memory"), undefined, "an empty memory adds no part");
        assert.equal(part(first, "pack:wiki"), "Wiki pages you keep (load one with wiki_read): garden");

        sock.deliver({ id: "inv-1", type: "invoke", payload: { tool: "remember", args: { fact: "tea, no sugar" } } });
        await new Promise((r) => setImmediate(r));
        assert.deepEqual(sock.replyTo("inv-1")?.payload, { text: "Remembered." });
        assert.match(readFileSync(memoryFile(dir), "utf8"), /^- \[.+\] tea, no sugar\n$/);
        assert.equal(sock.describes.length, 2);
        const described = part(sock.describes[1], "pack:memory");
        assert.match(described ?? "", /tea, no sugar {2}\([0-9a-f]{4}\)$/);
        // the agent's own code reads exactly what the model is shown
        assert.equal(mem.prompt(), described);
    } finally {
        await agent.stop();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a saved memory rides the first describe on connect, and forget over the socket takes it off at once", async () => {
    const dir = tempAgent();
    writeFileSync(join(dir, "agent.json"), JSON.stringify({ name: "alpha" }));
    mkdirSync(memoryDir(dir), { recursive: true });
    writeFileSync(memoryFile(dir), "- [2026-01-01 00:00] Ann takes her tea without sugar\n");
    const sock = new HandshakeSocket();
    const agent = await runAgent({ dir, socket: () => sock, packs: [memoryPack()], log: () => undefined });
    try {
        await sock.open();
        const first = sock.describes[0];
        const shown = part(first, "pack:memory") ?? "";
        const id = /^## Memory\n\n- \[2026-01-01 00:00\] Ann takes her tea without sugar {2}\(([0-9a-f]{4})\)$/.exec(shown)?.[1];
        assert.ok(id, shown);
        // with no wiki mounted, the tools point at nothing the agent lacks
        const told = first?.tools.filter((t) => t.name === "remember" || t.name === "forget").map((t) => t.description).join(" ");
        assert.doesNotMatch(told ?? "", /wiki|Memory section/);

        sock.deliver({ id: "inv-1", type: "invoke", payload: { tool: "forget", args: { id: `(${id})` } } });
        await new Promise((r) => setImmediate(r));
        assert.deepEqual(sock.replyTo("inv-1")?.payload, { text: "Forgotten (archived): [2026-01-01 00:00] Ann takes her tea without sugar" });
        assert.equal(readFileSync(memoryFile(dir), "utf8"), "");
        assert.match(readFileSync(archiveFile(dir), "utf8"), /^- \[.+\] forgot: \[2026-01-01 00:00\] Ann takes her tea without sugar\n$/);
        assert.equal(sock.describes.length, 2);
        assert.equal(part(sock.describes[1], "pack:memory"), undefined);
    } finally {
        await agent.stop();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a fact remembered twice in one minute is one fact to forget", async (t) => {
    const dir = tempAgent();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(memoryDir(dir), { recursive: true });
    writeFileSync(memoryFile(dir), "- [2026-01-01 00:00] tea\n- [2026-01-01 00:00] tea\n- [2026-01-01 00:00] coffee\n");
    const mem = mount(memoryPack(), dir);
    const ids = [...mem.prompt().matchAll(/\(([0-9a-f]{4})\)/g)].map((m) => m[1]);
    assert.equal(ids[0], ids[1]);

    assert.equal(await tool(mem, "forget").execute({ id: ids[0] }), "Forgotten (archived): [2026-01-01 00:00] tea");
    assert.equal(readFileSync(memoryFile(dir), "utf8"), "- [2026-01-01 00:00] coffee\n");
    assert.equal(readFileSync(archiveFile(dir), "utf8").split("\n").filter(Boolean).length, 1);

    // two different facts behind one id stay put: forget refuses to guess
    writeFileSync(memoryFile(dir), `${Array.from({ length: 1000 }, (_, i) => `- fact ${i}`).join("\n")}\n`);
    const seen = new Map<string, string>();
    let clash: string | undefined;
    for (const [, line, id] of mem.prompt().matchAll(/^(.+) {2}\(([0-9a-f]{4})\)$/gm)) {
        if (seen.has(id!)) clash = id;
        seen.set(id!, line!);
    }
    assert.ok(clash, "1000 facts share at least one 4-hex id");
    assert.match(String(await tool(mem, "forget").execute({ id: clash })), /matches 2 facts/);
    assert.equal(readFileSync(memoryFile(dir), "utf8").split("\n").filter(Boolean).length, 1000);
});

test("a memory pack read before it is mounted says so", () => {
    assert.throws(() => memoryPack().prompt(), /memory pack is not mounted/);
});

test("each fact on the prompt carries its forget id and other lines stay as written", (t) => {
    const dir = tempAgent();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(memoryDir(dir), { recursive: true });
    writeFileSync(memoryFile(dir), "- a fact\n# heading\n- another\n");
    const out = mount(memoryPack(), dir).prompt().split("\n");
    assert.deepEqual(out.slice(0, 2), ["## Memory", ""]);
    assert.match(out[2]!, /^- a fact {2}\([0-9a-f]{4}\)$/);
    assert.equal(out[3], "# heading");
    assert.match(out[4]!, /^- another {2}\([0-9a-f]{4}\)$/);
});

test("standard memory remembers, reloads, forgets, and archives one fact", async (t) => {
    const dir = tempAgent();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const mem = mount(memoryPack(), dir);

    assert.equal(await tool(mem, "remember").execute({ fact: "durable   fact" }), "Remembered.");
    const loaded = mem.prompt();
    assert.match(loaded, /durable fact/);
    const id = /\(([0-9a-f]{4})\)$/.exec(loaded)?.[1];
    assert.ok(id);

    assert.match(String(await tool(mem, "forget").execute({ id })), /Forgotten \(archived\)/);
    assert.equal(mem.prompt(), "");
    assert.match(readFileSync(archiveFile(dir), "utf8"), /forgot: .*durable fact/);
});

test("memory rejects a symlinked packs or memory directory", async (t) => {
    if (process.platform === "win32") {
        t.skip("directory symlinks require privileges on Windows");
        return;
    }
    const dir = tempAgent();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const outside = join(dir, "outside-memory");
    mkdirSync(outside);
    writeFileSync(join(outside, "memory.md"), "- should not be read\n");
    const mem = mount(memoryPack(), dir);

    mkdirSync(join(dir, "data"));
    mkdirSync(join(dir, "outside-packs"));
    symlinkSync(outside, join(dir, "outside-packs", "memory"), "dir");
    symlinkSync(join(dir, "outside-packs"), join(dir, "data", "packs"), "dir");
    assert.throws(() => mem.prompt(), /real directory/);
    await assert.rejects(async () => tool(mem, "remember").execute({ fact: "should not be written" }), /real directory/);

    rmSync(join(dir, "data", "packs"));
    mkdirSync(join(dir, "data", "packs"));
    symlinkSync(outside, memoryDir(dir), "dir");
    assert.throws(() => mem.prompt(), /real directory/);
    await assert.rejects(async () => tool(mem, "remember").execute({ fact: "should not be written" }), /real directory/);
    assert.equal(readFileSync(join(outside, "memory.md"), "utf8"), "- should not be read\n");
});

test("standard memory never follows memory or archive file symlinks", async (t) => {
    if (process.platform === "win32") {
        t.skip("symlink creation needs elevated privileges");
        return;
    }
    const dir = tempAgent();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(memoryDir(dir), { recursive: true });
    const outsideMemory = join(dir, "outside-memory.md");
    writeFileSync(outsideMemory, "- outside fact\n");
    symlinkSync(outsideMemory, memoryFile(dir));
    const mem = mount(memoryPack(), dir);

    assert.throws(() => mem.prompt(), /memory file.*regular file/i);
    await assert.rejects(async () => tool(mem, "remember").execute({ fact: "do not append" }), /memory file.*regular file/i);
    assert.equal(readFileSync(outsideMemory, "utf8"), "- outside fact\n");

    rmSync(memoryFile(dir));
    const fact = "- durable fact\n";
    writeFileSync(memoryFile(dir), fact);
    const id = /\(([0-9a-f]{4})\)/.exec(mem.prompt())?.[1];
    assert.ok(id);
    const outsideArchive = join(dir, "outside-archive.md");
    writeFileSync(outsideArchive, "archive stays unchanged\n");
    symlinkSync(outsideArchive, archiveFile(dir));

    await assert.rejects(async () => tool(mem, "forget").execute({ id }), /memory archive.*regular file/i);
    assert.equal(readFileSync(outsideArchive, "utf8"), "archive stays unchanged\n");
    assert.equal(readFileSync(memoryFile(dir), "utf8"), fact);
});

test("remember opens a new line after a hand-edited file with no trailing newline, and caps one fact", async (t) => {
    const dir = tempAgent();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(memoryDir(dir), { recursive: true });
    writeFileSync(memoryFile(dir), "- hand written fact");
    const mem = mount(memoryPack(), dir);

    assert.equal(await tool(mem, "remember").execute({ fact: "brand new fact" }), "Remembered.");
    const written = readFileSync(memoryFile(dir), "utf8").split("\n").filter(Boolean);
    assert.equal(written.length, 2);
    assert.equal(written[0], "- hand written fact");
    assert.match(written[1]!, /brand new fact$/);
    const ids = [...mem.prompt().matchAll(/\(([0-9a-f]{4})\)/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, 2);

    const refused = String(await tool(mem, "remember").execute({ fact: "z".repeat(2_001) }));
    assert.match(refused, /at most 2000 characters/);
    assert.equal(readFileSync(memoryFile(dir), "utf8").includes("zzzz"), false);
});

test("the memory prompt part stops at a byte budget and names the file to trim, never its server path", (t) => {
    const dir = tempAgent();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(memoryDir(dir), { recursive: true });
    const facts = Array.from({ length: 600 }, (_, i) => `- [2026-01-01 00:00] fact ${i} ${"q".repeat(200)}`);
    writeFileSync(memoryFile(dir), `${facts.join("\n")}\n`);

    const loaded = mount(memoryPack(), dir).prompt();
    assert.ok(Buffer.byteLength(loaded, "utf8") < 80 * 1024);
    assert.match(loaded, /older lines omitted/);
    assert.match(loaded, /memory\.md is over 65536 bytes/);
    assert.equal(loaded.includes(dir), false);
    assert.ok(loaded.includes("fact 599 "));
    assert.equal(loaded.includes("fact 0 "), false);
});

test("a wiki page over the cap is read in parts, and only a page read to its end can be replaced", async (t) => {
    const dir = tempAgent();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const wiki = mount(wikiPack(), dir);
    const read = async (args: Record<string, unknown>): Promise<string> => String(await tool(wiki, "wiki_read").execute(args));
    const write = async (args: Record<string, unknown>): Promise<string> => String(await tool(wiki, "wiki_write").execute(args));
    const page = join(wikiDir(dir), "big.md");
    mkdirSync(wikiDir(dir), { recursive: true });
    writeFileSync(page, `${"a".repeat(6_000)}${"b".repeat(3_000)}\n`);

    const head = await read({ page: "big" });
    assert.ok(head.startsWith("a".repeat(6_000)));
    assert.equal(head.includes("b"), false);
    assert.match(head, /cut at character 6000 of 9000: call wiki_read with offset 6000 .*split this one/);
    // a merged write after reading only the head would drop the tail
    assert.match(await write({ page: "big", content: "the head, merged" }), /already exists/);

    const tail = await read({ page: "big", offset: 6_000 });
    assert.ok(tail.startsWith("b".repeat(3_000)));
    assert.match(tail, /end of page "big", 9000 characters/);
    assert.match(await write({ page: "big", content: "c".repeat(6_001) }), /at most 6000 characters, this content is 6001/);
    assert.equal(await write({ page: "big", content: "what stays" }), 'Page "big" saved.');
    assert.equal(readFileSync(page, "utf8"), "what stays\n");

    writeFileSync(join(wikiDir(dir), "skipped.md"), "x".repeat(7_000));
    await read({ page: "skipped", offset: 6_000 });
    assert.match(await write({ page: "skipped", content: "blind" }), /already exists/, "a part read out of order does not count");
});

test("a new wiki page re-describes, a replaced one does not", async (t) => {
    const dir = tempAgent();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    let changes = 0;
    const wiki = mount(wikiPack(), dir, () => {
        changes++;
    });
    assert.equal(wiki.prompt!(), "");
    assert.equal(await tool(wiki, "wiki_write").execute({ page: "garden", content: "first" }), 'Page "garden" saved.');
    assert.equal(changes, 1);
    assert.equal(wiki.prompt!(), "Wiki pages you keep (load one with wiki_read): garden");
    assert.equal(await tool(wiki, "wiki_write").execute({ page: "garden", content: "second" }), 'Page "garden" saved.');
    assert.equal(changes, 1, "the index did not change");
    assert.equal(readFileSync(join(wikiDir(dir), "garden.md"), "utf8"), "second\n");
});

test("wiki memory neither advertises nor follows non-page entries", async (t) => {
    const dir = tempAgent();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const root = wikiDir(dir);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "alpha.md"), "original\n");
    writeFileSync(join(root, "bad.name.md"), "invalid name\n");
    mkdirSync(join(root, "directory.md"));
    if (process.platform !== "win32") symlinkSync("alpha.md", join(root, "linked.md"));

    const wiki = mount(wikiPack(), dir);
    assert.equal(wiki.prompt!(), "Wiki pages you keep (load one with wiki_read): alpha");
    const read = tool(wiki, "wiki_read");
    const write = tool(wiki, "wiki_write");

    if (process.platform !== "win32") {
        assert.match(String(await read.execute({ page: "linked" })), /No page "linked"/);
        assert.match(String(await write.execute({ page: "linked", content: "outside" })), /not a regular file/);
        assert.equal(readFileSync(join(root, "alpha.md"), "utf8"), "original\n");
    }

    assert.match(String(await write.execute({ page: "alpha", content: "blind replacement" })), /already exists/);
    assert.equal(readFileSync(join(root, "alpha.md"), "utf8"), "original\n");
    assert.equal(await read.execute({ page: "alpha" }), "original");
    assert.equal(await write.execute({ page: "alpha", content: "updated" }), 'Page "alpha" saved.');
    assert.equal(readFileSync(join(root, "alpha.md"), "utf8"), "updated\n");

    if (process.platform !== "win32") {
        rmSync(root, { recursive: true });
        const outside = join(dir, "outside-wiki");
        mkdirSync(outside);
        writeFileSync(join(outside, "leak.md"), "outside\n");
        symlinkSync(outside, root, "dir");
        assert.throws(() => wiki.prompt!(), /real directory/);
        await assert.rejects(async () => write.execute({ page: "new", content: "blocked" }), /real directory/);
        assert.equal(existsSync(join(outside, "new.md")), false);
    }
});

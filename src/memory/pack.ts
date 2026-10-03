/** Memory as packs: `memory` keeps one memory.md whole on every prompt, `wiki` keeps pages loaded on demand. */

import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { definePack, defineTool, writeAtomic } from "@mimi-os/sdk";
import type { PackDef, PackRuntime } from "@mimi-os/sdk";

import { appendGap, ensurePackDir, packDirExists, regularFileEntry } from "./files.ts";

const PAGE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const PAGE_MAX = 6_000;
const FACT_MAX = 2_000;
// memory rides whole on every prompt, and the prompt rides `describe` through a 1 MiB channel message.
const MEMORY_PROMPT_MAX = 64 * 1024;

function stamp(): string {
    return new Date().toISOString().slice(0, 16).replace("T", " ");
}

function isFact(line: string): boolean {
    return line.startsWith("- ");
}

// the forget handle is DERIVED from the line, never stored — nothing to migrate, and a hand-written line is addressable at once
function idOf(line: string): string {
    return createHash("sha1").update(line.trim()).digest("hex").slice(0, 4);
}

/** `facts()` is how the agent's own code reads its memory, forget ids included; `prompt()` is the same text under its heading. */
export type MemoryPack = PackDef & { prompt: () => string; facts: () => string };

export function memoryPack(): MemoryPack {
    let rt: PackRuntime | undefined;
    const mounted = (): { dir: string; file: string; archive: string; redescribe: () => void } => {
        if (!rt) throw new Error("The memory pack is not mounted: pass it to runAgent({ packs }) first.");
        const dir = rt.dataDir;
        return { dir, file: join(dir, "memory.md"), archive: join(dir, "memory.archive.md"), redescribe: rt.redescribe };
    };
    const lines = (): string[] => {
        const { dir, file } = mounted();
        if (!packDirExists(dir)) return [];
        const entry = regularFileEntry(file);
        if (entry === "missing") return [];
        if (entry === "other") throw new Error(`Memory file is not a regular file: ${file}`);
        return readFileSync(file, "utf8").split(/\r?\n/);
    };

    // each fact shows the forget id the forget tool resolves against; the newest lines win the byte budget
    const facts = (): string => {
        const rendered = lines().map((l) => (isFact(l) ? `${l}  (${idOf(l)})` : l));
        let bytes = 0;
        let from = 0;
        for (let i = rendered.length - 1; i >= 0; i--) {
            bytes += Buffer.byteLength(rendered[i]!, "utf8") + 1;
            if (bytes > MEMORY_PROMPT_MAX) {
                from = i + 1;
                break;
            }
        }
        const kept = rendered.slice(from).join("\n").trim();
        if (from === 0) return kept;
        // the file name, never its path: this text can reach a group chat
        return `[older lines omitted: memory.md is over ${MEMORY_PROMPT_MAX} bytes — forget what no longer holds, or trim the file]\n${kept}`;
    };
    // its own heading, so the facts never read as part of whatever section the persona ends with
    const prompt = (): string => {
        const text = facts();
        return text ? `## Memory\n\n${text}` : "";
    };

    const remember = defineTool(
        "remember",
        "Save one short durable fact to your persistent memory — it will be in your " +
            "context in every future session. One self-contained fact per call; not for " +
            "transient task state.",
        {
            type: "object",
            properties: {
                fact: {
                    type: "string",
                    description: "One self-contained fact, ideally a single sentence.",
                },
            },
            required: ["fact"],
        },
        (args) => {
            const fact = String(args["fact"] ?? "").trim();
            if (!fact) return "Error: pass a non-empty fact.";
            if (fact.length > FACT_MAX) {
                return `Error: one fact is at most ${FACT_MAX} characters, this one is ${fact.length}. Shorten it.`;
            }
            const { dir, file, redescribe } = mounted();
            ensurePackDir(dir);
            if (regularFileEntry(file) === "other") {
                throw new Error(`Memory file is not a regular file: ${file}`);
            }
            // collapse whitespace: one fact is one bullet, never extra markdown sections
            appendFileSync(file, `${appendGap(file)}- [${stamp()}] ${fact.replace(/\s+/g, " ")}\n`, "utf8");
            redescribe(); // the new fact (and its forget id) enters the prompt now
            return "Remembered.";
        },
    );

    const forget = defineTool(
        "forget",
        "Remove ONE fact from your persistent memory by its id — the short code in " +
            "parentheses after each remembered fact. The fact is archived, " +
            "not destroyed; say what you forgot in your answer.",
        {
            type: "object",
            properties: {
                id: {
                    type: "string",
                    description: 'The id shown beside the fact, e.g. "a3f0".',
                },
            },
            required: ["id"],
        },
        (args) => {
            const id = String(args["id"] ?? "")
                .trim()
                .replace(/^\(|\)$/g, "") // the model may copy the parentheses along
                .toLowerCase();
            if (!id) return "Error: pass the id shown beside the fact.";
            const all = lines();
            const hits = all.filter((l) => isFact(l) && idOf(l) === id);
            if (hits.length === 0) {
                return `Error: no fact with id "${id}". The id is the code in parentheses after each remembered fact.`;
            }
            // a 4-hex digest can collide — refuse rather than guess which one to drop; the same line twice is one fact
            const distinct = new Set(hits.map((l) => l.trim())).size;
            if (distinct > 1) {
                return `Error: id "${id}" matches ${distinct} facts. Rephrase one with remember first.`;
            }
            const fact = hits[0]!.slice(2);
            const { dir, file, archive, redescribe } = mounted();
            ensurePackDir(dir);
            if (regularFileEntry(archive) === "other") {
                throw new Error(`Memory archive is not a regular file: ${archive}`);
            }
            appendFileSync(archive, `${appendGap(archive)}- [${stamp()}] forgot: ${fact}\n`, "utf8");
            writeAtomic(file, all.filter((l) => !hits.includes(l)).join("\n"));
            redescribe(); // the forgotten fact leaves the prompt now
            return `Forgotten (archived): ${fact}`;
        },
    );

    const pack = definePack({
        name: "memory",
        tools: [remember, forget],
        prompt,
        mount: (r) => {
            rt = r;
        },
    });
    return { ...pack, prompt, facts };
}

export function wikiPack(): PackDef {
    let rt: PackRuntime | undefined;
    const mounted = (): { dir: string; redescribe: () => void } => {
        if (!rt) throw new Error("The wiki pack is not mounted: pass it to runAgent({ packs }) first.");
        return { dir: rt.dataDir, redescribe: rt.redescribe };
    };
    // how far into each page this process has shown the model, contiguously from the start; a replace needs all of it
    const readTo = new Map<string, number>();
    const pageNames = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
            .map((entry) => entry.name.slice(0, -3))
            .filter((page) => PAGE_NAME.test(page))
            .sort();
    const badName = (page: string): string | null =>
        PAGE_NAME.test(page) ? null : `Error: invalid page name "${page}" — use a short slug.`;

    const read = defineTool(
        "wiki_read",
        "Read one page of your wiki memory by name. The page list is in your instructions. " +
            `Use it when the user refers to a topic you keep notes on. One read returns ` +
            `at most ${PAGE_MAX} characters; a longer page says where to continue.`,
        {
            type: "object",
            properties: {
                page: { type: "string", description: 'Page name from the index, e.g. "garden".' },
                offset: {
                    type: "integer",
                    description: "Character to start at, for the rest of a long page. Default 0.",
                },
            },
            required: ["page"],
        },
        (args) => {
            const page = String(args["page"] ?? "").trim();
            const bad = badName(page);
            if (bad) return bad;
            const { dir } = mounted();
            const file = join(dir, `${page}.md`);
            const hasWiki = packDirExists(dir);
            if (!hasWiki || regularFileEntry(file) !== "file") {
                const p = hasWiki ? pageNames(dir) : [];
                return `No page "${page}". ${p.length ? `Pages: ${p.join(", ")}` : "The wiki is empty."}`;
            }
            const text = readFileSync(file, "utf8").trim();
            const offset = Math.min(Math.max(0, Math.trunc(Number(args["offset"])) || 0), text.length);
            const end = Math.min(text.length, offset + PAGE_MAX);
            const before = readTo.get(page) ?? 0;
            if (offset <= before) readTo.set(page, Math.max(before, end));
            if (offset === 0 && end === text.length) return text;
            if (end === text.length) return `${text.slice(offset)}\n…[end of page "${page}", ${text.length} characters]`;
            return (
                `${text.slice(offset, end)}\n…[cut at character ${end} of ${text.length}: call wiki_read ` +
                `with offset ${end} for the rest. A page holds at most ${PAGE_MAX} characters, so split this ` +
                `one: move whole topics into new pages, then rewrite this page down to what stays.]`
            );
        },
    );

    const write = defineTool(
        "wiki_write",
        "Create or REPLACE one page of your wiki memory — durable topic knowledge too big for " +
            `\`remember\`. Keep pages small and topical, at most ${PAGE_MAX} characters. To change a page ` +
            "that ALREADY EXISTS you must call wiki_read on all of it first: this replaces the whole " +
            "file, so write the merged old + new content.",
        {
            type: "object",
            properties: {
                page: { type: "string", description: 'Short slug, e.g. "garden".' },
                content: { type: "string", description: "The full new markdown content." },
            },
            required: ["page", "content"],
        },
        (args) => {
            const page = String(args["page"] ?? "").trim();
            const bad = badName(page);
            if (bad) return bad;
            const content = String(args["content"] ?? "").trim();
            if (!content) return "Error: pass non-empty content (pages are replaced whole).";
            if (content.length > PAGE_MAX) {
                return `Error: a page holds at most ${PAGE_MAX} characters, this content is ${content.length}. Split it into smaller topical pages.`;
            }
            const { dir, redescribe } = mounted();
            const file = join(dir, `${page}.md`);
            ensurePackDir(dir);
            const entry = regularFileEntry(file);
            if (entry === "other") {
                return `Error: page "${page}" is not a regular file.`;
            }
            // creating destroys nothing; replacing blind does — refuse until all of it has been read
            if (entry === "file" && (readTo.get(page) ?? -1) < readFileSync(file, "utf8").trim().length) {
                return (
                    `Error: page "${page}" already exists and this would REPLACE it whole. ` +
                    `Call wiki_read("${page}") first, every part of it, then write the merged content.`
                );
            }
            writeAtomic(file, `${content}\n`);
            readTo.set(page, content.length);
            if (entry !== "file") redescribe(); // a new page changes the index that rides the prompt
            return `Page "${page}" saved.`;
        },
        { writes: true },
    );

    return definePack({
        name: "wiki",
        toolPrefix: "wiki",
        tools: [read, write],
        prompt: () => {
            const { dir } = mounted();
            const pages = packDirExists(dir) ? pageNames(dir) : [];
            return pages.length ? `Wiki pages you keep (load one with wiki_read): ${pages.join(", ")}` : "";
        },
        mount: (r) => {
            rt = r;
        },
    });
}

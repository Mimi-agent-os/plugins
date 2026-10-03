# memory and wiki

Two packs that share this folder and its file rules (`files.ts`). Mount either or both. Back to
[plugins](../../README.md); the pack API is in the [sdk](https://github.com/Mimi-agent-os/sdk).

## memory

Short durable facts. The whole list is on every system prompt, in the section `pack:memory`, each
fact followed by a 4-hex id. The model adds a fact with `remember` and drops one by id with `forget`.

```ts
const mem = memory();
await runAgent({ packs: [mem] });
```

`memory()` returns a `MemoryPack`: the pack plus `facts()` (the memory text, ids included) and
`prompt()` (the same text under `## Memory`, or `""` when empty), for the agent's own `rt.ask`
calls. Call them after `runAgent()` has mounted the pack; before that they throw.

| Tool | Arguments | Does |
| --- | --- | --- |
| `remember` | `fact` | Appends `- [YYYY-MM-DD HH:MM] <fact>` (UTC) to `memory.md`. At most 2000 characters. |
| `forget` | `id` | Moves the fact to `memory.archive.md`. An id that two different facts share returns an error. |

Both apply directly, without an approval step, and send the updated prompt to the gateway, so the
model sees the change at once.

Data in `data/packs/memory/`: `memory.md`, one fact per `- ` line, fine to edit by hand, and
`memory.archive.md`, every forgotten fact. An id is the first 4 hex digits of the line's SHA-1,
computed on each read, so editing a line changes its id. The prompt carries the newest 64 KiB of lines.

## wiki

Topic pages for what is longer than a fact. The system prompt lists the page names, in the section
`pack:wiki`. The model reads a page with `wiki_read` and writes one whole with `wiki_write`.

```ts
await runAgent({ packs: [memory(), wiki()] });
```

A page name is 1 to 64 letters, digits, `-` or `_`, starting with a letter or digit.

| Tool | Arguments | Does |
| --- | --- | --- |
| `wiki_read` | `page`, `offset` (default 0) | Returns up to 6000 characters from `offset`; a cut part names the next offset. |
| `wiki_write` | `page`, `content` | Creates or replaces the whole page, at most 6000 characters. Replacing needs a full read of that page in this process first. |

`wiki_write` waits for the owner's approval unless the agent lists it in `runAgent({ unasked })`.

Data in `data/packs/wiki/<page>.md`, one file per page. Pages are renamed or deleted by hand in this
folder, and a page written by hand with a valid name joins the index. The index follows the folder
each time the agent sends its prompt to the gateway: on connect, or when the model changes its memory
or adds a page.

## File rules

Every folder from the agent's `data/` down to the pack's own must be a real directory: a symlink
there makes the prompt and the tools throw. `memory.md` and `memory.archive.md` must be regular
files, and the wiki lists and reads pages that are regular files. Files are replaced atomically or appended.

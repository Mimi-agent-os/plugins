# @mimi-os/plugins

[![CI](https://github.com/Mimi-agent-os/plugins/actions/workflows/ci.yml/badge.svg)](https://github.com/Mimi-agent-os/plugins/actions/workflows/ci.yml)

Ready-made features for mimi-os agents: long-term memory, a wiki of topic pages and scheduled routines.
You add them to an agent written with the sdk, one line each, in `runAgent({ packs })`.
mimi-os is a personal agent runtime (a gateway, agents and an app); this package builds on sdk and protocol.

Requires Node.js 24 or newer and pnpm (`corepack enable pnpm`).

## Plugins

Each plugin is a pack (the sdk's `definePack()`): tools for the model, text on the system prompt, and a
data folder under the agent.

- [`memory()`](src/memory/README.md#memory): short facts kept whole on every prompt; tools `remember`, `forget`.
- [`wiki()`](src/memory/README.md#wiki): topic pages the model loads on demand; tools `wiki_read`, `wiki_write`.
- [`cron({ tz, jobs, run })`](src/crons/README.md): routines that run every day, on days of the week or once,
  which the model can list and edit; tools `cron_look`, `cron_add`, `cron_edit`, `cron_remove`, `cron_run_now`.

## Where it sits

The `agents` and `devkit` profiles of `mimi-launch` clone it as `plugins/`; the build runs it after sdk.
It links `@mimi-os/sdk` and `@mimi-os/protocol` as `link:../sdk` and `link:../protocol`. An agent adds it
with `pnpm add link:<workspace>/plugins`. The exports point at `dist/`, so a consumer sees a change to
`src/` after `pnpm build`.

## Commands

Build protocol and sdk first.

```sh
pnpm install
pnpm build    # clean, then tsc into dist/
pnpm check    # tsc, no emit
pnpm test     # node --test "src/**/*.test.ts"
pnpm clean    # delete dist/
```

## Mount

```ts
import { cron, memory, wiki } from "@mimi-os/plugins";
import { runAgent } from "@mimi-os/sdk";

await runAgent({
    packs: [
        memory(),
        wiki(),
        cron({ tz: "America/New_York", run: (job, rt) => rt.ask(job.instruction).then((r) => r.text) }),
    ],
});
```

Type exports: `CronJob`, `MemoryPack`. Each pack keeps its files in `data/packs/<name>/` in the
agent's folder (`MIMI_DATA_DIR` in the agent's `.env` moves `data/`) and puts its text in a section
of the system prompt named `pack:<name>`.

A new plugin gets a folder under `src/`, an export in `src/index.ts` and a `README.md` beside its code.

## See also

- [sdk](https://github.com/Mimi-agent-os/sdk): `runAgent`, `definePack`, `PackRuntime`, and a minimal
  agent to mount these packs on ([on the wiki](https://mimi-agent-os.github.io/wiki/#/sdk)).
- [launch](https://github.com/Mimi-agent-os/launch): the workspace and its profiles.

Licensed under Apache-2.0, see LICENSE.

/** The filesystem rules the memory packs share: real directories only, regular files only, whole writes. */

import { closeSync, lstatSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { dirname } from "node:path";

import { realDirExists } from "@mimi-os/sdk";

/** <agent>/data, data/packs and the pack's own folder all exist as real directories; a symlink among them throws. */
export function packDirExists(packDir: string): boolean {
    return [dirname(dirname(packDir)), dirname(packDir), packDir].every(realDirExists);
}

/** Create the folders packDirExists checks, top down, refusing a symlink at any level before writing below it. */
export function ensurePackDir(packDir: string): void {
    for (const dir of [dirname(dirname(packDir)), dirname(packDir), packDir]) {
        mkdirSync(dir, { recursive: true });
        if (!realDirExists(dir)) throw new Error(`Directory was not created: ${dir}`);
    }
}

export function regularFileEntry(file: string): "file" | "other" | "missing" {
    try {
        return lstatSync(file).isFile() ? "file" : "other";
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
        throw error;
    }
}

/** A hand-edited file may end without a newline, and appending then fuses two lines into one. */
export function appendGap(file: string): string {
    const size = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
    if (size === 0) return "";
    const fd = openSync(file, "r");
    try {
        const tail = Buffer.alloc(1);
        readSync(fd, tail, 0, 1, size - 1);
        return tail[0] === 0x0a ? "" : "\n";
    } finally {
        closeSync(fd);
    }
}

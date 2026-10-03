import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { hostContract, type Worktree } from "./contract.js";

const exec = promisify(execFile);

async function run(file: string, args: string[], signal?: AbortSignal) {
  const { stdout } = await exec(file, args, {
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
    signal,
  });
  return stdout;
}

/** `git worktree add` writes the worktree's `.git` file, so its birth time is
 * when the worktree was created. Git itself keeps no such record. */
async function createdAt(path: string): Promise<number | null> {
  const { birthtimeMs } = await stat(join(path, ".git")).catch(() => ({
    birthtimeMs: 0,
  }));
  return birthtimeMs > 0 ? birthtimeMs : null;
}

async function readWorktrees(porcelain: string): Promise<Worktree[]> {
  const worktrees: Promise<Worktree>[] = [];
  for (const block of porcelain.split("\n\n")) {
    const fields = new Map<string, string>();
    for (const line of block.split("\n")) {
      const space = line.indexOf(" ");
      if (space === -1) fields.set(line, "");
      else fields.set(line.slice(0, space), line.slice(space + 1));
    }
    const path = fields.get("worktree");
    if (!path || fields.has("bare") || fields.has("prunable")) continue;
    worktrees.push(
      createdAt(path).then((created) => ({
        path,
        branch: fields.get("branch")?.replace(/^refs\/heads\//, "") ?? null,
        head: (fields.get("HEAD") ?? "").slice(0, 8),
        createdAt: created,
      })),
    );
  }
  return Promise.all(worktrees);
}

const pane = (session: string) => `=${session}:`;

async function sessionNames(signal?: AbortSignal): Promise<string[]> {
  try {
    const out = await run(
      "tmux",
      ["list-sessions", "-F", "#{session_name}"],
      signal,
    );
    return out.split("\n").filter(Boolean);
  } catch (cause) {
    // No tmux server yet means no sessions, not a failure.
    if (/no server running|error connecting to/.test(String(cause))) return [];
    throw cause;
  }
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    worktrees: async ({ repoPath }, { signal }) => ({
      worktrees: await readWorktrees(
        await run(
          "git",
          ["-C", repoPath, "worktree", "list", "--porcelain"],
          signal,
        ),
      ),
    }),
    sessions: async (_input, { signal }) => ({
      sessions: await sessionNames(signal),
    }),
    start: async ({ session, cwd, command }, { signal }) => {
      if ((await sessionNames(signal)).includes(session)) {
        throw new Error(`tmux session "${session}" is already running`);
      }
      // A login shell keeps the user's PATH, and the pane survives a crash so
      // the logs stay readable.
      await run("tmux", ["new-session", "-d", "-s", session, "-c", cwd], signal);
      await run("tmux", ["send-keys", "-t", pane(session), "-l", command], signal);
      await run("tmux", ["send-keys", "-t", pane(session), "Enter"], signal);
      return null;
    },
    stop: async ({ session }, { signal }) => {
      if (!(await sessionNames(signal)).includes(session)) return null;
      await run("tmux", ["send-keys", "-t", pane(session), "C-c"], signal);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await run("tmux", ["kill-session", "-t", `=${session}`], signal).catch(
        () => undefined,
      );
      return null;
    },
    capture: async ({ session, lines }, { signal }) => {
      const out = await run(
        "tmux",
        ["capture-pane", "-p", "-J", "-t", pane(session), "-S", `-${lines}`],
        signal,
      );
      return { text: out.replace(/\s+$/, "") };
    },
  },
});

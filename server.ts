import { basename, dirname } from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostContract, worktreeSchema, type Worktree } from "./contract.js";

const worktreeRowSchema = worktreeSchema.extend({
  session: z.string(),
  primary: z.boolean(),
  running: z.boolean(),
  url: z.string().nullable(),
  lastLine: z.string().nullable(),
});
export type WorktreeRow = z.infer<typeof worktreeRowSchema>;

const target = z.object({ projectId: z.string(), path: z.string() });

export const rpcContract = defineRpcContract({
  projects: {
    input: z.null(),
    output: z.object({
      projects: z.array(z.object({ id: z.string(), name: z.string() })),
    }),
  },
  worktrees: {
    input: z.object({ projectId: z.string() }),
    output: z.object({ worktrees: z.array(worktreeRowSchema) }),
  },
  start: { input: target, output: z.null() },
  stop: { input: target, output: z.null() },
  logs: {
    input: target,
    output: z.object({ text: z.string() }),
  },
  checkRemove: {
    input: target,
    output: z.object({
      /** Why this worktree can't be deleted here, or null when it can. */
      blocked: z.string().nullable(),
      changes: z.number().int(),
      usedByBb: z.boolean(),
    }),
  },
  remove: {
    input: target.extend({ force: z.boolean() }),
    output: z.null(),
  },
});

const LOG_LINES = 400;
const URL_PATTERN = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+/;

/** tmux names can't hold "." or ":"; bb's own worktrees all end in the repo
 * name, so those borrow their parent folder to stay unique. */
function sessionName(repoPath: string, path: string): string {
  const name =
    path !== repoPath && basename(path) === basename(repoPath)
      ? `${basename(dirname(path))}-${basename(path)}`
      : basename(path);
  return name.replace(/[^A-Za-z0-9_-]+/g, "-");
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    devCommand: {
      type: "string",
      label: "Dev command",
      description: "Typed into the worktree's tmux session by Start.",
      default: "pnpm dev",
    },
  });
  const host = bb.hosts.experimental_client({ contract: hostContract });

  async function projectSource(projectId: string) {
    const project = await bb.sdk.projects.get({ projectId });
    const source =
      project.sources.find((candidate) => candidate.isDefault) ??
      project.sources[0];
    if (!source) throw new Error(`${project.name} has no local source`);
    return { project, hostId: source.hostId, repoPath: source.path };
  }

  async function listWorktrees(hostId: string, repoPath: string) {
    const { worktrees } = await host.call(
      "worktrees",
      { repoPath },
      { hostId },
    );
    return worktrees;
  }

  /** Only paths git reports for this project are ever handed to tmux. */
  async function resolve(projectId: string, path: string) {
    const { hostId, repoPath } = await projectSource(projectId);
    const worktree = (await listWorktrees(hostId, repoPath)).find(
      (candidate) => candidate.path === path,
    );
    if (!worktree) throw new Error(`${path} is not a worktree of this project`);
    return { hostId, repoPath, path, session: sessionName(repoPath, path) };
  }

  /** Every reason deletion is unsafe is checked here, on each attempt. */
  async function removal(projectId: string, path: string) {
    const target = await resolve(projectId, path);
    const [{ sessions }, environments, { count }] = await Promise.all([
      host.call("sessions", null, { hostId: target.hostId }),
      bb.sdk.environments.list({ projectId, path }),
      host.call("changes", { path }, { hostId: target.hostId }),
    ]);
    const live = environments.filter(
      (environment) => environment.lifecycle.phase !== "destroyed",
    );
    const blocked =
      path === target.repoPath
        ? "This is the main checkout, so it can't be deleted."
        : sessions.includes(target.session)
          ? "Stop its dev server first."
          : live.some((environment) => environment.managed)
            ? "A bb thread owns this worktree. Archive the thread to remove it."
            : null;
    return { target, blocked, changes: count, usedByBb: live.length > 0 };
  }

  async function peek(hostId: string, session: string) {
    const capture = await host
      .call("capture", { session, lines: 2000 }, { hostId })
      .catch(() => null);
    const lines = capture?.text.split("\n").filter((line) => line.trim());
    return {
      url: capture?.text.match(URL_PATTERN)?.[0] ?? null,
      lastLine: lines?.at(-1)?.trim() ?? null,
    };
  }

  async function worktreeRows(projectId: string): Promise<WorktreeRow[]> {
    const { hostId, repoPath } = await projectSource(projectId);
    const [worktrees, { sessions }] = await Promise.all([
      listWorktrees(hostId, repoPath),
      host.call("sessions", null, { hostId }),
    ]);
    const running = new Set(sessions);
    const rows = await Promise.all(
      worktrees.map(async (worktree: Worktree) => {
        const session = sessionName(repoPath, worktree.path);
        const isRunning = running.has(session);
        return {
          ...worktree,
          session,
          primary: worktree.path === repoPath,
          running: isRunning,
          ...(isRunning
            ? await peek(hostId, session)
            : { url: null, lastLine: null }),
        };
      }),
    );
    rows.sort(
      (a, b) =>
        Number(b.primary) - Number(a.primary) ||
        (b.createdAt ?? 0) - (a.createdAt ?? 0) ||
        a.path.localeCompare(b.path),
    );
    return rows;
  }

  bb.rpc.register(rpcContract, {
    projects: async () => ({
      projects: (await bb.sdk.projects.list()).map(({ id, name }) => ({
        id,
        name,
      })),
    }),
    worktrees: async ({ projectId }) => ({
      worktrees: await worktreeRows(projectId),
    }),
    start: async ({ projectId, path }) => {
      const { hostId, session } = await resolve(projectId, path);
      const { devCommand } = await settings.get();
      return host.call(
        "start",
        { session, cwd: path, command: devCommand },
        { hostId },
      );
    },
    stop: async ({ projectId, path }) => {
      const { hostId, session } = await resolve(projectId, path);
      return host.call("stop", { session }, { hostId });
    },
    logs: async ({ projectId, path }) => {
      const { hostId, session } = await resolve(projectId, path);
      return host.call("capture", { session, lines: LOG_LINES }, { hostId });
    },
    checkRemove: async ({ projectId, path }) => {
      const { blocked, changes, usedByBb } = await removal(projectId, path);
      return { blocked, changes, usedByBb };
    },
    remove: async ({ projectId, path, force }) => {
      const { target, blocked, changes } = await removal(projectId, path);
      if (blocked) throw new Error(blocked);
      if (changes > 0 && !force) {
        throw new Error(
          `${changes} uncommitted ${changes === 1 ? "change" : "changes"} would be lost`,
        );
      }
      return host.call(
        "remove",
        { repoPath: target.repoPath, path, force },
        { hostId: target.hostId },
      );
    },
  });
}

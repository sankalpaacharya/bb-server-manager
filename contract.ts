import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const worktreeSchema = z.object({
  path: z.string(),
  branch: z.string().nullable(),
  head: z.string(),
  /** Epoch ms; null when the filesystem doesn't record creation times. */
  createdAt: z.number().nullable(),
});
export type Worktree = z.infer<typeof worktreeSchema>;

const sessionTarget = z.object({ session: z.string().min(1) });

// What the server asks the machine that holds the repo to do.
export const hostContract = defineRpcContract({
  worktrees: {
    input: z.object({ repoPath: z.string().min(1) }),
    output: z.object({ worktrees: z.array(worktreeSchema) }),
  },
  sessions: {
    input: z.null(),
    output: z.object({ sessions: z.array(z.string()) }),
  },
  start: {
    input: sessionTarget.extend({
      cwd: z.string().min(1),
      command: z.string().min(1),
    }),
    output: z.null(),
  },
  stop: {
    input: sessionTarget,
    output: z.null(),
  },
  capture: {
    input: sessionTarget.extend({ lines: z.number().int().min(1).max(5000) }),
    output: z.object({ text: z.string() }),
  },
});

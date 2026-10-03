# bb-server-manager

A bb plugin that adds a **Worktrees** page to the sidebar. Pick a project from
the dropdown to see its git worktrees and run each one's dev server in its own
tmux session.

- Worktrees are split into **Running** and **Stopped**. Each running server
  shows its latest output line as it changes.
- The filter box narrows the list by branch or folder name.
- Tick worktrees (shift-click for a range) to start or delete several at once.
- **Start dev** opens a detached tmux session in the worktree and types the dev
  command (default `pnpm dev`). The pane is a normal shell, so it stays open
  if the server crashes.
- **Logs** tails the session live inside the page.
- The first `localhost:<port>` URL the server prints shows up as a link.
- The logs panel shows `tmux attach -t <session>` with a copy button, so you
  can open the same session in any terminal.
- **Stop** sends Ctrl-C, then closes the session.

Session names come from the worktree folder (`cops.submissions-fifo` becomes
`cops-submissions-fifo`). bb-created worktrees, which all end in the repo
name, use their parent folder too (`thr_abc-1-cops`).

## Requirements

`git` and `tmux` on the machine that holds the project.

## Install

```sh
bb plugin install git:https://github.com/sankalpaacharya/bb-server-manager
```

Or from a local checkout:

```sh
npm install
bb plugin install .
```

## Configure

```sh
bb plugin config worktrees set devCommand "pnpm dev"
```

## Layout

- `contract.ts`: RPC contract between the server and the host worker.
- `host.ts`: runs on the project's machine. Calls `git worktree list` and
  `tmux` with `execFile`, never through a shell.
- `server.ts`: resolves projects through `bb.sdk`, checks that every requested
  path is one of the project's worktrees, and exposes the page's RPC.
- `app.tsx`: the Worktrees page.

## Develop

```sh
npm install
npx tsc -p .
bb plugin dev
```

See every git worktree of every project in one place, and run each one's dev
server without juggling terminals.

## What you get

- A **Worktrees** page in the sidebar, grouped by project.
- One click starts a worktree's dev command in its own tmux session.
- Live logs in the page, the server's localhost link, and a copyable
  `tmux attach` command to open the session in any terminal.

## How it works

The plugin asks the machine that holds each project for `git worktree list`,
and drives `tmux` there. Nothing leaves the machine. It needs `git` and `tmux`
installed, and no account or API key.

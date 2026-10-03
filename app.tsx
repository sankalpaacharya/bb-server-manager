import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { definePluginApp, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { WorktreeRow, rpcContract } from "./server";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

const WORKTREES_POLL_MS = 3000;
const LOGS_POLL_MS = 1500;

type Project = { id: string; name: string };

const messageOf = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

const displayPath = (path: string) => path.replace(/^\/home\/[^/]+/, "~");

const label = (worktree: WorktreeRow) =>
  worktree.branch ?? `Detached at ${worktree.head}`;

function usePolling(callback: () => void, intervalMs: number) {
  useEffect(() => {
    callback();
    const timer = setInterval(callback, intervalMs);
    return () => clearInterval(timer);
  }, [callback, intervalMs]);
}

function useProjects() {
  const rpc = useRpc<typeof rpcContract>();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    rpc.call("projects").then(
      (result) => setProjects(result.projects),
      (cause) => setError(messageOf(cause)),
    );
  }, [rpc]);
  return { projects, error };
}

function useWorktrees(projectId: string) {
  const rpc = useRpc<typeof rpcContract>();
  const [worktrees, setWorktrees] = useState<WorktreeRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("worktrees", { projectId }).then(
      (result) => {
        setWorktrees(result.worktrees);
        setError(null);
      },
      (cause) => setError(messageOf(cause)),
    );
  }, [rpc, projectId]);
  usePolling(refetch, WORKTREES_POLL_MS);
  return { worktrees, error, refetch };
}

/** start/stop with a pending flag; errors surface as a toast. */
function useServerAction(
  projectId: string,
  worktree: WorktreeRow,
  onDone: () => void,
) {
  const rpc = useRpc<typeof rpcContract>();
  const [pending, setPending] = useState<"start" | "stop" | null>(null);
  const run = async (method: "start" | "stop") => {
    setPending(method);
    try {
      await rpc.call(method, { projectId, path: worktree.path });
      onDone();
    } catch (cause) {
      toast.error(messageOf(cause));
    } finally {
      setPending(null);
    }
  };
  return { pending, run };
}

function LogView({
  projectId,
  path,
  session,
}: {
  projectId: string;
  path: string;
  session: string;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [text, setText] = useState<string | null>(null);
  const ref = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);
  const attach = `tmux attach -t ${session}`;
  const fetchLogs = useCallback(() => {
    rpc.call("logs", { projectId, path }).then(
      (result) => setText(result.text),
      (cause) => setText(messageOf(cause)),
    );
  }, [rpc, projectId, path]);
  usePolling(fetchLogs, LOGS_POLL_MS);
  useEffect(() => {
    const element = ref.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [text]);
  return (
    <div className="mt-3 overflow-hidden rounded-md border border-border">
      <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
        <span className="truncate">
          Open in a terminal with{" "}
          <code className="text-foreground">{attach}</code>
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 px-2"
          onClick={() => {
            void navigator.clipboard.writeText(attach);
            toast.success("Copied");
          }}
        >
          <Icon name="Copy" />
          Copy
        </Button>
      </div>
      <pre
        ref={ref}
        tabIndex={0}
        aria-label="Dev server output"
        onScroll={(event) => {
          const element = event.currentTarget;
          pinned.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            24;
        }}
        className="max-h-96 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] bg-muted/40 p-3 font-mono text-xs leading-relaxed text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
      >
        {text ?? "Waiting for output…"}
      </pre>
    </div>
  );
}

const shortDate = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

/** Compact age for the right-hand column: 5m, 17h, 3d, then a date. */
function shortAge(ms: number): string {
  const minutes = Math.floor((Date.now() - ms) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return shortDate.format(ms);
}

function Age({ worktree }: { worktree: WorktreeRow }) {
  if (worktree.createdAt === null) return <span className="w-12 shrink-0" />;
  const verb = worktree.primary ? "Cloned" : "Created";
  return (
    <time
      dateTime={new Date(worktree.createdAt).toISOString()}
      title={`${verb} ${new Date(worktree.createdAt).toLocaleString()}`}
      className="w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground"
    >
      {shortAge(worktree.createdAt)}
    </time>
  );
}

/** The owner prefix ("sanku/") repeats on every row, so it recedes. */
function BranchName({ worktree }: { worktree: WorktreeRow }) {
  const slash = worktree.branch?.indexOf("/") ?? -1;
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      <span className="truncate text-sm" title={label(worktree)}>
        {worktree.branch && slash > 0 ? (
          <>
            <span className="text-muted-foreground">
              {worktree.branch.slice(0, slash + 1)}
            </span>
            {worktree.branch.slice(slash + 1)}
          </>
        ) : (
          label(worktree)
        )}
      </span>
      {worktree.primary ? (
        <span className="shrink-0 rounded border border-border px-1.5 text-[11px] leading-4 text-muted-foreground">
          main checkout
        </span>
      ) : null}
    </span>
  );
}

function RunningRow({
  projectId,
  worktree,
  showLogs,
  onToggleLogs,
  onChanged,
}: {
  projectId: string;
  worktree: WorktreeRow;
  showLogs: boolean;
  onToggleLogs: () => void;
  onChanged: () => void;
}) {
  const navigate = useBbNavigate();
  const { pending, run } = useServerAction(projectId, worktree, onChanged);
  return (
    <li className="px-4 py-3" title={displayPath(worktree.path)}>
      <div className="flex items-center gap-3">
        <span className="relative flex size-2 shrink-0" aria-label="Running">
          <span className="absolute inline-flex size-full rounded-full bg-emerald-500 opacity-60 motion-safe:animate-ping" />
          <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
        </span>
        <div className="min-w-0 flex-1">
          <BranchName worktree={worktree} />
          <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
            {worktree.lastLine ?? "Starting…"}
          </p>
        </div>
        {worktree.url ? (
          <Button
            variant="link"
            size="sm"
            className="px-1 text-foreground"
            onClick={() => navigate.openUrl(worktree.url ?? "")}
          >
            {worktree.url.replace(/^https?:\/\//, "")}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={showLogs}
          aria-pressed={showLogs}
          onClick={onToggleLogs}
        >
          Logs
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          disabled={pending !== null}
          onClick={() => run("stop")}
        >
          {pending === "stop" ? "Stopping…" : "Stop"}
        </Button>
      </div>
      {showLogs ? (
        <LogView
          projectId={projectId}
          path={worktree.path}
          session={worktree.session}
        />
      ) : null}
    </li>
  );
}

type RemovalCheck = { blocked: string | null; changes: number; usedByBb: boolean };

function DeleteWorktreeDialog({
  projectId,
  worktree,
  open,
  onOpenChange,
  onDeleted,
}: {
  projectId: string;
  worktree: WorktreeRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [check, setCheck] = useState<RemovalCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    if (!open) return;
    setCheck(null);
    setError(null);
    rpc.call("checkRemove", { projectId, path: worktree.path }).then(
      setCheck,
      (cause) => setError(messageOf(cause)),
    );
  }, [open, rpc, projectId, worktree.path]);
  const remove = async () => {
    if (!check) return;
    setDeleting(true);
    try {
      await rpc.call("remove", {
        projectId,
        path: worktree.path,
        force: check.changes > 0,
      });
      toast.success(`Deleted ${displayPath(worktree.path)}`);
      onOpenChange(false);
      onDeleted();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setDeleting(false);
    }
  };
  const canDelete = check !== null && check.blocked === null && !error;
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {check?.blocked ? "Can't delete this worktree" : "Delete this worktree?"}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3 text-sm text-muted-foreground">
              {error ? (
                <p className="text-destructive">{error}</p>
              ) : check === null ? (
                <p>Checking for uncommitted changes…</p>
              ) : check.blocked ? (
                <p>{check.blocked}</p>
              ) : (
                <>
                  <p>
                    The folder{" "}
                    <code className="text-foreground">
                      {displayPath(worktree.path)}
                    </code>{" "}
                    will be removed from disk.{" "}
                    {worktree.branch ? (
                      <>
                        The branch{" "}
                        <code className="text-foreground">{worktree.branch}</code>{" "}
                        stays, so its commits are safe.
                      </>
                    ) : (
                      "It isn't on a branch, so commits made only here may be lost."
                    )}
                  </p>
                  {check.changes > 0 ? (
                    <p className="text-destructive">
                      It has {check.changes} uncommitted{" "}
                      {check.changes === 1 ? "change" : "changes"}. Deleting
                      throws {check.changes === 1 ? "it" : "them"} away.
                    </p>
                  ) : null}
                  {check.usedByBb ? (
                    <p>
                      A bb thread has worked in this folder. That thread
                      won't be able to open it anymore.
                    </p>
                  ) : null}
                </>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{canDelete ? "Cancel" : "Close"}</AlertDialogCancel>
          {canDelete ? (
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              disabled={deleting}
              onClick={(event) => {
                event.preventDefault();
                void remove();
              }}
            >
              {deleting
                ? "Deleting…"
                : check.changes > 0
                  ? "Delete with changes"
                  : "Delete worktree"}
            </AlertDialogAction>
          ) : null}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function StoppedRow({
  projectId,
  worktree,
  onStarted,
  onDeleted,
}: {
  projectId: string;
  worktree: WorktreeRow;
  onStarted: () => void;
  onDeleted: () => void;
}) {
  const { pending, run } = useServerAction(projectId, worktree, onStarted);
  const [confirming, setConfirming] = useState(false);
  const reveal =
    "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100";
  return (
    <li
      className="group flex h-10 items-center gap-3 pl-4 pr-2 hover:bg-state-hover"
      title={displayPath(worktree.path)}
    >
      <div className="min-w-0 flex-1">
        <BranchName worktree={worktree} />
      </div>
      <Age worktree={worktree} />
      <div className="flex w-28 items-center justify-end gap-0.5">
        {worktree.primary ? null : (
          <Button
            variant="ghost"
            size="icon"
            className={cn("size-8 text-muted-foreground hover:text-destructive", reveal)}
            aria-label={`Delete worktree ${label(worktree)}`}
            onClick={() => setConfirming(true)}
          >
            <Icon name="Trash2" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className={cn("text-muted-foreground disabled:opacity-100", reveal)}
          disabled={pending !== null}
          onClick={() => run("start")}
        >
          <Icon name="Play" />
          {pending === "start" ? "Starting" : "Start"}
        </Button>
      </div>
      {worktree.primary ? null : (
        <DeleteWorktreeDialog
          projectId={projectId}
          worktree={worktree}
          open={confirming}
          onOpenChange={setConfirming}
          onDeleted={onDeleted}
        />
      )}
    </li>
  );
}

function Group({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h2 className="flex items-baseline gap-2 text-sm font-medium">
        {title}
        <span className="text-muted-foreground">{count}</span>
      </h2>
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
        {children}
      </ul>
    </section>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground"
    >
      {children}
    </div>
  );
}

function WorktreeList({
  projectId,
  query,
}: {
  projectId: string;
  query: string;
}) {
  const { worktrees, error, refetch } = useWorktrees(projectId);
  const [openLogs, setOpenLogs] = useState<ReadonlySet<string>>(new Set());
  const setLogsOpen = (path: string, open: boolean) =>
    setOpenLogs((current) => {
      const next = new Set(current);
      if (open) next.add(path);
      else next.delete(path);
      return next;
    });
  if (error) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {error}
      </p>
    );
  }
  if (worktrees === null) return <Notice>Loading worktrees…</Notice>;
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? worktrees.filter((worktree) =>
        `${label(worktree)} ${worktree.path}`.toLowerCase().includes(needle),
      )
    : worktrees;
  if (visible.length === 0) {
    return <Notice>No worktrees match “{query.trim()}”.</Notice>;
  }
  const running = visible.filter((worktree) => worktree.running);
  const stopped = visible.filter((worktree) => !worktree.running);
  return (
    <div className="space-y-6">
      {running.length > 0 ? (
        <Group title="Running" count={running.length}>
          {running.map((worktree) => (
            <RunningRow
              key={worktree.path}
              projectId={projectId}
              worktree={worktree}
              showLogs={openLogs.has(worktree.path)}
              onToggleLogs={() =>
                setLogsOpen(worktree.path, !openLogs.has(worktree.path))
              }
              onChanged={refetch}
            />
          ))}
        </Group>
      ) : null}
      {stopped.length > 0 ? (
        <Group title="Stopped" count={stopped.length}>
          {stopped.map((worktree) => (
            <StoppedRow
              key={worktree.path}
              projectId={projectId}
              worktree={worktree}
              onStarted={() => {
                setLogsOpen(worktree.path, true);
                refetch();
              }}
              onDeleted={refetch}
            />
          ))}
        </Group>
      ) : null}
    </div>
  );
}

/** bb's sidebar serves each project's icon; a 404 means none, so fall back
 * to the project's initial. */
function ProjectLogo({ project }: { project: Project }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span
        aria-hidden
        className="flex size-4 shrink-0 items-center justify-center rounded-sm bg-muted text-[10px] font-medium uppercase text-muted-foreground"
      >
        {project.name.slice(0, 1)}
      </span>
    );
  }
  return (
    <img
      src={`/api/v1/plugins/bb-sidebar/http/project-icon?projectId=${encodeURIComponent(project.id)}`}
      alt=""
      className="size-4 shrink-0 rounded-sm"
      onError={() => setFailed(true)}
    />
  );
}

const LAST_PROJECT_KEY = "bb-plugin-worktrees:last-project";

// The selected project lives in the URL (/plugins/worktrees/worktrees/<id>),
// so back/forward and reloads keep it; the sidebar entry reopens the last one.
function WorktreesPage({ subPath }: { subPath: string }) {
  const navigate = useBbNavigate();
  const { projects, error } = useProjects();
  const [query, setQuery] = useState("");
  const wanted = subPath || localStorage.getItem(LAST_PROJECT_KEY);
  const selected =
    projects?.find((project) => project.id === wanted) ?? projects?.[0] ?? null;
  useEffect(() => {
    if (selected) localStorage.setItem(LAST_PROJECT_KEY, selected.id);
  }, [selected]);
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl space-y-5 px-4 pb-8 pt-3 md:px-5 md:pt-4">
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : projects === null ? (
          <Notice>Loading projects…</Notice>
        ) : selected === null ? (
          <Notice>Add a project to bb to see its worktrees here.</Notice>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={selected.id}
                onValueChange={(projectId) => {
                  setQuery("");
                  navigate.toPluginPanel("worktrees", { subPath: projectId });
                }}
              >
                <SelectTrigger className="w-full sm:w-56" aria-label="Project">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      <span className="flex items-center gap-2">
                        <ProjectLogo project={project} />
                        {project.name}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter by branch or folder"
                aria-label="Filter worktrees"
                className="h-9 min-w-0 flex-1 rounded-md border border-input bg-transparent px-3 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
            <WorktreeList
              key={selected.id}
              projectId={selected.id}
              query={query}
            />
          </>
        )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "worktrees",
    title: "Worktrees",
    icon: "GitBranch",
    path: "worktrees",
    component: WorktreesPage,
  });
});

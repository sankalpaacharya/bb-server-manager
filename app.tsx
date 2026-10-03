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

/** Detached worktrees share a commit, so their folder is what tells them apart. */
const label = (worktree: WorktreeRow) =>
  worktree.branch ??
  `${worktree.path.split("/").at(-1)} (detached at ${worktree.head})`;

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

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

function removalStatus(worktree: WorktreeRow, check: RemovalCheck) {
  if (check.blocked) return { text: check.blocked, tone: "muted" as const };
  if (check.changes > 0) {
    return {
      text: `${plural(check.changes, "uncommitted change", "uncommitted changes")} will be lost`,
      tone: "danger" as const,
    };
  }
  if (!worktree.branch) {
    return { text: "Not on a branch", tone: "muted" as const };
  }
  return { text: "Clean", tone: "muted" as const };
}

function DeleteWorktreesDialog({
  projectId,
  worktrees,
  onClose,
  onDeleted,
}: {
  projectId: string;
  worktrees: WorktreeRow[];
  onClose: () => void;
  onDeleted: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [checks, setChecks] = useState<Map<string, RemovalCheck> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  useEffect(() => {
    Promise.all(
      worktrees.map(
        async (worktree) =>
          [
            worktree.path,
            await rpc.call("checkRemove", { projectId, path: worktree.path }),
          ] as const,
      ),
    ).then(
      (entries) => setChecks(new Map(entries)),
      (cause) => setError(messageOf(cause)),
    );
  }, [rpc, projectId, worktrees]);
  const deletable = checks
    ? worktrees.filter((worktree) => !checks.get(worktree.path)?.blocked)
    : [];
  const withChanges = deletable.filter(
    (worktree) => (checks?.get(worktree.path)?.changes ?? 0) > 0,
  );
  const usedByBb = deletable.some((worktree) => checks?.get(worktree.path)?.usedByBb);
  const remove = async () => {
    const failures: string[] = [];
    for (const [index, worktree] of deletable.entries()) {
      setProgress(index + 1);
      try {
        await rpc.call("remove", {
          projectId,
          path: worktree.path,
          force: (checks?.get(worktree.path)?.changes ?? 0) > 0,
        });
      } catch (cause) {
        failures.push(`${label(worktree)}: ${messageOf(cause)}`);
      }
    }
    const removed = deletable.length - failures.length;
    if (removed > 0) toast.success(`Deleted ${plural(removed, "worktree", "worktrees")}`);
    for (const failure of failures) toast.error(failure);
    onDeleted();
    onClose();
  };
  const single = worktrees.length === 1;
  const skipped = worktrees.length - deletable.length;
  const detached = deletable.some((worktree) => !worktree.branch);
  const title =
    checks === null
      ? single
        ? "Delete this worktree?"
        : `Delete ${worktrees.length} worktrees?`
      : deletable.length === 0
        ? single
          ? "Can't delete this worktree"
          : "None of these can be deleted"
        : deletable.length === 1
          ? "Delete this worktree?"
          : `Delete ${deletable.length} worktrees?`;
  const action =
    progress !== null
      ? `Deleting ${progress} of ${deletable.length}…`
      : withChanges.length > 0
        ? `Delete ${deletable.length === 1 ? "" : `${deletable.length} `}with changes`
        : single
          ? "Delete worktree"
          : `Delete ${plural(deletable.length, "worktree", "worktrees")}`;
  return (
    <AlertDialog open onOpenChange={(open) => (open ? null : onClose())}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3 text-sm text-muted-foreground">
              {error ? (
                <p className="text-destructive">{error}</p>
              ) : checks === null ? (
                <p>Checking for uncommitted changes…</p>
              ) : (
                <>
                  <ul className="max-h-64 divide-y divide-border overflow-y-auto rounded-md border border-border">
                    {worktrees.map((worktree) => {
                      const check = checks.get(worktree.path);
                      const status = check ? removalStatus(worktree, check) : null;
                      return (
                        <li key={worktree.path} className="px-3 py-2">
                          <div
                            className={cn(
                              "truncate",
                              !check?.blocked && "text-foreground",
                            )}
                          >
                            {label(worktree)}
                          </div>
                          <div className="flex justify-between gap-3 text-xs">
                            <span className="truncate">
                              {displayPath(worktree.path)}
                            </span>
                            {status ? (
                              <span
                                className={cn(
                                  "shrink-0",
                                  status.tone === "danger" && "text-destructive",
                                )}
                              >
                                {status.text}
                              </span>
                            ) : null}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                  {deletable.length > 0 ? (
                    <p>
                      {deletable.length === 1 ? "The folder is" : "Folders are"}{" "}
                      removed from disk.{" "}
                      {detached
                        ? "Commits on a branch stay safe, but commits made only in a detached worktree may be lost."
                        : "Branches stay, so their commits are safe."}
                      {skipped > 0
                        ? ` ${plural(skipped, "worktree is", "worktrees are")} skipped.`
                        : null}
                      {usedByBb
                        ? " bb threads that worked in these folders won't be able to open them anymore."
                        : null}
                    </p>
                  ) : null}
                </>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={progress !== null}>
            {deletable.length > 0 ? "Cancel" : "Close"}
          </AlertDialogCancel>
          {deletable.length > 0 && !error ? (
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              disabled={progress !== null}
              onClick={(event) => {
                event.preventDefault();
                void remove();
              }}
            >
              {action}
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
  selected,
  selecting,
  onSelect,
  onStarted,
  onDelete,
}: {
  projectId: string;
  worktree: WorktreeRow;
  selected: boolean;
  selecting: boolean;
  onSelect: (selected: boolean, range: boolean) => void;
  onStarted: () => void;
  onDelete: () => void;
}) {
  const { pending, run } = useServerAction(projectId, worktree, onStarted);
  const reveal =
    "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100";
  return (
    <li
      className={cn(
        "group flex h-10 items-center gap-3 pl-3 pr-2 hover:bg-state-hover",
        selected && "bg-state-active hover:bg-state-active",
      )}
      title={displayPath(worktree.path)}
    >
      <input
        type="checkbox"
        checked={selected}
        aria-label={`Select ${label(worktree)}`}
        onClick={(event) => {
          onSelect(event.currentTarget.checked, event.shiftKey);
        }}
        onChange={() => undefined}
        className={cn(
          "size-4 shrink-0 cursor-pointer accent-foreground",
          selecting || selected ? "opacity-100" : reveal,
        )}
      />
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
            onClick={onDelete}
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
    </li>
  );
}

function Group({
  title,
  count,
  control,
  children,
}: {
  title: string;
  count: number;
  control?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h2 className="flex items-center gap-2 pl-3 text-sm font-medium">
        {control}
        {title}
        <span className="text-muted-foreground">{count}</span>
      </h2>
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
        {children}
      </ul>
    </section>
  );
}

function SelectAll({
  total,
  chosen,
  onChange,
}: {
  total: number;
  chosen: number;
  onChange: (all: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = chosen > 0 && chosen < total;
  }, [chosen, total]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={total > 0 && chosen === total}
      aria-label="Select all stopped worktrees"
      onChange={(event) => onChange(event.currentTarget.checked)}
      className="size-4 cursor-pointer accent-foreground"
    />
  );
}

function SelectionBar({
  count,
  busy,
  onStart,
  onDelete,
  onClear,
}: {
  count: number;
  busy: string | null;
  onStart: () => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  return (
    <div className="sticky bottom-4 z-10 flex justify-center">
      <div
        role="toolbar"
        aria-label="Selected worktrees"
        className="flex items-center gap-1 rounded-lg border border-border bg-popover py-1 pl-4 pr-1 text-sm shadow-lg"
      >
        <span className="mr-2 tabular-nums">{busy ?? `${count} selected`}</span>
        <Button variant="ghost" size="sm" disabled={busy !== null} onClick={onStart}>
          <Icon name="Play" />
          Start
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="hover:text-destructive"
          disabled={busy !== null}
          onClick={onDelete}
        >
          <Icon name="Trash2" />
          Delete
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground"
          aria-label="Clear selection"
          disabled={busy !== null}
          onClick={onClear}
        >
          <Icon name="X" />
        </Button>
      </div>
    </div>
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
  const rpc = useRpc<typeof rpcContract>();
  const { worktrees, error, refetch } = useWorktrees(projectId);
  const [openLogs, setOpenLogs] = useState<ReadonlySet<string>>(new Set());
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [deleting, setDeleting] = useState<WorktreeRow[] | null>(null);
  const [bulkStart, setBulkStart] = useState<string | null>(null);
  const anchor = useRef<number | null>(null);
  const setLogsOpen = (paths: string[], open: boolean) =>
    setOpenLogs((current) => {
      const next = new Set(current);
      for (const path of paths) {
        if (open) next.add(path);
        else next.delete(path);
      }
      return next;
    });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelection(new Set());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
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
  // Actions only ever touch rows that are on screen right now.
  const chosen = stopped.filter((worktree) => selection.has(worktree.path));

  const select = (index: number, value: boolean, range: boolean) => {
    const from = range && anchor.current !== null ? anchor.current : index;
    const [low, high] = from < index ? [from, index] : [index, from];
    setSelection((current) => {
      const next = new Set(current);
      for (const worktree of stopped.slice(low, high + 1)) {
        if (value) next.add(worktree.path);
        else next.delete(worktree.path);
      }
      return next;
    });
    anchor.current = index;
  };
  const startChosen = async () => {
    const targets = chosen;
    const failures: string[] = [];
    for (const [index, worktree] of targets.entries()) {
      setBulkStart(`Starting ${index + 1} of ${targets.length}…`);
      try {
        await rpc.call("start", { projectId, path: worktree.path });
      } catch (cause) {
        failures.push(`${label(worktree)}: ${messageOf(cause)}`);
      }
    }
    setBulkStart(null);
    setSelection(new Set());
    const started = targets.length - failures.length;
    if (started > 0) toast.success(`Started ${plural(started, "dev server", "dev servers")}`);
    for (const failure of failures) toast.error(failure);
    refetch();
  };

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
                setLogsOpen([worktree.path], !openLogs.has(worktree.path))
              }
              onChanged={refetch}
            />
          ))}
        </Group>
      ) : null}
      {stopped.length > 0 ? (
        <Group
          title="Stopped"
          count={stopped.length}
          control={
            <SelectAll
              total={stopped.length}
              chosen={chosen.length}
              onChange={(all) =>
                setSelection(
                  new Set(all ? stopped.map((worktree) => worktree.path) : []),
                )
              }
            />
          }
        >
          {stopped.map((worktree, index) => (
            <StoppedRow
              key={worktree.path}
              projectId={projectId}
              worktree={worktree}
              selected={selection.has(worktree.path)}
              selecting={chosen.length > 0}
              onSelect={(value, range) => select(index, value, range)}
              onStarted={() => {
                setLogsOpen([worktree.path], true);
                refetch();
              }}
              onDelete={() => setDeleting([worktree])}
            />
          ))}
        </Group>
      ) : null}
      {chosen.length > 0 ? (
        <SelectionBar
          count={chosen.length}
          busy={bulkStart}
          onStart={() => void startChosen()}
          onDelete={() => setDeleting(chosen)}
          onClear={() => setSelection(new Set())}
        />
      ) : null}
      {deleting ? (
        <DeleteWorktreesDialog
          projectId={projectId}
          worktrees={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setSelection(new Set());
            refetch();
          }}
        />
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

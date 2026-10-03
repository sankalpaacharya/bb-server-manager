import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { definePluginApp, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { WorktreeRow, rpcContract } from "./server";
import { Button } from "@/components/ui/button";
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

function LogView({ projectId, path }: { projectId: string; path: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [text, setText] = useState<string | null>(null);
  const ref = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);
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
    <pre
      ref={ref}
      tabIndex={0}
      aria-label="Dev server output"
      onScroll={(event) => {
        const element = event.currentTarget;
        pinned.current =
          element.scrollHeight - element.scrollTop - element.clientHeight < 24;
      }}
      className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/60 p-3 font-mono text-xs leading-relaxed text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      {text ?? "Waiting for output…"}
    </pre>
  );
}

function Name({ worktree }: { worktree: WorktreeRow }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <span className="truncate text-sm font-medium">{label(worktree)}</span>
      {worktree.primary ? (
        <span className="shrink-0 text-xs text-muted-foreground">
          main checkout
        </span>
      ) : null}
    </div>
  );
}

function RunningRow({
  projectId,
  worktree,
  onChanged,
}: {
  projectId: string;
  worktree: WorktreeRow;
  onChanged: () => void;
}) {
  const navigate = useBbNavigate();
  const { pending, run } = useServerAction(projectId, worktree, onChanged);
  const [showLogs, setShowLogs] = useState(false);
  const attach = `tmux attach -t ${worktree.session}`;
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="relative flex size-2 shrink-0" aria-hidden>
          <span className="absolute inline-flex size-full rounded-full bg-emerald-500 opacity-60 motion-safe:animate-ping" />
          <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
        </span>
        <div className="min-w-0 flex-1">
          <Name worktree={worktree} />
          <p className="truncate font-mono text-xs text-muted-foreground">
            {worktree.lastLine ?? "Starting…"}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {worktree.url ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate.openUrl(worktree.url ?? "")}
            >
              <Icon name="ExternalLink" />
              {worktree.url.replace(/^https?:\/\//, "")}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={showLogs}
            aria-pressed={showLogs}
            onClick={() => setShowLogs((open) => !open)}
          >
            <Icon name="ScrollText" />
            Logs
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label="Copy tmux attach command"
            onClick={() => {
              void navigator.clipboard.writeText(attach);
              toast.success(`Copied ${attach}`);
            }}
          >
            <Icon name="Copy" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={pending !== null}
            onClick={() => run("stop")}
          >
            <Icon name="Square" />
            {pending === "stop" ? "Stopping…" : "Stop"}
          </Button>
        </div>
      </div>
      {showLogs ? (
        <LogView projectId={projectId} path={worktree.path} />
      ) : null}
    </li>
  );
}

function StoppedRow({
  projectId,
  worktree,
  onChanged,
}: {
  projectId: string;
  worktree: WorktreeRow;
  onChanged: () => void;
}) {
  const { pending, run } = useServerAction(projectId, worktree, onChanged);
  return (
    <li className="flex items-center gap-3 px-4 py-2">
      <span
        className="size-2 shrink-0 rounded-full border border-muted-foreground/40"
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <Name worktree={worktree} />
        <p className="truncate text-xs text-muted-foreground">
          {displayPath(worktree.path)}
        </p>
      </div>
      <Button
        variant="ghost"
        size="sm"
        disabled={pending !== null}
        onClick={() => run("start")}
      >
        <Icon name="Play" />
        {pending === "start" ? "Starting…" : "Start dev"}
      </Button>
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
              onChanged={refetch}
            />
          ))}
        </Group>
      ) : null}
    </div>
  );
}

// The selected project lives in the URL (/plugins/worktrees/worktrees/<id>),
// so back/forward and reloads keep it.
function WorktreesPage({ subPath }: { subPath: string }) {
  const navigate = useBbNavigate();
  const { projects, error } = useProjects();
  const [query, setQuery] = useState("");
  const selected =
    projects?.find((project) => project.id === subPath) ?? projects?.[0] ?? null;
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
                      {project.name}
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

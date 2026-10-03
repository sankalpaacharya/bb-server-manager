import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { definePluginApp, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { ProjectRow, WorktreeRow, rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

const OVERVIEW_POLL_MS = 5000;
const LOGS_POLL_MS = 1500;

const messageOf = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

const displayPath = (path: string) => path.replace(/^\/home\/[^/]+/, "~");

function usePolling(callback: () => void, intervalMs: number, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    callback();
    const timer = setInterval(callback, intervalMs);
    return () => clearInterval(timer);
  }, [callback, intervalMs, enabled]);
}

function useOverview() {
  const rpc = useRpc<typeof rpcContract>();
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("overview").then(
      (result) => {
        setProjects(result.projects);
        setError(null);
      },
      (cause) => setError(messageOf(cause)),
    );
  }, [rpc]);
  usePolling(refetch, OVERVIEW_POLL_MS);
  return { projects, error, refetch };
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
      onScroll={(event) => {
        const element = event.currentTarget;
        pinned.current =
          element.scrollHeight - element.scrollTop - element.clientHeight < 24;
      }}
      className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed"
    >
      {text ?? "Loading logs…"}
    </pre>
  );
}

function WorktreeItem({
  projectId,
  worktree,
  onChanged,
}: {
  projectId: string;
  worktree: WorktreeRow;
  onChanged: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [busy, setBusy] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const act = async (method: "start" | "stop") => {
    setBusy(true);
    try {
      await rpc.call(method, { projectId, path: worktree.path });
      if (method === "start") setShowLogs(true);
      onChanged();
    } catch (cause) {
      toast.error(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };
  const attach = `tmux attach -t ${worktree.session}`;
  return (
    <li className="py-3">
      <div className="flex items-center gap-3">
        <span
          aria-label={worktree.running ? "Running" : "Stopped"}
          className={cn(
            "size-2 shrink-0 rounded-full",
            worktree.running ? "bg-green-500" : "bg-muted-foreground/30",
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">
            {worktree.branch ?? `detached @ ${worktree.head}`}
          </div>
          <div className="truncate font-mono text-xs text-muted-foreground">
            {displayPath(worktree.path)}
          </div>
        </div>
        {worktree.url ? (
          <Button
            variant="link"
            size="sm"
            className="px-1 font-mono"
            onClick={() => navigate.openUrl(worktree.url ?? "")}
          >
            {worktree.url.replace(/^https?:\/\//, "")}
          </Button>
        ) : null}
        {worktree.running ? (
          <>
            <Button
              variant="ghost"
              size="sm"
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
              aria-label={`Copy "${attach}"`}
              onClick={() => {
                void navigator.clipboard.writeText(attach);
                toast.success(`Copied: ${attach}`);
              }}
            >
              <Icon name="TerminalSquare" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => act("stop")}
            >
              <Icon name="Square" />
              Stop
            </Button>
          </>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => act("start")}
          >
            <Icon name="Play" />
            Start dev
          </Button>
        )}
      </div>
      {worktree.running && showLogs ? (
        <LogView projectId={projectId} path={worktree.path} />
      ) : null}
    </li>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"
    >
      {children}
    </div>
  );
}

function WorktreesPage() {
  const { projects, error, refetch } = useOverview();
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl space-y-6 px-4 pb-6 pt-3 md:px-5 md:pt-4">
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {projects === null ? (
          <Notice>Loading worktrees…</Notice>
        ) : projects.length === 0 ? (
          <Notice>No projects yet.</Notice>
        ) : (
          projects.map((project) => (
            <section key={project.id}>
              <h2 className="flex items-baseline gap-2 text-sm font-semibold">
                {project.name}
                <span className="text-xs font-normal text-muted-foreground">
                  {project.worktrees.filter((w) => w.running).length} running
                  · {project.worktrees.length} worktrees
                </span>
              </h2>
              {project.error ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  {project.error}
                </p>
              ) : (
                <ul className="mt-2 divide-y divide-border rounded-lg border border-border bg-card px-4">
                  {project.worktrees.map((worktree) => (
                    <WorktreeItem
                      key={worktree.path}
                      projectId={project.id}
                      worktree={worktree}
                      onChanged={refetch}
                    />
                  ))}
                </ul>
              )}
            </section>
          ))
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

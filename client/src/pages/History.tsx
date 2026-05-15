import { useLocation } from "wouter";
import { Film, Download, ArrowRight, Youtube, RefreshCw, Loader2, Clock, CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import type { JobStatus } from "@shared/jobTypes";

const STATUS_LABELS: Record<JobStatus, string> = {
  pending: "ממתין",
  uploading: "מעלה",
  transcribing: "מתמלל",
  translating: "מתרגם",
  embedding: "מטמיע",
  completed: "הושלם",
  failed: "נכשל",
};

function StatusIcon({ status }: { status: JobStatus }) {
  if (status === "completed") return <CheckCircle2 className="w-4 h-4 text-emerald-400" />;
  if (status === "failed") return <XCircle className="w-4 h-4 text-destructive" />;
  if (["pending", "uploading", "transcribing", "translating", "embedding"].includes(status))
    return <Loader2 className="w-4 h-4 text-primary animate-spin" />;
  return <Clock className="w-4 h-4 text-muted-foreground" />;
}

function DownloadButton({ jobId }: { jobId: string }) {
  const { data, isLoading } = trpc.jobs.getDownloadUrl.useQuery({ id: jobId });

  function handleDownload() {
    if (!data?.url) return;
    const absolute = data.url.startsWith("http")
      ? data.url
      : `${window.location.origin}${data.url}`;
    // Use window.location.href for Android Chrome compatibility
    // (anchor.click() with download attribute is blocked on Android for cross-origin URLs)
    window.location.href = absolute;
  }

  return (
    <Button
      size="sm"
      variant="outline"
      className="gap-1.5 border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10"
      onClick={handleDownload}
      disabled={isLoading || !data?.url}
    >
      {isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
      הורד
    </Button>
  );
}

export default function History() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();

  const { data: jobs, isLoading, error } = trpc.jobs.list.useQuery();

  function refresh() {
    utils.jobs.list.invalidate();
  }

  return (
    <div className="min-h-screen gradient-bg flex flex-col">
      {/* Header */}
      <header className="border-b border-border/50 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-primary/20 flex items-center justify-center">
            <Film className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-foreground leading-tight">מתרגם כתוביות</h1>
            <p className="text-xs text-muted-foreground">גרמנית → עברית</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={refresh} className="gap-2 text-muted-foreground hover:text-foreground">
            <RefreshCw className="w-4 h-4" />
            רענן
          </Button>
          <Button variant="ghost" size="sm" onClick={() => navigate("/")} className="gap-2 text-muted-foreground hover:text-foreground">
            <ArrowRight className="w-4 h-4" />
            עבודה חדשה
          </Button>
        </div>
      </header>

      <main className="flex-1 p-6">
        <div className="max-w-3xl mx-auto">
          <h2 className="text-2xl font-bold text-foreground mb-6">היסטוריית עבודות</h2>

          {isLoading && (
            <div className="glass-card p-12 flex items-center justify-center">
              <Loader2 className="w-8 h-8 text-primary animate-spin" />
            </div>
          )}

          {error && (
            <div className="glass-card p-8 text-center">
              <XCircle className="w-10 h-10 text-destructive mx-auto mb-3" />
              <p className="text-muted-foreground">שגיאה בטעינת ההיסטוריה</p>
            </div>
          )}

          {!isLoading && !error && jobs?.length === 0 && (
            <div className="glass-card p-12 text-center">
              <Film className="w-12 h-12 text-muted-foreground/40 mx-auto mb-4" />
              <p className="text-muted-foreground font-medium">אין עבודות עדיין</p>
              <p className="text-sm text-muted-foreground/70 mt-1">העלה סרטון גרמני כדי להתחיל</p>
              <Button className="mt-4" onClick={() => navigate("/")}>התחל עכשיו</Button>
            </div>
          )}

          {jobs && jobs.length > 0 && (
            <div className="space-y-3">
              {jobs.map((job) => (
                <div
                  key={job.id}
                  className="glass-card p-4 flex items-center gap-4 hover:border-primary/30 transition-colors cursor-pointer"
                  onClick={() => navigate(`/job/${job.id}`)}
                >
                  {/* Icon */}
                  <div className="w-10 h-10 rounded-lg bg-muted/50 flex items-center justify-center flex-shrink-0">
                    {job.inputType === "youtube" ? (
                      <Youtube className="w-5 h-5 text-red-400" />
                    ) : (
                      <Film className="w-5 h-5 text-primary" />
                    )}
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">
                      {job.originalFilename ?? job.inputUrl ?? "סרטון ללא שם"}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {new Date(job.createdAt).toLocaleString("he-IL")}
                    </p>
                  </div>

                  {/* Status */}
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <StatusIcon status={job.status as JobStatus} />
                    <span className={`text-xs px-2 py-0.5 rounded-full status-${job.status}`}>
                      {STATUS_LABELS[job.status as JobStatus] ?? job.status}
                    </span>
                  </div>

                  {/* Download button */}
                  {job.status === "completed" && (
                    <div onClick={(e) => e.stopPropagation()}>
                      <DownloadButton jobId={job.id} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { useLocation, useParams } from "wouter";
import { toast } from "sonner";
import { Film, ArrowRight, Download, ExternalLink, CheckCircle2, XCircle, Loader2, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import type { JobStatus as JobStatusType } from "@shared/jobTypes";

const STATUS_LABELS: Record<JobStatusType, string> = {
  pending: "ממתין",
  uploading: "מעלה קובץ",
  transcribing: "מתמלל בגרמנית",
  translating: "מתרגם לעברית",
  embedding: "מטמיע כתוביות",
  completed: "הושלם",
  failed: "נכשל",
};

const STATUS_DESCRIPTIONS: Record<JobStatusType, string> = {
  pending: "העבודה בתור, מתחיל בקרוב...",
  uploading: "מעלה את הקובץ לשרת...",
  transcribing: "מזהה דיבור גרמני עם Whisper AI...",
  translating: "מתרגם את הכתוביות לעברית...",
  embedding: "מטמיע כתוביות עבריות בסרטון...",
  completed: "הסרטון מוכן להורדה!",
  failed: "העבודה נכשלה",
};

const STATUS_PROGRESS: Record<JobStatusType, number> = {
  pending: 5,
  uploading: 20,
  transcribing: 45,
  translating: 70,
  embedding: 88,
  completed: 100,
  failed: 0,
};

const STATUS_ORDER: JobStatusType[] = [
  "pending",
  "uploading",
  "transcribing",
  "translating",
  "embedding",
  "completed",
];

const ACTIVE_STATUSES: JobStatusType[] = [
  "pending",
  "uploading",
  "transcribing",
  "translating",
  "embedding",
];

// Animated progress bar
function ProgressBar({ target, active, failed }: { target: number; active: boolean; failed: boolean }) {
  const [displayed, setDisplayed] = useState(0);
  const rafRef = useRef<number | null>(null);
  const startValRef = useRef(0);

  useEffect(() => {
    if (failed) {
      setDisplayed(0);
      return;
    }
    if (rafRef.current) cancelAnimationFrame(rafRef.current);

    const end = target;
    const duration = 800;
    const startTime = performance.now();
    startValRef.current = displayed;

    function animate(now: number) {
      const elapsed = now - startTime;
      const t = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      const next = Math.round(startValRef.current + (end - startValRef.current) * eased);
      setDisplayed(next);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(animate);
      }
    }

    rafRef.current = requestAnimationFrame(animate);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, failed]);

  return (
    <div className="relative w-full h-2.5 rounded-full bg-muted/40 overflow-hidden">
      <div
        className={`h-full rounded-full transition-none ${
          failed
            ? "bg-destructive"
            : displayed >= 100
            ? "bg-emerald-500"
            : "bg-gradient-to-l from-primary to-violet-500"
        }`}
        style={{ width: `${failed ? 100 : displayed}%` }}
      />
      {active && !failed && (
        <div className="absolute inset-0 overflow-hidden rounded-full">
          <div className="absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-shimmer" />
        </div>
      )}
    </div>
  );
}

export default function JobStatus() {
  const params = useParams<{ id: string }>();
  const jobId = params.id;
  const [, navigate] = useLocation();
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const notifiedRef = useRef<string | null>(null);
  const statusRef = useRef<string | null>(null);

  const { data: job, error } = trpc.jobs.get.useQuery(
    { id: jobId },
    {
      refetchInterval: () => {
        const s = statusRef.current;
        if (!s) return 2000;
        return ACTIVE_STATUSES.includes(s as JobStatusType) ? 2000 : false;
      },
      retry: 3,
    }
  );

  // Keep statusRef in sync with latest job status
  useEffect(() => {
    if (job?.status) {
      statusRef.current = job.status;
    }
  }, [job?.status]);

  const getDownloadUrlQuery = trpc.jobs.getDownloadUrl.useQuery(
    { id: jobId },
    { enabled: job?.status === "completed" }
  );

  useEffect(() => {
    if (getDownloadUrlQuery.data?.url) {
      setDownloadUrl(getDownloadUrlQuery.data.url);
    }
  }, [getDownloadUrlQuery.data]);

  useEffect(() => {
    if (!job?.status || notifiedRef.current === job.status) return;
    if (job.status === "completed") {
      notifiedRef.current = "completed";
      toast.success("הסרטון המתורגם מוכן להורדה!");
    } else if (job.status === "failed") {
      notifiedRef.current = "failed";
      toast.error("העבודה נכשלה: " + (job.errorMessage ?? "שגיאה לא ידועה"));
    }
  }, [job?.status]);

  if (error) {
    return (
      <div className="min-h-screen gradient-bg flex items-center justify-center">
        <div className="glass-card p-8 text-center max-w-md">
          <XCircle className="w-12 h-12 text-destructive mx-auto mb-4" />
          <p className="text-foreground font-medium">עבודה לא נמצאה</p>
          <Button className="mt-4" onClick={() => navigate("/")}>חזרה לדף הבית</Button>
        </div>
      </div>
    );
  }

  const currentStatus = job?.status as JobStatusType | undefined;
  const isFailed = currentStatus === "failed";
  const isCompleted = currentStatus === "completed";
  const isActive = currentStatus ? ACTIVE_STATUSES.includes(currentStatus) : false;
  const progressTarget = currentStatus ? STATUS_PROGRESS[currentStatus] : 0;

  const currentStatusIndex = isFailed
    ? STATUS_ORDER.indexOf("embedding")
    : currentStatus
    ? STATUS_ORDER.indexOf(currentStatus)
    : -1;

  // Build absolute download URL — always use window.location.origin for same-origin URLs
  const absoluteDownloadUrl = downloadUrl
    ? downloadUrl.startsWith("http")
      ? downloadUrl
      : `${window.location.origin}${downloadUrl}`
    : null;

  // Filename for download
  const downloadFilename = job?.originalFilename
    ? job.originalFilename.replace(/\.[^.]+$/, "") + "-hebrew.mp4"
    : "video-hebrew.mp4";

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
        <Button variant="ghost" size="sm" onClick={() => navigate("/")} className="gap-2 text-muted-foreground hover:text-foreground">
          <ArrowRight className="w-4 h-4" />
          עבודה חדשה
        </Button>
      </header>

      <main className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-lg space-y-5">
          {/* Main status card */}
          <div className="glass-card p-6">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h2 className="text-xl font-bold text-foreground">סטטוס עבודה</h2>
                <p className="text-xs text-muted-foreground mt-1 font-mono" dir="ltr">{jobId}</p>
              </div>
              {currentStatus && (
                <span className={`px-3 py-1 rounded-full text-xs font-medium status-${currentStatus}`}>
                  {STATUS_LABELS[currentStatus]}
                </span>
              )}
            </div>

            {job?.originalFilename && (
              <p className="text-sm text-muted-foreground mb-5 flex items-center gap-2">
                <Film className="w-4 h-4 flex-shrink-0" />
                {job.originalFilename}
              </p>
            )}

            {/* Overall progress bar */}
            <div className="mb-6">
              <div className="flex justify-between items-center mb-1.5">
                <span className="text-xs text-muted-foreground">
                  {currentStatus ? STATUS_DESCRIPTIONS[currentStatus] : "טוען..."}
                </span>
                <span className={`text-xs font-mono font-semibold ${
                  isFailed ? "text-destructive" : isCompleted ? "text-emerald-400" : "text-primary"
                }`}>
                  {isFailed ? "שגיאה" : `${progressTarget}%`}
                </span>
              </div>
              <ProgressBar target={progressTarget} active={isActive} failed={isFailed} />
            </div>

            {/* Step-by-step list */}
            <div className="space-y-2">
              {STATUS_ORDER.map((status, idx) => {
                const isDone = isCompleted || (!isFailed && currentStatusIndex > idx);
                const isCurrent = !isCompleted && !isFailed && currentStatusIndex === idx;

                return (
                  <div key={status} className={`flex items-center gap-3 rounded-lg px-3 py-2.5 transition-all duration-300 ${
                    isCurrent ? "bg-primary/10 border border-primary/20" :
                    isDone ? "opacity-80" :
                    isFailed ? "opacity-50" :
                    "opacity-40"
                  }`}>
                    <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 transition-all ${
                      isDone ? "bg-emerald-500/20 text-emerald-400" :
                      isCurrent ? "bg-primary/20 text-primary" :
                      "bg-muted/50 text-muted-foreground"
                    }`}>
                      {isDone ? (
                        <CheckCircle2 className="w-4 h-4" />
                      ) : isCurrent ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Clock className="w-3.5 h-3.5" />
                      )}
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className={`text-sm ${
                          isDone ? "text-emerald-400" :
                          isCurrent ? "text-foreground font-semibold" :
                          "text-muted-foreground"
                        }`}>
                          {STATUS_LABELS[status]}
                        </span>
                        {isDone && <span className="text-xs text-emerald-400/70">✓</span>}
                        {isCurrent && (
                          <span className="text-xs text-primary/70 animate-pulse">מעבד...</span>
                        )}
                      </div>

                      {isCurrent && (
                        <div className="mt-1.5 h-1 rounded-full bg-primary/10 overflow-hidden">
                          <div className="h-full rounded-full bg-primary/60 animate-step-progress" />
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Failed error message */}
            {isFailed && (
              <div className="mt-4 p-3 rounded-lg bg-destructive/10 border border-destructive/30">
                <p className="text-sm text-destructive flex items-start gap-2">
                  <XCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  {job?.errorMessage ?? "שגיאה לא ידועה"}
                </p>
              </div>
            )}
          </div>

          {/* Download card */}
          {isCompleted && absoluteDownloadUrl && (
            <div className="glass-card p-6 border border-emerald-500/30 animate-fade-in">
              <div className="flex items-center gap-3 mb-3">
                <CheckCircle2 className="w-6 h-6 text-emerald-400" />
                <h3 className="font-semibold text-foreground">הסרטון מוכן!</h3>
              </div>
              <p className="text-sm text-muted-foreground mb-4">
                הסרטון תורגם בהצלחה עם כתוביות עבריות מוטמעות.
              </p>

              {/* Primary download button — uses window.location.href for Android compatibility */}
              <button
                onClick={() => {
                  // window.location.href works on all browsers including Android Chrome
                  window.location.href = absoluteDownloadUrl;
                }}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg bg-emerald-600 hover:bg-emerald-500 active:scale-[0.97] text-white font-medium transition-all duration-150"
              >
                <Download className="w-4 h-4" />
                הורד סרטון מתורגם
              </button>

              {/* Fallback: open in new tab */}
              <a
                href={absoluteDownloadUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 flex items-center justify-center gap-1.5 w-full text-center text-xs text-muted-foreground hover:text-foreground transition-colors py-2"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                פתח בלשונית חדשה
              </a>
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-3">
            <Button variant="outline" className="flex-1" onClick={() => navigate("/")}>
              עבודה חדשה
            </Button>
            <Button variant="outline" className="flex-1" onClick={() => navigate("/history")}>
              היסטוריה
            </Button>
          </div>
        </div>
      </main>
    </div>
  );
}

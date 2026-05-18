import { useEffect, useState } from "react";
import { useParams, useLocation } from "wouter";
import { trpc } from "../lib/trpc";
import { CheckCircle2, XCircle, Loader2, Download, ArrowRight, Clock } from "lucide-react";

type JobStatus = "pending" | "uploading" | "transcribing" | "translating" | "embedding" | "completed" | "failed";

const STATUS_LABELS: Record<JobStatus, string> = {
  pending: "ממתין להתחלה...",
  uploading: "טוען את הסרטון...",
  transcribing: "מתמלל בגרמנית...",
  translating: "מתרגם לעברית...",
  embedding: "מטמיע כתוביות בסרטון...",
  completed: "הסרטון מוכן!",
  failed: "שגיאה בעיבוד",
};

const STEPS: JobStatus[] = ["pending", "uploading", "transcribing", "translating", "embedding", "completed"];

function getStep(status: JobStatus): number {
  return STEPS.indexOf(status);
}

function ProgressStep({ label, done, active }: { label: string; done: boolean; active: boolean }) {
  return (
    <div className={`flex items-center gap-2 text-xs ${active ? "text-primary font-semibold" : done ? "text-green-400" : "text-muted-foreground"}`}>
      <div className={`w-2 h-2 rounded-full shrink-0 ${active ? "bg-primary animate-pulse" : done ? "bg-green-400" : "bg-muted"}`} />
      {label}
    </div>
  );
}

function ElapsedTimer({ since }: { since: Date }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setElapsed(Math.floor((Date.now() - since.getTime()) / 1000)), 1000);
    return () => clearInterval(iv);
  }, [since]);
  const m = Math.floor(elapsed / 60);
  const s = elapsed % 60;
  return <span>{m > 0 ? `${m}:${String(s).padStart(2, "0")} דקות` : `${s} שניות`}</span>;
}

export default function JobStatus() {
  const { id } = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const [startTime] = useState(() => new Date());

  const query = trpc.jobs.get.useQuery(
    { id: id! },
    {
      refetchInterval: (q) => {
        const status = q.state.data?.status as JobStatus | undefined;
        if (!status || status === "completed" || status === "failed") return false;
        return 2000;
      },
      enabled: !!id,
    }
  );

  const job = query.data;
  const status = job?.status as JobStatus | undefined;
  const isActive = status && status !== "completed" && status !== "failed";
  const currentStep = status ? getStep(status) : 0;

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4 font-sans">
      <div className="w-full max-w-md">
        <div className="text-center mb-6">
          <div className={`inline-flex items-center justify-center w-16 h-16 rounded-2xl mb-4 ${
            status === "completed" ? "bg-green-500/10 border border-green-500/20" :
            status === "failed" ? "bg-destructive/10 border border-destructive/20" :
            "bg-primary/10 border border-primary/20"
          }`}>
            {status === "completed" ? (
              <CheckCircle2 size={28} className="text-green-400" />
            ) : status === "failed" ? (
              <XCircle size={28} className="text-destructive" />
            ) : (
              <Loader2 size={28} className="text-primary animate-spin" />
            )}
          </div>
          <h2 className="text-xl font-bold text-foreground">
            {status ? STATUS_LABELS[status] : "טוען..."}
          </h2>
          {isActive && (
            <p className="text-xs text-muted-foreground mt-1 flex items-center justify-center gap-1">
              <Clock size={11} />
              <ElapsedTimer since={startTime} />
            </p>
          )}
        </div>

        <div className="bg-card rounded-2xl border border-border p-5 shadow-lg">
          {status === "completed" && job ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 p-3 rounded-xl bg-green-500/10 border border-green-500/20">
                <CheckCircle2 size={16} className="text-green-400 shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">
                    {(job.originalFilename as string | null) ?? "סרטון YouTube"}
                  </p>
                  <p className="text-xs text-muted-foreground">עם כתוביות עברית מוטמעות</p>
                </div>
              </div>
              <a
                href={`/api/download/${id}`}
                download
                className="flex items-center justify-center gap-2 w-full py-3 px-4 rounded-xl bg-primary text-primary-foreground font-semibold text-sm hover:opacity-90 transition-all"
              >
                <Download size={16} />
                הורד סרטון עם כתוביות
              </a>
            </div>
          ) : status === "failed" ? (
            <div className="space-y-3">
              <div className="p-3 rounded-xl bg-destructive/10 border border-destructive/20">
                <div className="flex items-start gap-2">
                  <XCircle size={14} className="text-destructive shrink-0 mt-0.5" />
                  <p className="text-sm text-foreground">
                    {(job?.errorMessage as string | null) ?? "שגיאה לא ידועה"}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setLocation("/")}
                className="flex items-center justify-center gap-2 w-full py-2.5 px-4 rounded-xl bg-primary text-primary-foreground font-semibold text-sm hover:opacity-90 transition-all"
              >
                <ArrowRight size={16} />
                נסה שוב
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {(["uploading", "transcribing", "translating", "embedding"] as JobStatus[]).map((s) => {
                const step = getStep(s);
                const done = currentStep > step;
                const active = currentStep === step && !!isActive;
                return (
                  <ProgressStep
                    key={s}
                    label={STATUS_LABELS[s]}
                    done={done}
                    active={active}
                  />
                );
              })}
              {isActive && (
                <div className="mt-4 h-1.5 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary rounded-full transition-all duration-1000 progress-glow"
                    style={{ width: `${Math.max(5, (currentStep / (STEPS.length - 1)) * 100)}%` }}
                  />
                </div>
              )}
            </div>
          )}
        </div>

        <div className="mt-4 flex gap-3 justify-center">
          <button
            onClick={() => setLocation("/")}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
          >
            <ArrowRight size={12} />
            תרגום חדש
          </button>
          <span className="text-muted-foreground text-xs">·</span>
          <button
            onClick={() => setLocation("/history")}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            היסטוריה
          </button>
        </div>

        {id && (
          <p className="mt-2 text-center text-xs text-muted-foreground/40 font-mono">{id}</p>
        )}
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { useParams, useLocation } from "wouter";
import { trpc } from "../lib/trpc";
import { CheckCircle2, XCircle, Loader2, Download, ArrowRight, Clock, Timer } from "lucide-react";

type JobStatus = "pending" | "uploading" | "transcribing" | "translating" | "embedding" | "completed" | "failed";

const STEP_ORDER: JobStatus[] = ["pending", "uploading", "transcribing", "translating", "embedding", "completed"];

const STEP_INFO: Record<Exclude<JobStatus, "completed" | "failed">, {
  label: string;
  description: string;
  estimatedSec: number;
}> = {
  pending:      { label: "ממתין להתחלה",      description: "העבודה ממתינה בתור...",               estimatedSec: 5 },
  uploading:    { label: "טעינת סרטון",        description: "מוריד/מעלה את קובץ הווידאו",          estimatedSec: 20 },
  transcribing: { label: "תמלול גרמנית",       description: "Whisper מזהה דיבור גרמני בסרטון",     estimatedSec: 90 },
  translating:  { label: "תרגום לעברית",       description: "GPT-4.1-mini מתרגם כל משפט לעברית",   estimatedSec: 30 },
  embedding:    { label: "הטמעת כתוביות",     description: "ffmpeg צורב כתוביות לתוך הסרטון",      estimatedSec: 45 },
};

function getStepIndex(status: JobStatus): number {
  return STEP_ORDER.indexOf(status);
}

function getOverallProgress(status: JobStatus, stepElapsed: number): number {
  if (status === "completed") return 100;
  if (status === "failed") return 0;
  const stepIdx = getStepIndex(status);
  const totalSteps = STEP_ORDER.length - 1; // exclude completed
  const baseProgress = (stepIdx / totalSteps) * 100;
  const stepProgress = (STEP_ORDER.slice(0, stepIdx + 1).reduce((a, s) => {
    if (s === "completed") return a;
    const info = STEP_INFO[s as Exclude<JobStatus, "completed" | "failed">];
    return a + (info ? info.estimatedSec : 30);
  }, 0));
  void stepProgress;
  if (status === "pending") return 2;
  const info = STEP_INFO[status as Exclude<JobStatus, "completed" | "failed">];
  if (!info) return baseProgress;
  const stepFraction = Math.min(stepElapsed / info.estimatedSec, 0.95);
  const stepContrib = (1 / totalSteps) * 100 * stepFraction;
  return Math.min(baseProgress + stepContrib, 98);
}

function formatCountdown(sec: number): string {
  if (sec <= 0) return "מסיים...";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, "0")} דקות` : `${s} שניות`;
}

function formatElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `${s}s`;
}

function CountdownTimer({ stepStatus, stepStartedAt }: { stepStatus: JobStatus; stepStartedAt: number }) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const iv = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(iv);
  }, []);

  void tick;

  if (stepStatus === "completed" || stepStatus === "failed" || stepStatus === "pending") return null;
  const info = STEP_INFO[stepStatus as Exclude<JobStatus, "completed" | "failed">];
  if (!info) return null;

  const elapsed = Math.floor((Date.now() - stepStartedAt) / 1000);
  const remaining = Math.max(info.estimatedSec - elapsed, 0);

  return (
    <div className="flex items-center gap-3 text-xs">
      <div className="flex items-center gap-1 text-muted-foreground">
        <Clock size={11} />
        <span>עבר: {formatElapsed(elapsed)}</span>
      </div>
      <div className="flex items-center gap-1 text-primary/80">
        <Timer size={11} />
        <span>נותר: ~{formatCountdown(remaining)}</span>
      </div>
    </div>
  );
}

function StepProgressBar({ stepStatus, stepStartedAt }: { stepStatus: JobStatus; stepStartedAt: number }) {
  const [pct, setPct] = useState(0);

  useEffect(() => {
    if (stepStatus === "completed" || stepStatus === "failed" || stepStatus === "pending") return;
    const info = STEP_INFO[stepStatus as Exclude<JobStatus, "completed" | "failed">];
    if (!info) return;
    const update = () => {
      const elapsed = (Date.now() - stepStartedAt) / 1000;
      setPct(Math.min((elapsed / info.estimatedSec) * 100, 95));
    };
    update();
    const iv = setInterval(update, 500);
    return () => clearInterval(iv);
  }, [stepStatus, stepStartedAt]);

  return (
    <div className="mt-2 h-1 bg-muted rounded-full overflow-hidden">
      <div
        className="h-full bg-primary/60 rounded-full transition-all duration-500"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function OverallProgressBar({ status, stepStartedAt }: { status: JobStatus; stepStartedAt: number }) {
  const [pct, setPct] = useState(0);

  useEffect(() => {
    if (status === "completed") { setPct(100); return; }
    if (status === "failed") { setPct(0); return; }
    const update = () => {
      const elapsed = (Date.now() - stepStartedAt) / 1000;
      setPct(getOverallProgress(status, elapsed));
    };
    update();
    const iv = setInterval(update, 500);
    return () => clearInterval(iv);
  }, [status, stepStartedAt]);

  return (
    <div className="relative h-3 bg-muted rounded-full overflow-hidden">
      <div
        className={`absolute inset-y-0 left-0 rounded-full transition-all duration-700 ${
          status === "completed" ? "bg-green-500" : "bg-primary progress-glow"
        }`}
        style={{ width: `${pct}%` }}
      />
      {status !== "completed" && status !== "failed" && (
        <div
          className="absolute inset-y-0 rounded-full bg-white/10 animate-pulse"
          style={{ left: `${Math.max(pct - 15, 0)}%`, width: "15%" }}
        />
      )}
    </div>
  );
}

const STEP_DOTS: Exclude<JobStatus, "pending" | "completed" | "failed">[] = [
  "uploading", "transcribing", "translating", "embedding"
];

function StepDots({ currentStatus }: { currentStatus: JobStatus }) {
  const currentIdx = STEP_ORDER.indexOf(currentStatus);

  return (
    <div className="flex items-center gap-1.5 justify-center">
      {STEP_DOTS.map((step) => {
        const stepIdx = STEP_ORDER.indexOf(step);
        const done = currentIdx > stepIdx;
        const active = currentStatus === step;
        return (
          <div key={step} className="flex items-center gap-1.5">
            <div className={`w-2 h-2 rounded-full transition-all duration-500 ${
              done ? "bg-green-400 scale-100" :
              active ? "bg-primary animate-pulse scale-125" :
              "bg-muted"
            }`} />
            {step !== "embedding" && (
              <div className={`h-px w-5 transition-all duration-500 ${done ? "bg-green-400/50" : "bg-muted"}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function JobStatus() {
  const { id } = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const stepStartedAtRef = useRef<number>(Date.now());
  const prevStatusRef = useRef<JobStatus | null>(null);
  const [stepStartedAt, setStepStartedAt] = useState<number>(Date.now());
  const [, setTick] = useState(0);

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

  useEffect(() => {
    if (status && status !== prevStatusRef.current) {
      prevStatusRef.current = status;
      const now = Date.now();
      stepStartedAtRef.current = now;
      setStepStartedAt(now);
    }
  }, [status]);

  useEffect(() => {
    if (!isActive) return;
    const iv = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(iv);
  }, [isActive]);

  const currentStepInfo = status && status !== "completed" && status !== "failed"
    ? STEP_INFO[status as Exclude<JobStatus, "completed" | "failed">]
    : null;

  const overallPct = status === "completed" ? 100 : 0;
  void overallPct;

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4 font-sans">
      <div className="w-full max-w-md">

        {/* Header icon */}
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
            {!status && "טוען..."}
            {status === "pending" && "ממתין בתור"}
            {status === "uploading" && "טוען סרטון"}
            {status === "transcribing" && "מתמלל גרמנית"}
            {status === "translating" && "מתרגם לעברית"}
            {status === "embedding" && "מטמיע כתוביות"}
            {status === "completed" && "הסרטון מוכן!"}
            {status === "failed" && "שגיאה בעיבוד"}
          </h2>
          {currentStepInfo && (
            <p className="text-xs text-muted-foreground mt-1">{currentStepInfo.description}</p>
          )}
        </div>

        {/* Main card */}
        <div className="bg-card rounded-2xl border border-border p-5 shadow-lg space-y-5">

          {/* Completed state */}
          {status === "completed" && job && (
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
          )}

          {/* Failed state */}
          {status === "failed" && (
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
          )}

          {/* Active processing */}
          {isActive && (
            <>
              {/* Overall progress bar */}
              <div>
                <div className="flex justify-between items-center mb-1.5">
                  <span className="text-xs font-medium text-foreground">התקדמות כללית</span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {STEP_ORDER.indexOf(status) > 0
                      ? `${STEP_ORDER.indexOf(status)}/${STEP_ORDER.length - 1} שלבים`
                      : "מתחיל..."}
                  </span>
                </div>
                <OverallProgressBar status={status} stepStartedAt={stepStartedAt} />
              </div>

              {/* Step dots */}
              <StepDots currentStatus={status} />

              {/* Current step detail card */}
              {status !== "pending" && currentStepInfo && (
                <div className="rounded-xl bg-primary/5 border border-primary/15 p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                      <span className="text-sm font-semibold text-foreground">{currentStepInfo.label}</span>
                    </div>
                    <Loader2 size={14} className="text-primary animate-spin" />
                  </div>

                  {/* Step progress bar */}
                  <StepProgressBar stepStatus={status} stepStartedAt={stepStartedAt} />

                  {/* Timers */}
                  <CountdownTimer stepStatus={status} stepStartedAt={stepStartedAt} />
                </div>
              )}

              {/* All steps list */}
              <div className="space-y-1.5">
                {STEP_DOTS.map((step) => {
                  const stepIdx = STEP_ORDER.indexOf(step);
                  const curIdx = STEP_ORDER.indexOf(status);
                  const done = curIdx > stepIdx;
                  const active = status === step;
                  const pending = curIdx < stepIdx;
                  const info = STEP_INFO[step];

                  return (
                    <div
                      key={step}
                      className={`flex items-center gap-2.5 p-2.5 rounded-xl transition-all text-xs ${
                        active ? "bg-primary/8 border border-primary/20" :
                        done ? "opacity-60" : "opacity-30"
                      }`}
                    >
                      <div className={`w-4 h-4 rounded-full flex items-center justify-center shrink-0 ${
                        done ? "bg-green-500/20" :
                        active ? "bg-primary/20" :
                        "bg-muted"
                      }`}>
                        {done ? (
                          <CheckCircle2 size={10} className="text-green-400" />
                        ) : active ? (
                          <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                        ) : (
                          <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/30" />
                        )}
                      </div>
                      <span className={`font-medium ${
                        active ? "text-foreground" : done ? "text-foreground/70" : "text-muted-foreground"
                      }`}>
                        {info.label}
                      </span>
                      {active && (
                        <span className="mr-auto text-primary/70 font-mono text-[10px]">
                          ~{formatCountdown(
                            Math.max(info.estimatedSec - Math.floor((Date.now() - stepStartedAt) / 1000), 0)
                          )}
                        </span>
                      )}
                      {done && (
                        <span className="mr-auto text-green-400 text-[10px]">✓ הושלם</span>
                      )}
                      {pending && (
                        <span className="mr-auto text-muted-foreground/50 text-[10px]">~{info.estimatedSec}s</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* Footer links */}
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
          <p className="mt-2 text-center text-xs text-muted-foreground/30 font-mono">{id}</p>
        )}
      </div>
    </div>
  );
}

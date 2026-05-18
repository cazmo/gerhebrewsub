import { useLocation } from "wouter";
import { trpc } from "../lib/trpc";
import { ArrowRight, Film, CheckCircle2, XCircle, Loader2, Download, Clock, Youtube } from "lucide-react";

type JobStatus = "pending" | "uploading" | "transcribing" | "translating" | "embedding" | "completed" | "failed";

interface Job {
  id: string;
  status: string;
  inputType: string;
  originalFilename?: string | null;
  inputUrl?: string | null;
  errorMessage?: string | null;
  createdAt: Date | string;
}

const STATUS_LABELS: Record<JobStatus, string> = {
  pending: "ממתין",
  uploading: "טוען",
  transcribing: "מתמלל",
  translating: "מתרגם",
  embedding: "מטמיע",
  completed: "הושלם",
  failed: "נכשל",
};

function StatusBadge({ status }: { status: string }) {
  const base = "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium";
  const s = status as JobStatus;
  if (s === "completed") return <span className={`${base} bg-green-500/15 text-green-400`}><CheckCircle2 size={10} />הושלם</span>;
  if (s === "failed") return <span className={`${base} bg-destructive/15 text-destructive`}><XCircle size={10} />נכשל</span>;
  return <span className={`${base} bg-primary/15 text-primary`}><Loader2 size={10} className="animate-spin" />{STATUS_LABELS[s] ?? s}</span>;
}

function formatDate(d: Date | string): string {
  return new Intl.DateTimeFormat("he-IL", { dateStyle: "short", timeStyle: "short" }).format(new Date(d));
}

export default function History() {
  const [, setLocation] = useLocation();
  const query = trpc.jobs.list.useQuery(undefined, { refetchInterval: 5000 });
  const jobs = (query.data ?? []) as Job[];

  return (
    <div className="min-h-screen bg-background flex flex-col items-center p-4 font-sans pt-8">
      <div className="w-full max-w-lg">
        <div className="flex items-center gap-3 mb-6">
          <button
            onClick={() => setLocation("/")}
            className="p-2 rounded-xl bg-muted hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
          >
            <ArrowRight size={16} />
          </button>
          <div>
            <h1 className="text-xl font-bold text-foreground">היסטוריית עיבודים</h1>
            <p className="text-xs text-muted-foreground">{jobs.length} עיבודים</p>
          </div>
        </div>

        {query.isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 size={24} className="text-primary animate-spin" />
          </div>
        ) : jobs.length === 0 ? (
          <div className="text-center py-16">
            <Film size={40} className="mx-auto mb-3 text-muted-foreground/30" />
            <p className="text-sm text-muted-foreground">אין עיבודים עדיין</p>
            <button
              onClick={() => setLocation("/")}
              className="mt-3 text-xs text-primary hover:text-primary/80 transition-colors"
            >
              התחל עיבוד ראשון ←
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            {jobs.map((job) => (
              <div
                key={job.id}
                onClick={() => setLocation(`/job/${job.id}`)}
                className="bg-card border border-border rounded-xl p-4 cursor-pointer hover:border-primary/30 transition-all"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className={`p-1.5 rounded-lg ${job.inputType === "youtube" ? "bg-red-500/10" : "bg-primary/10"}`}>
                      {job.inputType === "youtube" ? (
                        <Youtube size={14} className="text-red-400" />
                      ) : (
                        <Film size={14} className="text-primary" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">
                        {job.originalFilename ?? job.inputUrl ?? "YouTube"}
                      </p>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <Clock size={10} className="text-muted-foreground" />
                        <span className="text-xs text-muted-foreground">
                          {formatDate(job.createdAt)}
                        </span>
                      </div>
                    </div>
                  </div>
                  <StatusBadge status={job.status} />
                </div>

                {job.status === "completed" && (
                  <a
                    href={`/api/download/${job.id}`}
                    download
                    onClick={(e) => e.stopPropagation()}
                    className="mt-3 flex items-center gap-1.5 text-xs text-primary hover:text-primary/80 transition-colors"
                  >
                    <Download size={12} />
                    הורד סרטון עם כתוביות
                  </a>
                )}

                {job.status === "failed" && job.errorMessage && (
                  <p className="mt-2 text-xs text-destructive/80 line-clamp-2">{job.errorMessage}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

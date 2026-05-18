import { useState, useCallback, useRef } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { trpc } from "../lib/trpc";
import { Upload, Link, Film, Loader2, Youtube, ChevronRight, X, ChevronDown, ChevronUp, Globe, ArrowLeftRight } from "lucide-react";

type Tab = "file" | "youtube";

const MAX_SIZE_MB = 500;
const MAX_SIZE_BYTES = MAX_SIZE_MB * 1024 * 1024;
const CHUNK_SIZE = 5 * 1024 * 1024;

// Languages available for source (includes auto-detect)
const SOURCE_LANGS: [string, string][] = [
  ["auto", "זיהוי אוטומטי"],
  ["he", "עברית"],
  ["de", "גרמנית"],
  ["en", "אנגלית"],
  ["fr", "צרפתית"],
  ["es", "ספרדית"],
  ["ar", "ערבית"],
  ["ru", "רוסית"],
  ["uk", "אוקראינית"],
  ["it", "איטלקית"],
  ["pt", "פורטוגלית"],
  ["pl", "פולנית"],
  ["nl", "הולנדית"],
  ["tr", "טורקית"],
  ["zh", "סינית"],
  ["ja", "יפנית"],
  ["ko", "קוריאנית"],
  ["ro", "רומנית"],
  ["hu", "הונגרית"],
  ["cs", "צ'כית"],
  ["sv", "שוודית"],
];

// Target languages (no auto)
const TARGET_LANGS: [string, string][] = SOURCE_LANGS.filter(([code]) => code !== "auto");

async function uploadInChunks(
  file: File,
  onProgress: (pct: number) => void
): Promise<{ key: string; localPath: string; originalFilename: string }> {
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

  const initRes = await fetch("/api/upload/init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename: file.name, totalChunks }),
  });
  const initData = (await initRes.json()) as { sessionId?: string; error?: string };
  if (!initRes.ok) throw new Error(initData.error ?? "אתחול ההעלאה נכשל");
  const sessionId = initData.sessionId!;

  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const chunk = file.slice(start, start + CHUNK_SIZE);
    const fd = new FormData();
    fd.append("chunk", chunk, `chunk_${i}`);
    fd.append("sessionId", sessionId);
    fd.append("chunkIndex", String(i));
    const res = await fetch("/api/upload/chunk", { method: "POST", body: fd });
    const chunkData = (await res.json()) as { error?: string };
    if (!res.ok) throw new Error(chunkData.error ?? "העלאת חלק נכשלה");
    onProgress(Math.round(((i + 1) / totalChunks) * 85));
  }

  const finalRes = await fetch("/api/upload/finalize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  const finalData = (await finalRes.json()) as { key?: string; localPath?: string; originalFilename?: string; error?: string };
  if (!finalRes.ok) throw new Error(finalData.error ?? "סיום ההעלאה נכשל");
  onProgress(100);
  return { key: finalData.key!, localPath: finalData.localPath!, originalFilename: finalData.originalFilename! };
}

function LangSelect({
  value,
  onChange,
  options,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
  label: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-muted-foreground font-medium">{label}</label>
      <div className="relative">
        <Globe size={13} className="absolute top-1/2 -translate-y-1/2 right-3 text-muted-foreground pointer-events-none" />
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full bg-input border border-border rounded-xl py-2.5 pr-8 pl-3 text-sm text-foreground appearance-none focus:outline-none focus:ring-2 focus:ring-primary/40 cursor-pointer"
          dir="rtl"
        >
          {options.map(([code, name]) => (
            <option key={code} value={code}>{name}</option>
          ))}
        </select>
        <ChevronDown size={13} className="absolute top-1/2 -translate-y-1/2 left-3 text-muted-foreground pointer-events-none" />
      </div>
    </div>
  );
}

export default function Home() {
  const [, setLocation] = useLocation();
  const [tab, setTab] = useState<Tab>("file");
  const [dragging, setDragging] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [showCookies, setShowCookies] = useState(false);
  const [cookiesText, setCookiesText] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [sourceLang, setSourceLang] = useState("auto");
  const [targetLang, setTargetLang] = useState("he");
  const fileRef = useRef<HTMLInputElement>(null);

  const startFromFile = trpc.jobs.startFromFile.useMutation();
  const startFromYouTube = trpc.jobs.startFromYouTube.useMutation();
  const uploadCookies = trpc.jobs.uploadCookies.useMutation();

  const validateFile = (f: File): boolean => {
    if (f.size > MAX_SIZE_BYTES) {
      toast.error(`הקובץ גדול מדי — מקסימום ${MAX_SIZE_MB}MB`);
      return false;
    }
    const ok = /\.(mp4|mpeg|mov|avi|webm|mkv)$/i.test(f.name) || f.type.startsWith("video/");
    if (!ok) toast.error("יש להעלות קובץ וידאו (MP4, MOV, AVI, WebM, MKV)");
    return ok;
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f && validateFile(f)) setSelectedFile(f);
  }, []);

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f && validateFile(f)) setSelectedFile(f);
  };

  const handleSubmitFile = async () => {
    if (!selectedFile) return;
    setUploading(true);
    setUploadPct(0);
    try {
      const { key, localPath, originalFilename } = await uploadInChunks(selectedFile, setUploadPct);
      const { jobId } = await startFromFile.mutateAsync({
        fileKey: key,
        originalFilename,
        localPath,
        sourceLang,
        targetLang,
      });
      setLocation(`/job/${jobId}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "שגיאה בהעלאה");
      setUploading(false);
    }
  };

  const handleSubmitYouTube = async () => {
    if (!youtubeUrl.trim()) return;
    setUploading(true);
    try {
      let cookiesKey: string | undefined;
      if (cookiesText.trim()) {
        const b64 = btoa(unescape(encodeURIComponent(cookiesText)));
        const { key } = await uploadCookies.mutateAsync({ content: b64 });
        cookiesKey = key;
      }
      const { jobId } = await startFromYouTube.mutateAsync({
        url: youtubeUrl.trim(),
        cookiesKey,
        sourceLang,
        targetLang,
      });
      setLocation(`/job/${jobId}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "שגיאה בהתחלת העיבוד");
      setUploading(false);
    }
  };

  const sourceLangLabel = SOURCE_LANGS.find(([c]) => c === sourceLang)?.[1] ?? sourceLang;
  const targetLangLabel = TARGET_LANGS.find(([c]) => c === targetLang)?.[1] ?? targetLang;

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4 font-sans">
      <div className="w-full max-w-md space-y-5">

        {/* Header */}
        <div className="text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 mb-4">
            <Film size={28} className="text-primary" />
          </div>
          <h1 className="text-2xl font-bold text-foreground">מתרגם כתוביות</h1>
          <p className="text-sm text-muted-foreground mt-1">
            תמלול דיבור וכתוביות צרובות · תרגום לכל שפה · ffmpeg
          </p>
        </div>

        {/* Language selector */}
        <div className="bg-card rounded-2xl border border-border p-4 space-y-3">
          <div className="flex items-center gap-2 mb-1">
            <ArrowLeftRight size={14} className="text-primary" />
            <span className="text-sm font-semibold text-foreground">הגדרות תרגום</span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <LangSelect
              value={sourceLang}
              onChange={setSourceLang}
              options={SOURCE_LANGS}
              label="שפת המקור"
            />
            <LangSelect
              value={targetLang}
              onChange={setTargetLang}
              options={TARGET_LANGS}
              label="שפת הכתוביות"
            />
          </div>
          <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground bg-muted/30 rounded-xl px-3 py-2">
            <span>{sourceLangLabel}</span>
            <span className="text-primary">→</span>
            <span className="font-medium text-foreground">{targetLangLabel}</span>
          </div>
        </div>

        {/* Main card */}
        <div className="bg-card rounded-2xl border border-border p-5 space-y-4">
          {/* Tabs */}
          <div className="grid grid-cols-2 gap-1 bg-muted/40 rounded-xl p-1">
            {(["file", "youtube"] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`flex items-center justify-center gap-2 py-2 px-3 rounded-lg text-sm font-medium transition-all ${
                  tab === t
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {t === "file" ? <Upload size={14} /> : <Link size={14} />}
                {t === "file" ? "העלאת קובץ" : "YouTube"}
              </button>
            ))}
          </div>

          {/* File tab */}
          {tab === "file" && (
            <div className="space-y-3">
              <div
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={handleDrop}
                onClick={() => !selectedFile && fileRef.current?.click()}
                className={`relative rounded-xl border-2 border-dashed p-6 text-center transition-all ${
                  dragging ? "border-primary/60 bg-primary/5" :
                  selectedFile ? "border-green-500/40 bg-green-500/5" :
                  "border-border hover:border-primary/40 hover:bg-primary/3 cursor-pointer"
                }`}
              >
                <input
                  ref={fileRef}
                  type="file"
                  accept="video/*,.mp4,.mov,.avi,.webm,.mkv"
                  className="hidden"
                  onChange={handleFileInput}
                />
                {selectedFile ? (
                  <div>
                    <div className="flex items-center justify-center gap-2 mb-1">
                      <Film size={18} />
                      <span className="text-sm font-medium text-foreground truncate max-w-[220px]">
                        {selectedFile.name}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {(selectedFile.size / 1024 / 1024).toFixed(1)} MB
                    </p>
                  </div>
                ) : (
                  <div>
                    <Upload size={24} className="mx-auto mb-2 text-muted-foreground" />
                    <p className="text-sm text-foreground font-medium">גרור קובץ וידאו לכאן</p>
                    <p className="text-xs text-muted-foreground mt-1">MP4, MOV, AVI, WebM, MKV · עד 500MB · עד 110 דקות</p>
                  </div>
                )}
              </div>
              {selectedFile && !uploading && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedFile(null);
                    if (fileRef.current) fileRef.current.value = "";
                  }}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive transition-colors mx-auto"
                >
                  <X size={12} />
                  הסר קובץ
                </button>
              )}
              {uploading && (
                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>מעלה...</span>
                    <span>{uploadPct}%</span>
                  </div>
                  <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary rounded-full transition-all duration-300"
                      style={{ width: `${uploadPct}%` }}
                    />
                  </div>
                </div>
              )}
              <button
                onClick={handleSubmitFile}
                disabled={!selectedFile || uploading}
                className="flex items-center justify-center gap-2 w-full py-3 px-4 rounded-xl bg-primary text-primary-foreground font-semibold text-sm hover:opacity-90 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {uploading
                  ? <><Loader2 size={16} className="animate-spin" /> מעלה ומעבד...</>
                  : <><ChevronRight size={16} /> התחל עיבוד</>}
              </button>
            </div>
          )}

          {/* YouTube tab */}
          {tab === "youtube" && (
            <div className="space-y-3">
              <div className="relative">
                <Youtube size={16} className="absolute top-1/2 -translate-y-1/2 right-3 text-muted-foreground pointer-events-none" />
                <input
                  type="url"
                  placeholder="https://www.youtube.com/watch?v=..."
                  value={youtubeUrl}
                  onChange={(e) => setYoutubeUrl(e.target.value)}
                  className="w-full bg-input border border-border rounded-xl py-2.5 pr-9 pl-3 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/40"
                  dir="ltr"
                />
              </div>
              <button
                type="button"
                onClick={() => setShowCookies(!showCookies)}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                {showCookies ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                הוספת cookies (אופציונלי, עבור סרטונים מוגנים)
              </button>
              {showCookies && (
                <div>
                  <p className="text-xs text-muted-foreground mb-1.5">
                    ייצא cookies מהדפדפן בפורמט Netscape והדבק כאן:
                  </p>
                  <textarea
                    value={cookiesText}
                    onChange={(e) => setCookiesText(e.target.value)}
                    placeholder="# Netscape HTTP Cookie File..."
                    rows={4}
                    className="w-full bg-input border border-border rounded-xl py-2 px-3 text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/40 font-mono resize-none"
                    dir="ltr"
                  />
                </div>
              )}
              <button
                onClick={handleSubmitYouTube}
                disabled={!youtubeUrl.trim() || uploading}
                className="flex items-center justify-center gap-2 w-full py-3 px-4 rounded-xl bg-primary text-primary-foreground font-semibold text-sm hover:opacity-90 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {uploading
                  ? <><Loader2 size={16} className="animate-spin" /> מתחיל עיבוד...</>
                  : <><ChevronRight size={16} /> תרגם סרטון</>}
              </button>
            </div>
          )}
        </div>

        {/* Footer */}
        <p className="text-center text-xs text-muted-foreground">
          <button onClick={() => setLocation("/history")} className="hover:text-foreground transition-colors">
            היסטוריית עיבודים ←
          </button>
        </p>
      </div>
    </div>
  );
}

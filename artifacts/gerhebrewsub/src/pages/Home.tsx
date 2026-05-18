import { useState, useCallback, useRef } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { trpc } from "../lib/trpc";
import { Upload, Link, Film, Loader2, Youtube, ChevronRight, X, ChevronDown, ChevronUp } from "lucide-react";

type Tab = "file" | "youtube";

const MAX_SIZE_MB = 500;
const MAX_SIZE_BYTES = MAX_SIZE_MB * 1024 * 1024;
const CHUNK_SIZE = 5 * 1024 * 1024;

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

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f && validateFile(f)) setSelectedFile(f);
  };

  const handleFileSubmit = async () => {
    if (!selectedFile) return;
    setUploading(true);
    setUploadPct(0);
    try {
      const uploadData = await uploadInChunks(selectedFile, setUploadPct);
      const { jobId } = await startFromFile.mutateAsync({
        fileKey: uploadData.key,
        originalFilename: uploadData.originalFilename,
        localPath: uploadData.localPath,
      });
      toast.success("העיבוד החל!");
      setLocation(`/job/${jobId}`);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "שגיאה בהעלאה");
    } finally {
      setUploading(false);
      setUploadPct(0);
    }
  };

  const handleYouTubeSubmit = async () => {
    const url = youtubeUrl.trim();
    if (!url) return;

    const ALLOWED = ["youtube.com", "www.youtube.com", "youtu.be", "m.youtube.com", "music.youtube.com"];
    let host: string;
    try { host = new URL(url).hostname; } catch { toast.error("כתובת URL לא תקינה"); return; }
    if (!ALLOWED.includes(host)) { toast.error("רק קישורי YouTube נתמכים"); return; }

    setUploading(true);
    try {
      let cookiesKey: string | undefined;

      if (cookiesText.trim()) {
        const b64 = btoa(unescape(encodeURIComponent(cookiesText.trim())));
        const { key } = await uploadCookies.mutateAsync({ content: b64 });
        cookiesKey = key;
      }

      const { jobId } = await startFromYouTube.mutateAsync({ url, cookiesKey });
      toast.success("העיבוד החל!");
      setLocation(`/job/${jobId}`);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "שגיאה");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4 font-sans">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 mb-4">
            <Film size={28} className="text-primary" />
          </div>
          <h1 className="text-2xl font-bold text-foreground mb-1">מתרגם כתוביות</h1>
          <p className="text-sm text-muted-foreground">
            גרמנית → עברית · מופעל על ידי Whisper + GPT-4.1-mini
          </p>
        </div>

        <div className="bg-card rounded-2xl border border-border p-5 shadow-lg">
          <div className="flex gap-1 p-1 bg-muted rounded-xl mb-5">
            {(["file", "youtube"] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-lg text-sm font-medium transition-all ${
                  tab === t ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {t === "file" ? <Upload size={14} /> : <Link size={14} />}
                {t === "file" ? "העלאת קובץ" : "YouTube"}
              </button>
            ))}
          </div>

          {tab === "file" ? (
            <div>
              <div
                onClick={() => !uploading && fileRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={handleDrop}
                className={`relative rounded-xl border-2 border-dashed transition-all cursor-pointer ${
                  dragging ? "border-primary bg-primary/5" :
                  selectedFile ? "border-green-500/40 bg-green-500/5" :
                  "border-border hover:border-primary/40"
                } ${uploading ? "pointer-events-none opacity-60" : ""}`}
              >
                <input
                  ref={fileRef}
                  type="file"
                  accept="video/*,.mp4,.mpeg,.mov,.avi,.webm,.mkv"
                  className="hidden"
                  onChange={handleFileChange}
                />
                <div className="py-8 px-4 text-center">
                  {selectedFile ? (
                    <div>
                      <div className="flex items-center justify-center gap-2 text-green-400 mb-1">
                        <Film size={18} />
                        <span className="font-medium text-sm truncate max-w-48">{selectedFile.name}</span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {(selectedFile.size / 1024 / 1024).toFixed(1)} MB
                      </p>
                    </div>
                  ) : (
                    <div>
                      <Upload size={24} className="mx-auto mb-2 text-muted-foreground" />
                      <p className="text-sm text-foreground font-medium">גרור קובץ וידאו לכאן</p>
                      <p className="text-xs text-muted-foreground mt-1">MP4, MOV, AVI, WebM, MKV · עד 500MB</p>
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
                    className="absolute top-2 left-2 p-1 rounded-full bg-white/10 hover:bg-white/20 transition-colors"
                  >
                    <X size={12} />
                  </button>
                )}
              </div>

              {uploading && (
                <div className="mt-3">
                  <div className="flex justify-between text-xs text-muted-foreground mb-1">
                    <span>מעלה קובץ...</span>
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
                onClick={handleFileSubmit}
                disabled={!selectedFile || uploading}
                className="mt-4 w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-primary text-primary-foreground font-semibold text-sm hover:opacity-90 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {uploading ? (
                  <><Loader2 size={16} className="animate-spin" /> מעלה ומעבד...</>
                ) : (
                  <><ChevronRight size={16} /> התחל עיבוד</>
                )}
              </button>
            </div>
          ) : (
            <div>
              <div className="relative">
                <Youtube size={16} className="absolute top-1/2 -translate-y-1/2 right-3 text-muted-foreground pointer-events-none" />
                <input
                  type="url"
                  dir="ltr"
                  value={youtubeUrl}
                  onChange={(e) => setYoutubeUrl(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && !uploading && handleYouTubeSubmit()}
                  placeholder="https://www.youtube.com/watch?v=..."
                  disabled={uploading}
                  className="w-full bg-input border border-border rounded-xl py-2.5 px-3 pr-9 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/60 transition-all disabled:opacity-50"
                />
              </div>

              <div className="mt-3">
                <button
                  onClick={() => setShowCookies(!showCookies)}
                  className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showCookies ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                  הגדרות מתקדמות — cookies לסרטונים פרטיים/מוגנים
                </button>

                {showCookies && (
                  <div className="mt-2 space-y-2">
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      לסרטונים שדורשים כניסה לחשבון, הדבק כאן את ה-cookies בפורמט Netscape.
                      ניתן לייצא עם תוסף הדפדפן{" "}
                      <a
                        href="https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline"
                      >
                        Get cookies.txt Locally
                      </a>.
                    </p>
                    <textarea
                      value={cookiesText}
                      onChange={(e) => setCookiesText(e.target.value)}
                      placeholder="# Netscape HTTP Cookie File&#10;.youtube.com TRUE / FALSE 9999999999 CONSENT YES+..."
                      rows={5}
                      dir="ltr"
                      className="w-full bg-input border border-border rounded-xl py-2 px-3 text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/40 font-mono resize-none"
                    />
                  </div>
                )}
              </div>

              <button
                onClick={handleYouTubeSubmit}
                disabled={!youtubeUrl.trim() || uploading}
                className="mt-4 w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-primary text-primary-foreground font-semibold text-sm hover:opacity-90 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {uploading ? (
                  <><Loader2 size={16} className="animate-spin" /> מתחיל עיבוד...</>
                ) : (
                  <><ChevronRight size={16} /> תרגם סרטון</>
                )}
              </button>

              <p className="mt-2 text-xs text-muted-foreground text-center">
                סרטונים ציבוריים עובדים ישירות ללא cookies
              </p>
            </div>
          )}
        </div>

        <div className="mt-4 text-center">
          <button
            onClick={() => setLocation("/history")}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            היסטוריית עיבודים ←
          </button>
        </div>
      </div>
    </div>
  );
}

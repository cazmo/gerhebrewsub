import { useState, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { Upload, Youtube, Cookie, Film, Loader2, ArrowLeft, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { trpc } from "@/lib/trpc";

const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500 MB

type UploadPhase = "idle" | "uploading" | "starting" | "done";

export default function Home() {
  const [, navigate] = useLocation();

  // File upload state
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const videoInputRef = useRef<HTMLInputElement>(null);

  // YouTube state
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [ytCookiesFile, setYtCookiesFile] = useState<File | null>(null);
  const ytCookiesRef = useRef<HTMLInputElement>(null);

  // Upload progress
  const [uploadPhase, setUploadPhase] = useState<UploadPhase>("idle");
  const [uploadProgress, setUploadProgress] = useState(0); // 0-100

  const uploading = uploadPhase !== "idle";

  const startFromFile = trpc.jobs.startFromFile.useMutation();
  const startFromYouTube = trpc.jobs.startFromYouTube.useMutation();
  const uploadCookies = trpc.jobs.uploadCookies.useMutation();

  // ── Drag & drop ──────────────────────────────────────────────────────────
  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);
  const onDragLeave = useCallback(() => setIsDragging(false), []);
  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) validateAndSetVideo(file);
  }, []);

  function validateAndSetVideo(file: File) {
    if (file.size > MAX_FILE_SIZE) {
      toast.error("הקובץ גדול מדי. הגודל המקסימלי הוא 500MB.");
      return;
    }
    setVideoFile(file);
  }

  // XHR upload with real progress events
  function uploadWithProgress(formData: FormData): Promise<{ key: string; originalFilename: string; localPath?: string }> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/upload");

      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 100);
          setUploadProgress(pct);
        }
      });

      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch {
            reject(new Error("תגובת שרת לא תקינה"));
          }
        } else {
          try {
            const body = JSON.parse(xhr.responseText);
            reject(new Error(body.error ?? `שגיאת העלאה (${xhr.status})`));
          } catch {
            reject(new Error(`שגיאת העלאה (${xhr.status})`));
          }
        }
      });

      xhr.addEventListener("error", () => reject(new Error("שגיאת רשת בהעלאה")));
      xhr.addEventListener("abort", () => reject(new Error("ההעלאה בוטלה")));

      xhr.send(formData);
    });
  }

  // ── Upload file job ───────────────────────────────────────────────────────
  async function handleFileSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!videoFile) return toast.error("יש לבחור קובץ וידאו");
    setUploadPhase("uploading");
    setUploadProgress(0);
    try {
      // 1. Upload video to S3 with progress
      const formData = new FormData();
      formData.append("video", videoFile);
      const { key, originalFilename, localPath } = await uploadWithProgress(formData);

      // 2. Start job
      setUploadPhase("starting");
      setUploadProgress(100);
      const { jobId } = await startFromFile.mutateAsync({ fileKey: key, originalFilename, localPath });
      setUploadPhase("done");
      toast.success("העבודה התחילה!");
      setTimeout(() => navigate(`/job/${jobId}`), 300);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "שגיאה בהתחלת העבודה");
      setUploadPhase("idle");
      setUploadProgress(0);
    }
  }

  // ── YouTube job ───────────────────────────────────────────────────────────
  async function handleYouTubeSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!youtubeUrl) return toast.error("יש להזין כתובת YouTube");
    setUploadPhase("starting");
    setUploadProgress(0);
    try {
      let cookiesKey: string | undefined;
      if (ytCookiesFile) {
        const buf = await ytCookiesFile.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = "";
        for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
        const b64 = btoa(binary);
        const res = await uploadCookies.mutateAsync({ content: b64 });
        cookiesKey = res.key;
      }
      setUploadProgress(50);
      const { jobId } = await startFromYouTube.mutateAsync({ url: youtubeUrl, cookiesKey });
      setUploadPhase("done");
      setUploadProgress(100);
      toast.success("העבודה התחילה!");
      setTimeout(() => navigate(`/job/${jobId}`), 300);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "שגיאה בהתחלת העבודה");
      setUploadPhase("idle");
      setUploadProgress(0);
    }
  }

  // ── Upload progress UI ────────────────────────────────────────────────────
  const phaseLabel: Record<UploadPhase, string> = {
    idle: "",
    uploading: "מעלה קובץ לשרת...",
    starting: "מתחיל עיבוד...",
    done: "הועלה בהצלחה!",
  };

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
        <Button variant="ghost" size="sm" onClick={() => navigate("/history")} className="gap-2 text-muted-foreground hover:text-foreground">
          <ArrowLeft className="w-4 h-4" />
          היסטוריה
        </Button>
      </header>

      {/* Main */}
      <main className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-xl">
          <div className="text-center mb-8">
            <h2 className="text-3xl font-bold text-foreground mb-2">תרגום כתוביות אוטומטי</h2>
            <p className="text-muted-foreground">העלה סרטון גרמני וקבל MP4 עם כתוביות עבריות</p>
          </div>

          <div className="glass-card p-6">
            <Tabs defaultValue="file" dir="rtl">
              <TabsList className="w-full mb-6 bg-muted/50">
                <TabsTrigger value="file" className="flex-1 gap-2">
                  <Upload className="w-4 h-4" />
                  העלאת קובץ
                </TabsTrigger>
                <TabsTrigger value="youtube" className="flex-1 gap-2">
                  <Youtube className="w-4 h-4" />
                  YouTube
                </TabsTrigger>
              </TabsList>

              {/* ── File upload tab ── */}
              <TabsContent value="file">
                <form onSubmit={handleFileSubmit} className="space-y-4">
                  {/* Drop zone */}
                  <div
                    className={`drop-zone rounded-xl p-8 text-center cursor-pointer transition-all ${isDragging ? "drag-over" : ""} ${uploading ? "pointer-events-none opacity-60" : ""}`}
                    onDragOver={onDragOver}
                    onDragLeave={onDragLeave}
                    onDrop={onDrop}
                    onClick={() => !uploading && videoInputRef.current?.click()}
                  >
                    <input
                      ref={videoInputRef}
                      type="file"
                      accept="video/*"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) validateAndSetVideo(f);
                      }}
                    />
                    {videoFile ? (
                      <div className="space-y-1">
                        <Film className="w-10 h-10 text-primary mx-auto" />
                        <p className="font-medium text-foreground">{videoFile.name}</p>
                        <p className="text-sm text-muted-foreground">
                          {(videoFile.size / 1024 / 1024).toFixed(1)} MB
                        </p>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <Upload className="w-10 h-10 text-muted-foreground mx-auto" />
                        <p className="text-foreground font-medium">גרור קובץ וידאו לכאן</p>
                        <p className="text-sm text-muted-foreground">או לחץ לבחירה · עד 500MB</p>
                        <p className="text-xs text-muted-foreground/70">MP4, AVI, MKV, MOV, WebM</p>
                      </div>
                    )}
                  </div>

                  {/* Upload progress bar */}
                  {uploading && (
                    <div className="space-y-2 animate-fade-in">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground flex items-center gap-1.5">
                          {uploadPhase === "done" ? (
                            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                          ) : (
                            <Loader2 className="w-4 h-4 animate-spin text-primary" />
                          )}
                          {phaseLabel[uploadPhase]}
                        </span>
                        <span className={`font-mono font-semibold text-xs ${
                          uploadPhase === "done" ? "text-emerald-400" : "text-primary"
                        }`}>
                          {uploadProgress}%
                        </span>
                      </div>
                      <div className="relative h-2.5 rounded-full bg-muted/40 overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all duration-300 ${
                            uploadPhase === "done"
                              ? "bg-emerald-500"
                              : "bg-gradient-to-l from-primary to-violet-500"
                          }`}
                          style={{ width: `${uploadProgress}%` }}
                        />
                        {uploadPhase === "uploading" && (
                          <div className="absolute inset-0 overflow-hidden rounded-full">
                            <div className="absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-shimmer" />
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  <Button type="submit" className="w-full gap-2" disabled={!videoFile || uploading}>
                    {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Film className="w-4 h-4" />}
                    {uploading ? phaseLabel[uploadPhase] : "התחל תרגום"}
                  </Button>
                </form>
              </TabsContent>

              {/* ── YouTube tab ── */}
              <TabsContent value="youtube">
                <form onSubmit={handleYouTubeSubmit} className="space-y-4">
                  <div className="space-y-1">
                    <label className="text-sm text-muted-foreground">כתובת YouTube</label>
                    <Input
                      type="url"
                      placeholder="https://www.youtube.com/watch?v=..."
                      value={youtubeUrl}
                      onChange={(e) => setYoutubeUrl(e.target.value)}
                      dir="ltr"
                      className="bg-muted/50"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="text-sm text-muted-foreground flex items-center gap-1.5">
                      <Cookie className="w-3.5 h-3.5" />
                      קובץ cookies (לסרטונים מוגנים)
                    </label>
                    <div
                      className="flex items-center gap-2 cursor-pointer"
                      onClick={() => ytCookiesRef.current?.click()}
                    >
                      <input
                        ref={ytCookiesRef}
                        type="file"
                        accept=".txt"
                        className="hidden"
                        onChange={(e) => setYtCookiesFile(e.target.files?.[0] ?? null)}
                      />
                      <div className="flex-1 px-3 py-2 rounded-lg bg-muted/50 border border-border text-sm text-muted-foreground">
                        {ytCookiesFile ? ytCookiesFile.name : "בחר קובץ cookies.txt"}
                      </div>
                      {ytCookiesFile && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={(e) => { e.stopPropagation(); setYtCookiesFile(null); }}
                          className="text-muted-foreground"
                        >
                          ✕
                        </Button>
                      )}
                    </div>
                  </div>

                  {/* YouTube progress bar */}
                  {uploading && (
                    <div className="space-y-2 animate-fade-in">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground flex items-center gap-1.5">
                          {uploadPhase === "done" ? (
                            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                          ) : (
                            <Loader2 className="w-4 h-4 animate-spin text-primary" />
                          )}
                          {phaseLabel[uploadPhase]}
                        </span>
                        <span className={`font-mono font-semibold text-xs ${
                          uploadPhase === "done" ? "text-emerald-400" : "text-primary"
                        }`}>
                          {uploadProgress}%
                        </span>
                      </div>
                      <div className="relative h-2.5 rounded-full bg-muted/40 overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all duration-500 ${
                            uploadPhase === "done"
                              ? "bg-emerald-500"
                              : "bg-gradient-to-l from-primary to-violet-500"
                          }`}
                          style={{ width: `${uploadProgress}%` }}
                        />
                        {uploadPhase === "starting" && (
                          <div className="absolute inset-0 overflow-hidden rounded-full">
                            <div className="absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-shimmer" />
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  <Button type="submit" className="w-full gap-2" disabled={!youtubeUrl || uploading}>
                    {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Youtube className="w-4 h-4" />}
                    {uploading ? phaseLabel[uploadPhase] : "התחל תרגום מ-YouTube"}
                  </Button>
                </form>
              </TabsContent>
            </Tabs>
          </div>
        </div>
      </main>
    </div>
  );
}

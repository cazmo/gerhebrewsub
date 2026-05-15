# gerhebrewsub — TODO

## DB & Schema
- [x] הוספת טבלאות jobs ו-job_segments ל-drizzle/schema.ts
- [x] הרצת migration ויצירת טבלאות ב-DB

## Server — Pipeline
- [x] server/pipeline.ts: upload, extract audio, Whisper, OCR fallback, translate, embed subtitles
- [x] server/routers.ts: jobs.get, jobs.list, jobs.startFromFile, jobs.startFromYouTube, jobs.uploadCookies, jobs.getDownloadUrl
- [x] server/_core/index.ts: POST /api/upload (multer 500MB)
- [x] server/_core/storageProxy.ts: /manus-download/:key proxy עם Content-Disposition: attachment

## Client — UI
- [x] client/src/index.css: dark elegant RTL, Heebo font, glass-card
- [x] client/index.html: Google Fonts Heebo
- [x] client/src/App.tsx: routes /, /job/:id, /history
- [x] client/src/pages/Home.tsx: העלאת קובץ + YouTube + cookies
- [x] client/src/pages/JobStatus.tsx: polling כל 2 שניות
- [x] client/src/pages/History.tsx: היסטוריה + DownloadButton

## Tests
- [x] server/jobs.test.ts: 12 בדיקות Vitest (כולל auth.logout)

## Deploy
- [x] webdev_save_checkpoint (version: 90ab2505)
- [x] דחיפה ל-GitHub (https://github.com/cazmo/gerhebrewsub)

## תיקונים נדרשים (v2)

- [x] תיקון כפתור הורדה ב-Android — window.location.href
- [x] pipeline: זיהוי כתוביות גרמניות קיימות בסרטון עם OCR ותרגום לעברית
- [x] pipeline: החלפת כתוביות גרמניות קיימות בעברית באותו מיקום/גופן/גודל
- [x] pipeline: כתוביות מהתמלול הקולי מופיעות בתחתית הסרטון (SRT סטנדרטי)

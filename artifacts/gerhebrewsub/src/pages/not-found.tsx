import { AlertCircle } from "lucide-react";

export default function NotFound() {
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background">
      <div className="w-full max-w-md mx-4 p-6 bg-card border border-border rounded-2xl">
        <div className="flex mb-4 gap-2 items-center">
          <AlertCircle className="h-8 w-8 text-destructive" />
          <h1 className="text-2xl font-bold text-foreground">404 - דף לא נמצא</h1>
        </div>
        <p className="mt-4 text-sm text-muted-foreground">
          הדף שחיפשת אינו קיים.
        </p>
      </div>
    </div>
  );
}

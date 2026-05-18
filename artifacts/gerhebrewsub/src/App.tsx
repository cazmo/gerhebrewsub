import { useEffect } from "react";
import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { Toaster } from "sonner";
import { trpc } from "./lib/trpc";
import { playClick } from "./lib/sound";
import Home from "./pages/Home";
import JobStatus from "./pages/JobStatus";
import History from "./pages/History";
import NotFound from "./pages/not-found";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 2,
      staleTime: 5_000,
    },
  },
});

const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: `${import.meta.env.BASE_URL}api/trpc`.replace(/\/+/g, "/").replace(":/", "://"),
    }),
  ],
});

const CLICK_SELECTORS = "button, a, [role=button], select, label[for], input[type=checkbox], input[type=radio]";

function GlobalSounds() {
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target) return;
      const el = target.closest(CLICK_SELECTORS) as HTMLElement | null;
      if (!el) return;
      if (el.closest("[data-no-sound]")) return;

      const isDisabled =
        el.hasAttribute("disabled") ||
        el.getAttribute("aria-disabled") === "true" ||
        (el as HTMLButtonElement).disabled;
      if (isDisabled) return;

      // Choose sound type based on element hints
      if (el.dataset.sound === "success" || el.classList.contains("sound-success")) {
        playClick("success");
      } else if (el.dataset.sound === "soft" || el.tagName === "SELECT" || el.tagName === "A") {
        playClick("soft");
      } else {
        playClick("default");
      }
    };

    document.addEventListener("click", handler, { capture: true });
    return () => document.removeEventListener("click", handler, { capture: true });
  }, []);

  return null;
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/job/:id" component={JobStatus} />
      <Route path="/history" component={History} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <GlobalSounds />
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster position="top-center" richColors theme="dark" dir="rtl" />
      </QueryClientProvider>
    </trpc.Provider>
  );
}

export default App;

import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { Toaster } from "sonner";
import { trpc } from "./lib/trpc";
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
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster position="top-center" richColors theme="dark" dir="rtl" />
      </QueryClientProvider>
    </trpc.Provider>
  );
}

export default App;

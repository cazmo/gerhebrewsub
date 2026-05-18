import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "../../../../artifacts/api-server/src/trpcRouter";

export const trpc = createTRPCReact<AppRouter>();

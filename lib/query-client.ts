import { QueryClient } from "@tanstack/react-query";

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        retry: 2,
        staleTime: 30000, // 30s - increased from 10s for better performance
        gcTime: 10 * 60 * 1000, // 10min - increased from 5min
      },
    },
  });
}

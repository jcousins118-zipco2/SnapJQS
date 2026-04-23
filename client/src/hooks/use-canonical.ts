import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type CanonicalizeResponse } from "@shared/routes";
import { type HistoryItem } from "@shared/schema";

// POST /api/canonicalize
export function useCanonicalize() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async (inputData: unknown) => {
      // The API expects { data: unknown }
      const payload = { data: inputData };
      const validated = api.canonical.process.input.parse(payload);
      
      const res = await fetch(api.canonical.process.path, {
        method: api.canonical.process.method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validated),
        credentials: "include",
      });

      if (!res.ok) {
        const errorData = await res.json();
        // Try to parse known error format
        const parsedError = api.canonical.process.responses[400].safeParse(errorData);
        if (parsedError.success) {
          throw new Error(parsedError.data.message || parsedError.data.error || "Validation failed");
        }
        throw new Error('Failed to process JSON');
      }

      return api.canonical.process.responses[200].parse(await res.json());
    },
    // On success, refresh history
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [api.canonical.history.path] });
    },
  });
}

// GET /api/history
export function useHistory() {
  return useQuery({
    queryKey: [api.canonical.history.path],
    queryFn: async () => {
      const res = await fetch(api.canonical.history.path, { credentials: "include" });
      if (!res.ok) throw new Error('Failed to fetch history');
      return api.canonical.history.responses[200].parse(await res.json());
    },
  });
}

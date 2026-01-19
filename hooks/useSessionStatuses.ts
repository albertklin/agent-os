import type { Session } from "@/lib/db";
import type { SessionStatus } from "@/components/views/types";
import { useSessionStatusesQuery } from "@/data/statuses";
import type { ConnectionStatus } from "@/data/statuses";

interface UseSessionStatusesOptions {
  sessions: Session[];
  activeSessionId?: string | null;
  checkStateChanges: (
    states: Array<{
      id: string;
      name: string;
      status: SessionStatus["status"];
    }>,
    activeSessionId?: string | null
  ) => void;
}

interface UseSessionStatusesResult {
  sessionStatuses: Record<string, SessionStatus>;
  connectionStatus: ConnectionStatus;
}

export function useSessionStatuses({
  sessions,
  activeSessionId,
  checkStateChanges,
}: UseSessionStatusesOptions): UseSessionStatusesResult {
  const { sessionStatuses, connectionStatus } = useSessionStatusesQuery({
    sessions,
    activeSessionId,
    checkStateChanges,
  });

  return { sessionStatuses, connectionStatus };
}

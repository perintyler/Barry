import { getServiceUrl } from "@barry-rocks/sdk/services";
import { announce, type AnnounceResult } from "@barry-rocks/sdk/events";
export type { AnnounceResult } from "@barry-rocks/sdk/events";

export function announceEvent(eventId: string): Promise<AnnounceResult> {
  return announce({
    baseUrl: () => `${getServiceUrl("api")}/api/v1`,
    path: `/events/${encodeURIComponent(eventId)}/announce`,
    topic: "events", id: eventId, kind: "created",
  });
}

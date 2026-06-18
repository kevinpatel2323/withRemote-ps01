import { z } from 'zod';

const timePoint = z
  .object({ dateTime: z.string().optional(), date: z.string().optional() })
  .nullable()
  .optional();

/** Minimal Google Calendar event shape we rely on; extra fields pass through into `raw`. */
export const googleEventSchema = z.object({
  id: z.string(),
  status: z.string().optional(),
  summary: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  htmlLink: z.string().nullable().optional(),
  created: z.string().optional(),
  updated: z.string().optional(),
  start: timePoint,
  end: timePoint,
  location: z.string().nullable().optional(),
  attendees: z.array(z.unknown()).optional(),
  recurrence: z.array(z.string()).optional(),
  hangoutLink: z.string().nullable().optional(),
  organizer: z.unknown().optional(),
});

export type GoogleEvent = z.infer<typeof googleEventSchema>;

/** The subset of the googleapis calendar client we use (keeps the connector testable). */
export interface CalendarClient {
  events: {
    list(params: Record<string, unknown>): Promise<{
      data: {
        items?: unknown[];
        nextPageToken?: string | null;
        nextSyncToken?: string | null;
      };
    }>;
  };
}

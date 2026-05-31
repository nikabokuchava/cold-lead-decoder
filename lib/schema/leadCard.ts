import { z } from "zod";

export const LeadCardSchema = z.object({
  company_name: z.string().min(1).max(120),
  domain: z.string().min(1).max(253),
  summary: z.string().min(1).max(400),
  category: z.string().min(1).max(80),
  positioning_signals: z.array(z.string().min(1).max(200)).min(2).max(4),
  likely_pain_points: z.array(z.string().min(1)).min(2).max(3),
  personalized_opener: z.string().min(1).max(400),
  follow_up_angles: z.array(z.string().min(1)).length(2),
  confidence_notes: z.string().max(400).nullable(),
  source_pages: z
    .array(
      z
        .string()
        .url()
        .refine(
          (u) => {
            try {
              const { protocol } = new URL(u);
              return protocol === "http:" || protocol === "https:";
            } catch {
              return false;
            }
          },
          { message: "source_pages entries must be http(s) URLs" },
        ),
    )
    .min(1),
  degraded: z.boolean(),
  evidence: z.object({
    opener_basis: z.string().min(1).max(300),
  }),
});

export type LeadCard = z.infer<typeof LeadCardSchema>;

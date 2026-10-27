import { z } from 'zod';
import { FEEDBACK_REASONS } from '../domain/assistant.types';

/** Zod mirrors of the `assistant` contract (openapi 2.0.0-alpha.3). */

export const uuid = z.string().uuid();

const context = z.union([
  z.object({ placeId: uuid }).strict(),
  z.object({ planId: uuid }).strict(),
]);

const limit = (max: number, fallback: number) =>
  z.coerce.number().int().min(1).max(max).default(fallback);
const cursor = z.string().max(512).optional();

export const listConversationsQuery = z.object({
  q: z.string().trim().min(2).max(100).optional(),
  limit: limit(50, 20),
  cursor,
});

export const createConversationBody = z
  .object({ title: z.string().min(1).max(80).optional(), context: context.optional() })
  .strict();

export const renameConversationBody = z.object({ title: z.string().min(1).max(80) }).strict();

export const listMessagesQuery = z.object({ limit: limit(50, 30), cursor });

export const sendMessageBody = z
  .object({
    text: z.string().min(1).max(2000),
    context: context.optional(),
    attachments: z
      .array(z.object({ uploadKey: z.string().max(512) }).strict())
      .max(3)
      .optional(),
    locale: z.enum(['vi', 'en']).optional(),
  })
  .strict();

export const feedbackBody = z
  .object({
    rating: z.enum(['up', 'down']),
    reason: z.enum(FEEDBACK_REASONS as [string, ...string[]]).optional(),
  })
  .strict();

export const confirmProposalBody = z
  .object({ values: z.record(z.string(), z.unknown()).optional() })
  .strict();

// --- CMS ---------------------------------------------------------------------

export const cmsDocumentsQuery = z.object({
  status: z.enum(['draft', 'published', 'unpublished']).optional(),
  locale: z.enum(['vi', 'en']).optional(),
  q: z.string().trim().min(2).max(100).optional(),
  limit: limit(100, 50),
  cursor,
});

export const cmsCreateDocumentBody = z
  .object({
    slug: z
      .string()
      .max(80)
      .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
    locale: z.enum(['vi', 'en']),
    title: z.string().trim().min(1).max(120),
    description: z.string().max(300),
    body: z.string().min(1).max(100_000),
  })
  .strict();

export const cmsDraftPatchBody = z
  .object({
    baseRevision: z.number().int().min(0),
    title: z.string().trim().min(1).max(120).optional(),
    description: z.string().max(300).optional(),
    body: z.string().min(1).max(100_000).optional(),
  })
  .strict();

export const cmsPublishBody = z
  .object({ versionId: uuid, reason: z.string().trim().max(500).optional() })
  .strict();

export const cmsUnpublishBody = z.object({ reason: z.string().trim().min(1).max(500) }).strict();

export const cmsVersionsQuery = z.object({ limit: limit(100, 50), cursor });

export const cmsFeedbackQuery = z.object({
  rating: z.enum(['up', 'down']).optional(),
  reason: z.enum(FEEDBACK_REASONS as [string, ...string[]]).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: limit(100, 50),
  cursor,
});

import { z } from 'zod';

const themeSchema = z
  .object({
    primaryColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    dark: z.boolean().optional(),
    position: z.enum(['bottom-right', 'bottom-left']).optional(),
    logoUrl: z.string().url().optional(),
    avatarUrl: z.string().url().optional(),
    radius: z.number().int().min(0).max(32).optional(),
  })
  .strict();

const widgetSettingsSchema = z
  .object({
    launcherLabel: z.string().min(1).max(80).optional(),
    placeholder: z.string().min(1).max(120).optional(),
    showBranding: z.boolean().optional(),
  })
  .strict();

const analyticsSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    retainDays: z.number().int().min(1).max(3650).optional(),
  })
  .strict();

export const configSchema = z
  .object({
    companyName: z.string().min(1).max(120).optional(),
    assistantName: z.string().min(1).max(80),
    teamEmail: z.string().email().optional(),
    fallbackMessage: z.string().min(1).max(500),
    welcomeMessage: z.string().max(500).optional(),
    model: z.string().min(1).max(120).optional(),
    temperature: z.number().min(0).max(2).optional(),
    language: z.string().min(2).max(35).optional(),
    collectLead: z.boolean().optional(),
    leadCollectionEnabled: z.boolean().optional(),
    leadFields: z
      .array(z.enum(['name', 'email', 'phone', 'requirement']))
      .max(4)
      .optional(),
    notificationEmail: z.string().email().optional(),
    notificationChannels: z
      .array(z.enum(['email', 'webhook']))
      .max(2)
      .optional(),
    theme: themeSchema.optional(),
    widgetSettings: widgetSettingsSchema.optional(),
    analyticsSettings: analyticsSettingsSchema.optional(),
    widget: z
      .object({
        primaryColor: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .optional(),
        dark: z.boolean().optional(),
        logoUrl: z.string().url().optional(),
        avatarUrl: z.string().url().optional(),
        assistantName: z.string().min(1).max(80).optional(),
        welcomeMessage: z.string().max(500).optional(),
        suggestedQuestions: z.array(z.string().min(1).max(120)).max(6).optional(),
        position: z.enum(['bottom-right', 'bottom-left']).optional(),
        width: z.number().int().min(280).max(600).optional(),
        height: z.number().int().min(360).max(800).optional(),
        radius: z.number().int().min(0).max(32).optional(),
        icon: z.enum(['chat', 'sparkles', 'help']).optional(),
      })
      .strict()
      .optional(),

    topK: z.number().int().min(1).max(40).optional(),
    minSimilarity: z.number().min(-1).max(1).optional(),
  })
  .strict();
export const createClientSchema = z
  .object({
    name: z.string().min(1).max(120),
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
    domains: z.array(z.string()).min(1).max(30),
    config: configSchema,
    prompt: z.string().min(1).max(20000),
  })
  .strict();
export const chatSchema = z
  .object({ message: z.string().min(1).max(4000), sessionId: z.string().uuid().optional() })
  .strict();
export const leadSchema = z
  .object({
    conversationId: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().email().optional(),
    phone: z.string().trim().max(40).optional(),
    requirement: z.string().trim().max(2000).optional(),
    message: z.string().trim().max(2000).optional(),
  })
  .strict()
  .refine((value) => Boolean(value.requirement || value.message), {
    message: 'Message is required',
    path: ['message'],
  });

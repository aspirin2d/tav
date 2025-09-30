import { z, type ZodError } from "zod";
import type { Context } from "hono";

export type ApiSuccess<T> = { ok: true; data: T };
export type ApiError = {
  ok: false;
  error: { code: string; message: string; details?: unknown };
};

export function jsonOk<T>(c: Context, data: T, status = 200) {
  return c.json<ApiSuccess<T>>({ ok: true, data }, { status } as any);
}

export function jsonCreated<T>(c: Context, data: T) {
  return jsonOk(c, data, 201);
}

export function jsonError(
  c: Context,
  message: string,
  status = 400,
  code = "bad_request",
  details?: unknown,
) {
  return c.json<ApiError>({ ok: false, error: { code, message, details } }, {
    status,
  } as any);
}

export function jsonZodError(c: Context, err: ZodError) {
  const details = z.treeifyError(err);
  return jsonError(c, "validation_failed", 400, "validation_error", details);
}

export const idParamSchema = z.coerce.number().int().nonnegative();

export async function parseJson<T>(
  c: Context,
  schema: z.ZodType<T>,
): Promise<{ data: T } | { error: Response }> {
  let input: unknown;
  try {
    input = await c.req.json();
  } catch {
    return { error: jsonError(c, "invalid_json", 400, "invalid_json") };
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return { error: jsonZodError(c, parsed.error) };
  }
  return { data: parsed.data };
}

export function parseParamId(
  c: Context,
  name: string,
): { id: number } | { error: Response } {
  const raw = c.req.param(name);
  const parsed = idParamSchema.safeParse(raw);
  if (!parsed.success) {
    return { error: jsonError(c, `invalid ${name}`, 400, "invalid_param") };
  }
  return { id: parsed.data };
}

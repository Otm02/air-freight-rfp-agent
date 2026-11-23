import { NextResponse } from "next/server";
import { ApprovalGateError } from "../agents";
import type { LlmModeOverride } from "../orchestrator";

export class HttpBadRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number = 400) {
    super(message);
    this.name = "HttpBadRequestError";
    this.status = status;
  }
}

export function parsePositiveIntId(raw: string, label: string): number {
  const num = Number.parseInt(raw, 10);
  if (!Number.isInteger(num) || num <= 0 || String(num) !== raw.trim()) {
    throw new HttpBadRequestError(`Invalid ${label}: "${raw}".`);
  }
  return num;
}

export function parseLlmMode(raw: unknown): LlmModeOverride | undefined {
  if (raw === "offline" || raw === "auto") {
    return raw;
  }
  return undefined;
}

export function getLlmModeFromRequest(
  request: Request,
  bodyOverride?: unknown,
): LlmModeOverride | undefined {
  const fromBody = parseLlmMode(bodyOverride);
  if (fromBody) {
    return fromBody;
  }
  const url = new URL(request.url);
  const fromQuery = parseLlmMode(url.searchParams.get("llmMode"));
  if (fromQuery) {
    return fromQuery;
  }
  const cookieHeader = request.headers.get("cookie") ?? "";
  for (const part of cookieHeader.split(";")) {
    const [rawKey, ...rest] = part.trim().split("=");
    if (rawKey === "rfp_llm_mode") {
      return parseLlmMode(decodeURIComponent(rest.join("=")));
    }
  }
  return undefined;
}

export function handleApiError(err: unknown): NextResponse {
  if (err instanceof HttpBadRequestError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  if (err instanceof ApprovalGateError) {
    return NextResponse.json(
      {
        error: err.message,
        code: err.code,
        openTasks: err.openTasks,
      },
      { status: 409 },
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  const status = message.toLowerCase().includes("not found") ? 404 : 400;
  return NextResponse.json({ error: message }, { status });
}

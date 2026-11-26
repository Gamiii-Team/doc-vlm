// src/providers/groq.js — Groq adapter for full-VLM calls.
// Default model: qwen/qwen3.8-27b (override with GROQ_MODEL in .env).
// Structured output is enforced with response_format: { type: "json_object" }.
// Includes the shared 429 rate-limit pacer logic.

import Groq from "groq-sdk";
import { withRetry } from "../util/retry.js";
import { config } from "../config.js";
import { pacer } from "../util/pacer.js";

const GROQ_MAX_IMAGES_PER_REQUEST = 3;
const DEFAULT_MODEL = "qwen/qwen3.8-27b";

function is429(err) {
  return err?.status === 429 || err?.statusCode === 429 || err?.code === "rate_limit_exceeded" || /HTTP\s*429/i.test(String(err?.message ?? ""));
}

/** Parse Retry-After into milliseconds (delta-seconds or HTTP-date). */
function retryAfterMsFromHeaders(headers) {
  if (!headers?.get) return null;
  const raw = headers.get("retry-after");
  if (!raw) return null;
  const n = Number(raw);
  if (Number.isFinite(n)) return Math.max(0, n * 1000);
  const ts = Date.parse(raw);
  if (Number.isFinite(ts)) return Math.max(0, ts - Date.now());
  return null;
}

export function makeGroqAdapter({ client: injectedClient } = {}) {
  const groqApiKey = config.groqApiKey;
  // Explicit default keeps the documented 3.8 model even if config is edited later.
  const groqModel = process.env.GROQ_MODEL || config.groqModel || DEFAULT_MODEL;
  if (!groqApiKey) throw new Error("GROQ_API_KEY is not set");

  const client = injectedClient ?? new Groq({ apiKey: groqApiKey });

  // On a 429, retry once at the pacer cadence without pausing every worker.
  // Repeated 429s (or a Retry-After header) trigger the global cool-down.
  const RATE_LIMIT_MIN_GAP_MS = config.vlm429MinGapMs ?? 400;
  const RATE_LIMIT_MAX_ATTEMPTS = Math.max(0, config.vlm429MaxAttempts ?? 1);

  async function callOnce(messages, opts, timeoutMs) {
    const trimmed = trimImages(messages);
    return client.chat.completions.create(
      { ...buildBody(trimmed, opts), model: groqModel },
      timeoutMs ? { timeout: timeoutMs } : undefined,
    );
  }

  return {
    name: "groq",
    model: groqModel,
    async complete(messages, { maxTokens = 8192, temperature = 0.1, timeout } = {}) {
      // Every VLM request passes through the shared choke point.
      await pacer.waitForSlot();
      const timeoutMs = timeout ?? config.vlmTimeoutMs ?? 90000;
      let rateLimitAttempts = 0;
      return withRetry(
        async () => {
          try {
            const resp = await callOnce(messages, { maxTokens, temperature, withReasoningEffort: true }, timeoutMs);
            return toResult(resp);
          } catch (err) {
            if (is429(err)) {
              rateLimitAttempts += 1;
              const retryAfterMs = retryAfterMsFromHeaders(err?.headers) ?? err?.retryAfterMs ?? null;
              if (retryAfterMs) err.retryAfterMs = retryAfterMs;
              if (rateLimitAttempts <= RATE_LIMIT_MAX_ATTEMPTS && !retryAfterMs) {
                const gap = Math.max(RATE_LIMIT_MIN_GAP_MS, pacer.msUntilNextStart());
                await sleep(gap);
                await pacer.waitForSlot();
                const resp = await callOnce(messages, { maxTokens, temperature, withReasoningEffort: true }, timeoutMs);
                return toResult(resp);
              }
              pacer.noteRateLimit({ retryAfterMs, reason: "429", tag: "groq" });
              throw err;
            }
            if (/reasoning_effort/i.test(String(err?.message ?? err))) {
              const resp = await callOnce(messages, { maxTokens, temperature, withReasoningEffort: false }, timeoutMs);
              return toResult(resp);
            }
            throw err;
          }
        },
        { retries: config.httpRetries ?? 6, label: "groq" },
      );
    },
  };
}

function buildBody(trimmed, { maxTokens, temperature, withReasoningEffort }) {
  const body = {
    model: "", // filled in by caller
    messages: trimmed,
    max_completion_tokens: maxTokens,
    stream: false,
    // Required for deterministic, structured VLM output consumed by slideSchema.js.
    response_format: { type: "json_object" },
    temperature,
    top_p: 1,
  };
  if (withReasoningEffort) body.reasoning_effort = "low";
  return body;
}

function toResult(resp) {
  const choice = resp?.choices?.[0];
  return {
    text: choice?.message?.content ?? "",
    finishReason: choice?.finish_reason ?? "unknown",
    usage: resp?.usage
      ? { input: resp.usage.prompt_tokens ?? 0, output: resp.usage.completion_tokens ?? 0 }
      : { input: 0, output: 0 },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimImages(messages) {
  let images = 0;
  return messages.map((m) => {
    if (!Array.isArray(m.content)) return m;
    const kept = [];
    for (const part of m.content) {
      if (part?.type === "image_url") {
        if (images < GROQ_MAX_IMAGES_PER_REQUEST) { images += 1; kept.push(part); }
        continue; // drop extra images (Groq request cap)
      }
      kept.push(part);
    }
    return { ...m, content: kept };
  });
}

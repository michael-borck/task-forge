import "dotenv/config";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  SYSTEM_PROMPT,
  TASK_SCHEMA,
  REFINE_SCHEMA,
  FREETEXT_SCHEMA,
  STRESS_SCHEMA,
  buildKickoffMessage,
  buildRefineMessage,
  buildStressMessage,
} from "./lib/prompts.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- config (all from .env) ---
const PORT = process.env.PORT || 8080;
const MODEL = process.env.MODEL || "claude-sonnet-4-6";
const MAX_REQUESTS_PER_DAY = Number(process.env.MAX_REQUESTS_PER_DAY || 100); // per IP
const DAILY_TOKEN_CAP = Number(process.env.DAILY_TOKEN_CAP || 2_000_000); // global output-token ceiling
const MAX_INPUT_CHARS = Number(process.env.MAX_INPUT_CHARS || 60_000); // guard on pasted/parsed text

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("FATAL: ANTHROPIC_API_KEY is not set. Put it in .env.");
  process.exit(1);
}

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

// --- tiny in-memory rate + spend guards (reset on restart; fine for a small team tool) ---
const today = () => new Date().toISOString().slice(0, 10);
const ipCounts = new Map(); // `${ip}:${day}` -> count
let tokenDay = today();
let tokensUsedToday = 0;

function rateGuard(req, res, next) {
  const day = today();
  if (day !== tokenDay) {
    tokenDay = day;
    tokensUsedToday = 0;
    for (const k of ipCounts.keys()) if (k.endsWith(day)) ipCounts.delete(k);
  }
  if (tokensUsedToday >= DAILY_TOKEN_CAP) {
    return res.status(429).json({ error: "Daily token cap reached. Try again tomorrow." });
  }
  const ip = (req.headers["x-forwarded-for"]?.split(",")[0] || req.ip || "unknown").trim();
  const key = `${ip}:${day}`;
  const n = (ipCounts.get(key) || 0) + 1;
  ipCounts.set(key, n);
  if (n > MAX_REQUESTS_PER_DAY) {
    return res.status(429).json({ error: "Daily request limit reached for this address." });
  }
  next();
}

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(join(__dirname, "public")));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, model: MODEL });
});

// Call the model with a json_schema and return parsed JSON. Throws on upstream
// errors (caught by handleModelError in each route).
async function callModel(messages, schema) {
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    messages,
    output_config: { format: { type: "json_schema", schema } },
  });
  tokensUsedToday += resp.usage?.output_tokens || 0;
  const textBlock = resp.content.find((b) => b.type === "text");
  if (!textBlock) {
    const e = new Error("Model returned no text.");
    e.statusCode = 502;
    throw e;
  }
  try {
    return JSON.parse(textBlock.text);
  } catch {
    const e = new Error("Model returned malformed JSON. Try again or rephrase.");
    e.statusCode = 502;
    throw e;
  }
}

function handleModelError(res, err) {
  if (err instanceof Anthropic.RateLimitError) {
    return res.status(429).json({ error: "Upstream rate limit. Wait a moment and retry." });
  }
  if (err instanceof Anthropic.APIError) {
    return res.status(502).json({ error: `Model error: ${err.message}` });
  }
  if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: "Unexpected server error." });
}

// Re-engineer a worksheet into 2-3 task designs.
// Body: { kickoff: { worksheetText } } -> { data: { summary, options } }
app.post("/api/generate", rateGuard, async (req, res) => {
  try {
    const worksheetText = req.body?.kickoff?.worksheetText;
    if (!worksheetText || !worksheetText.trim()) {
      return res.status(400).json({ error: "No worksheet text provided." });
    }
    if (worksheetText.length > MAX_INPUT_CHARS) {
      return res.status(413).json({ error: `Source text is too long (${worksheetText.length} chars, limit ${MAX_INPUT_CHARS}). Trim it and try again.` });
    }
    const data = await callModel(
      [{ role: "user", content: buildKickoffMessage({ worksheetText }) }],
      TASK_SCHEMA,
    );
    res.json({ data });
  } catch (err) {
    handleModelError(res, err);
  }
});

// Refine a single idea with an instruction (stateless).
// Body: { idea, instruction } -> { idea: revised }  (structured or { freeText })
app.post("/api/refine", rateGuard, async (req, res) => {
  try {
    const { idea, instruction } = req.body || {};
    if (!idea || typeof idea !== "object") {
      return res.status(400).json({ error: "Provide an idea to refine." });
    }
    if (!instruction || !instruction.trim()) {
      return res.status(400).json({ error: "Provide an instruction." });
    }
    const isFreeText = typeof idea.freeText === "string";
    const schema = isFreeText ? FREETEXT_SCHEMA : REFINE_SCHEMA;
    const revised = await callModel(
      [{ role: "user", content: buildRefineMessage({ idea, instruction }) }],
      schema,
    );
    res.json({ idea: revised });
  } catch (err) {
    handleModelError(res, err);
  }
});

// Stress-test a single idea.
// Body: { idea } -> { result: { verdict, specifics, improved_brief } }
app.post("/api/stress", rateGuard, async (req, res) => {
  try {
    const { idea } = req.body || {};
    if (!idea || typeof idea !== "object") {
      return res.status(400).json({ error: "Provide an idea to stress-test." });
    }
    const result = await callModel(
      [{ role: "user", content: buildStressMessage({ idea }) }],
      STRESS_SCHEMA,
    );
    res.json({ result });
  } catch (err) {
    handleModelError(res, err);
  }
});

app.listen(PORT, () => {
  console.log(`Task Forge listening on :${PORT} (model=${MODEL})`);
});

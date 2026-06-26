import "dotenv/config";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { SYSTEM_PROMPT, TASK_SCHEMA, buildKickoffMessage } from "./lib/prompts.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- config (all from .env) ---
const PORT = process.env.PORT || 8080;
const MODEL = process.env.MODEL || "claude-sonnet-4-6"; // quality generation
const FAST_MODEL = process.env.FAST_MODEL || "claude-haiku-4-5"; // quick iteration
const MAX_REQUESTS_PER_DAY = Number(process.env.MAX_REQUESTS_PER_DAY || 100); // per IP
const DAILY_TOKEN_CAP = Number(process.env.DAILY_TOKEN_CAP || 2_000_000); // global output-token ceiling
const MAX_INPUT_CHARS = Number(process.env.MAX_INPUT_CHARS || 60_000); // ~ guard on pasted/parsed text

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
  }
  if (tokensUsedToday >= DAILY_TOKEN_CAP) {
    return res.status(503).json({
      error: "Daily token budget reached. Try again tomorrow, or raise DAILY_TOKEN_CAP.",
    });
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
  res.json({ ok: true, model: MODEL, fastModel: FAST_MODEL });
});

// Generate or refine task designs. Stateless: the client owns the conversation.
// Body: { history?: [{role, content}], kickoff?: {mode, worksheetText}, instruction?, fast? }
app.post("/api/generate", rateGuard, async (req, res) => {
  try {
    const { history = [], kickoff, instruction, fast } = req.body || {};
    const messages = Array.isArray(history) ? [...history] : [];

    if (kickoff) {
      if (!kickoff.worksheetText || !kickoff.worksheetText.trim()) {
        return res.status(400).json({ error: "No worksheet text or task idea provided." });
      }
      if (kickoff.worksheetText.length > MAX_INPUT_CHARS) {
        return res.status(413).json({
          error: `Source text is too long (${kickoff.worksheetText.length} chars, limit ${MAX_INPUT_CHARS}). Trim it and try again.`,
        });
      }
      messages.push({ role: "user", content: buildKickoffMessage(kickoff) });
    } else if (instruction && instruction.trim()) {
      messages.push({ role: "user", content: instruction.trim() });
    } else {
      return res.status(400).json({ error: "Nothing to do: provide a kickoff or an instruction." });
    }

    const model = fast ? FAST_MODEL : MODEL;
    const resp = await client.messages.create({
      model,
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      messages,
      output_config: { format: { type: "json_schema", schema: TASK_SCHEMA } },
    });

    tokensUsedToday += resp.usage?.output_tokens || 0;

    const textBlock = resp.content.find((b) => b.type === "text");
    if (!textBlock) return res.status(502).json({ error: "Model returned no text." });

    let data;
    try {
      data = JSON.parse(textBlock.text);
    } catch {
      return res.status(502).json({ error: "Model returned malformed JSON. Try again or rephrase." });
    }

    // Echo the assistant turn back so the client can append it to history for refinement.
    res.json({
      data,
      assistant: { role: "assistant", content: textBlock.text },
      model,
      usage: resp.usage,
    });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      return res.status(429).json({ error: "Upstream rate limit. Wait a moment and retry." });
    }
    if (err instanceof Anthropic.APIError) {
      return res.status(502).json({ error: `Model error: ${err.message}` });
    }
    console.error(err);
    res.status(500).json({ error: "Unexpected server error." });
  }
});

app.listen(PORT, () => {
  console.log(`Task Forge listening on :${PORT} (model=${MODEL}, fast=${FAST_MODEL})`);
});

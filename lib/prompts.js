// System prompt + structured-output schemas for Keep-Asking Task Designer (dashboard model).
//
// The system prompt encodes the approved task-design rules from the keep-asking
// trial (HREC 83897) so generated tasks are study-ready, not generic. Keep this
// in sync with docs/task-design-template.md in the keep-asking-nudge repo.
//
// Three structured outputs share one "idea" shape:
//   /api/generate  -> { summary, options[2-3] }   (worksheet re-engineered)
//   /api/refine    -> one revised idea            (idea + instruction, stateless)
//   /api/stress    -> { verdict, specifics, improved_brief }
// Anthropic json_schema supports only type/properties/items/required/enum/
// description/additionalProperties — do NOT add minItems/maxItems/etc.

export const SYSTEM_PROMPT = `You are a task-design partner for a university research team running a randomised controlled trial (the "keep-asking" study). The team is converting ordinary unit worksheets into 30-45 minute AI-assisted lab tasks that will be used to measure whether students engage critically with an AI assistant.

Your job: take a worksheet (or a rough task idea) from a co-investigator and produce 2-3 concrete task designs that fit the study's approved constraints, OR stress-test and refit a task the co-investigator already has. The 2-3 designs are INDEPENDENT ALTERNATIVES, not a cumulative set: each is a complete, standalone task the convenor could run on its own, and the convenor will choose ONE to pilot. Never add an extra item that aggregates, summarises, or cross-references the options (no "all three options", "final checklist", or "summary" entry) — the options array contains ONLY the 2-3 individual task designs, nothing else.

THE CONSTRAINTS (non-negotiable; from the ethics approval). Every task you propose must be:
- Discipline-relevant: recognisably part of the unit, not a generic exercise.
- Iterative: cannot be answered well by one prompt and one answer; the student must go back and forth with the AI to do well.
- Open-ended: develops a recommendation or analysis; no single correct answer.
- Time-boxed: completable in 30-45 minutes in a supervised lab session.
- Scoreable: produces a short written output (a few paragraphs) markable 1-5 on a rubric within the convenor's own unit.

OUT OF SCOPE (never propose these): worksheets, fact-lookup or quiz-style tasks, "use AI to learn topic X" with no written output, or tasks where the AI's first answer is already a complete solution. Assume some students have never used an AI chat tool before, so the brief must be readable with zero prior AI experience.

THE ONE DESIGN PRINCIPLE THAT MATTERS: the task must reward challenging the AI. The study measures whether a nudge shifts students from accepting AI answers to questioning them, and that only registers if questioning pays off. The way to make it pay is LOAD-BEARING SPECIFICS: 2-4 concrete details written into the scenario that a generic AI answer will get wrong or ignore — a constraint, a conflicting stakeholder, an awkward number, a contractual clause. The student sees the brief; the AI does not. A student who pushes back ("does that account for the penalty clause in my brief?") produces a visibly better output than one who pastes the first answer.

ANATOMY OF A TASK: (1) a Scenario (~half a page) describing a fictional organisation with named, load-bearing specifics; (2) a Brief instructing the student to develop a recommendation for the situation; (3) a Deliverable (a short written recommendation/analysis produced during the session); (4) a Rubric (1-5) anchored on engagement with the specifics (1 = generic output ignoring the scenario; 3 = addresses some specifics; 5 = recommendation clearly shaped by the scenario's constraints and tensions).

WORKED EXAMPLE (supply chain flavour, for calibration): A Perth fastener distributor sources 80% of stock from one Ningbo supplier (6-week sea freight); its largest contract carries a 2%/week late penalty capped at 10%; a port closure of 3-5 weeks is just announced; air freight costs ~4x; safety stock is 5 weeks for A-class items, 2 weeks otherwise. Asked "how should a company respond to a port closure?" a generic AI gives textbook advice (diversify suppliers, raise safety stock) that engages none of the penalty cap, the 4x air-freight trade-off, or the A/B stock split. A student who interrogates the AI with those numbers produces a recommendation a marker can immediately distinguish.

WHEN GIVEN A WORKSHEET: extract the disciplinary content, then RE-ENGINEER it into task designs — invent a concrete scenario with load-bearing specifics that exercise that content. Do not just reformat the worksheet; worksheets are explicitly out of scope.

WHEN GIVEN AN EXISTING TASK IDEA: stress-test it against every constraint above, name where it falls short (especially: is it iterative? does challenging the AI actually pay off?), then return an honest verdict plus concrete, specific points and an optional improved brief. Do not invent problems that are not there; if the task is strong, say so.

For each option, self-assess honestly against the pre-pilot checklist and flag anything that does not yet hold so the co-investigator knows what to fix. Be concrete and unit-specific; avoid filler. Write briefs a nervous first-time AI user could follow.`;

// --- shared building blocks for a single task design ("idea") ---
const SPECIFIC = {
  type: "object",
  additionalProperties: false,
  properties: {
    detail: { type: "string" },
    why_generic_answers_miss_it: { type: "string" },
  },
  required: ["detail", "why_generic_answers_miss_it"],
};
const RUBRIC_ITEM = {
  type: "object",
  additionalProperties: false,
  properties: {
    score: { type: "integer", enum: [1, 2, 3, 4, 5] },
    descriptor: { type: "string" },
  },
  required: ["score", "descriptor"],
};
const CHECKLIST_ITEM = {
  type: "object",
  additionalProperties: false,
  properties: {
    item: { type: "string" },
    status: { type: "string", enum: ["ok", "needs_work"] },
    note: { type: "string" },
  },
  required: ["item", "status", "note"],
};
export const IDEA_PROPERTIES = {
  title: { type: "string" },
  angle: { type: "string", description: "One line on what makes this option distinct from the others." },
  scenario: { type: "string", description: "~Half a page describing a fictional organisation with named, load-bearing specifics." },
  brief: { type: "string", description: "The instruction shown to the student, readable with zero prior AI experience." },
  deliverable: { type: "string", description: "The short written output the student produces." },
  load_bearing_specifics: { type: "array", description: "The 2-4 details a generic AI answer would miss, each with why it bites.", items: SPECIFIC },
  rubric: { type: "array", description: "1-5 rubric anchored on engagement with the specifics.", items: RUBRIC_ITEM },
  why_it_works: { type: "string", description: "Why a generic answer fails this brief and an interrogating student visibly wins." },
  checklist: { type: "array", description: "Honest self-assessment against the pre-pilot checklist.", items: CHECKLIST_ITEM },
};
export const IDEA_REQUIRED = [
  "title", "angle", "scenario", "brief", "deliverable",
  "load_bearing_specifics", "rubric", "why_it_works", "checklist",
];

// /api/generate — worksheet -> { summary, options[2-3] }
export const TASK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: {
      type: "string",
      description: "One or two sentences: what you did and the key design choice across the options.",
    },
    options: {
      type: "array",
      description: "Exactly 2 or 3 INDEPENDENT alternative task designs. Each is a complete standalone task the convenor could pilot alone. Do NOT include a fourth 'combined', 'all options', 'summary', or aggregate-checklist item — only the individual designs.",
      items: { type: "object", additionalProperties: false, properties: IDEA_PROPERTIES, required: IDEA_REQUIRED },
    },
  },
  required: ["summary", "options"],
};

// /api/refine — one structured idea -> one revised idea (same shape)
export const REFINE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: IDEA_PROPERTIES,
  required: IDEA_REQUIRED,
};

// /api/refine on a free-text (imported) idea -> { freeText }
export const FREETEXT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { freeText: { type: "string", description: "The revised task, as readable text." } },
  required: ["freeText"],
};

// /api/stress — one idea -> honest stress-test result
export const STRESS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdict: { type: "string", description: "One or two sentences: does the task reward questioning, or could a confident generic AI answer already cover it?" },
    specifics: {
      type: "array",
      description: "2-4 concrete points where the task could better reward students interrogating the AI.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { detail: { type: "string" }, why: { type: "string" } },
        required: ["detail", "why"],
      },
    },
    improved_brief: { type: "string", description: "An optional, tightened version of the brief that sharpens the load-bearing specifics." },
  },
  required: ["verdict", "specifics", "improved_brief"],
};

// --- message builders (first user turn for each action) ---
export function buildKickoffMessage({ worksheetText }) {
  return `Here is an existing worksheet. Re-engineer it into 2-3 AI-assisted lab task designs for the study.\n\n--- SOURCE MATERIAL ---\n${worksheetText.trim()}`;
}

export function buildRefineMessage({ idea, instruction }) {
  return `Here is one task design a co-investigator is working on. Apply the requested change and return the REVISED design in exactly the same structure (keep what works; change only what's asked; preserve or sharpen the load-bearing specifics; keep it a complete standalone task).\n\nREQUESTED CHANGE: ${instruction.trim()}\n\n--- TASK DESIGN ---\n${JSON.stringify(idea, null, 2)}`;
}

export function buildStressMessage({ idea }) {
  return `Here is one task design a co-investigator is considering. Stress-test it against the study constraints — especially: does challenging the AI actually pay off here, or could a confident generic answer already cover it? Identify 2-4 concrete points where it could better reward students interrogating the AI, and offer an optional tightened brief. Be honest and specific, not nitpicky; if the task is strong, say so.\n\n--- TASK DESIGN ---\n${JSON.stringify(idea, null, 2)}`;
}

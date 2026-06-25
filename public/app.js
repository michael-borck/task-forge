import * as pdfjs from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.min.mjs";
pdfjs.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs";

const $ = (id) => document.getElementById(id);

// --- state ---
let mode = "generate";
let history = []; // [{role, content}] — conversation with the model
let accessCode = localStorage.getItem("tf_access_code") || "";

// --- access code handling (real gate: the app stays locked until a valid code) ---
async function ensureAccess() {
  let cfg;
  try {
    cfg = await fetch("/api/config").then((r) => r.json());
  } catch {
    // Can't reach the server — lock the UI rather than leave it open.
    showCodeModal("Can't reach the server. Check your connection and try again.");
    return;
  }
  if (!cfg.accessCodeRequired) return; // open mode — no gate
  // A code we stored earlier may have been rotated; re-verify before trusting it.
  if (accessCode && (await verifyCode(accessCode))) return;
  accessCode = "";
  localStorage.removeItem("tf_access_code");
  showCodeModal();
}

// Returns true only if the server accepts the code (200 from /api/verify).
async function verifyCode(code) {
  try {
    const res = await fetch("/api/verify", { method: "POST", headers: { "x-access-code": code } });
    return res.ok;
  } catch {
    return false;
  }
}

function showCodeModal(message) {
  const err = $("codeError");
  if (message) {
    err.textContent = message;
    err.classList.remove("hidden");
  } else {
    err.classList.add("hidden");
  }
  $("codeModal").classList.remove("hidden");
  $("codeInput").focus();
}

async function submitCode() {
  const code = $("codeInput").value.trim();
  const err = $("codeError");
  const btn = $("codeSave");
  if (!code) {
    err.textContent = "Enter the access code to continue.";
    err.classList.remove("hidden");
    return;
  }
  btn.disabled = true;
  btn.textContent = "Checking…";
  err.classList.add("hidden");
  const ok = await verifyCode(code);
  btn.disabled = false;
  btn.textContent = "Continue";
  if (!ok) {
    err.textContent = "That code didn't work — try again.";
    err.classList.remove("hidden");
    $("codeInput").select();
    return;
  }
  accessCode = code;
  localStorage.setItem("tf_access_code", code);
  $("codeModal").classList.add("hidden"); // unlock only after the server confirms
}

$("codeSave").addEventListener("click", submitCode);
$("codeInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") submitCode();
});

// --- mode toggle ---
document.querySelectorAll(".seg-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".seg-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    mode = btn.dataset.mode;
    $("go").textContent = mode === "refit" ? "Stress-test & improve" : "Generate task designs";
  });
});

// --- file parsing (in browser; raw file never leaves the machine) ---
$("file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  $("fileStatus").textContent = `Reading ${file.name}…`;
  try {
    const text = await extractText(file);
    $("source").value = text.trim();
    $("fileStatus").textContent = `Loaded ${file.name} (${text.length.toLocaleString()} chars). Edit if needed.`;
  } catch (err) {
    console.error(err);
    $("fileStatus").textContent = `Could not read ${file.name}: ${err.message}`;
  }
});

async function extractText(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".txt") || name.endsWith(".md")) return await file.text();
  if (name.endsWith(".docx")) {
    const buf = await file.arrayBuffer();
    const { value } = await window.mammoth.extractRawText({ arrayBuffer: buf });
    return value;
  }
  if (name.endsWith(".pdf")) {
    const buf = await file.arrayBuffer();
    const pdf = await pdfjs.getDocument({ data: buf }).promise;
    let out = "";
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      out += content.items.map((i) => i.str).join(" ") + "\n\n";
    }
    return out;
  }
  throw new Error("Unsupported file type (use .docx, .pdf, .txt, or .md).");
}

// --- API calls ---
async function callApi(body, statusEl) {
  statusEl.textContent = "Thinking… (this can take 20–40s)";
  const res = await fetch("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-access-code": accessCode },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    statusEl.textContent = "";
    localStorage.removeItem("tf_access_code");
    accessCode = "";
    showCodeModal();
    throw new Error("Access code required.");
  }
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status}).`);
  statusEl.textContent = `Done · ${json.model}`;
  history.push(json.assistant);
  return json.data;
}

$("go").addEventListener("click", async () => {
  const worksheetText = $("source").value;
  if (!worksheetText.trim()) {
    $("status").textContent = "Paste some text or load a file first.";
    return;
  }
  history = [];
  try {
    const data = await callApi(
      {
        kickoff: {
          mode,
          unit: $("unit").value,
          discipline: $("discipline").value,
          worksheetText,
        },
        fast: $("fast").checked,
      },
      $("status"),
    );
    render(data);
    $("results").classList.remove("hidden");
    $("results").scrollIntoView({ behavior: "smooth" });
  } catch (err) {
    $("status").textContent = err.message;
  }
});

$("refine").addEventListener("click", async () => {
  const instruction = $("instruction").value;
  if (!instruction.trim()) {
    $("status2").textContent = "Type what to change.";
    return;
  }
  try {
    const data = await callApi({ history, instruction, fast: $("fast").checked }, $("status2"));
    render(data);
    $("instruction").value = "";
  } catch (err) {
    $("status2").textContent = err.message;
  }
});

$("reset").addEventListener("click", () => {
  history = [];
  $("results").classList.add("hidden");
  $("options").innerHTML = "";
  $("summary").innerHTML = "";
  $("status").textContent = "";
  window.scrollTo({ top: 0, behavior: "smooth" });
});

// --- rendering ---
let lastData = null;
function render(data) {
  lastData = data;
  $("summary").textContent = data.summary || "";
  const wrap = $("options");
  wrap.innerHTML = "";
  (data.options || []).forEach((opt, i) => wrap.appendChild(optionCard(opt, i)));
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function optionCard(opt, i) {
  const card = el("div", "card option");
  const head = el("div", "opt-head");
  head.appendChild(el("h3", null, `${i + 1}. ${opt.title}`));
  const dl = el("button", "ghost small", "Download .md");
  dl.addEventListener("click", () => downloadOption(opt, i));
  head.appendChild(dl);
  card.appendChild(head);

  if (opt.angle) card.appendChild(el("p", "angle", opt.angle));

  card.appendChild(section("Scenario", opt.scenario));
  card.appendChild(section("Brief", opt.brief));
  card.appendChild(section("Deliverable", opt.deliverable));

  const lbs = el("div", "block");
  lbs.appendChild(el("h4", null, "Load-bearing specifics"));
  const ul = el("ul");
  (opt.load_bearing_specifics || []).forEach((s) => {
    const li = el("li");
    li.appendChild(el("strong", null, s.detail));
    li.appendChild(el("span", "muted", " — " + s.why_generic_answers_miss_it));
    ul.appendChild(li);
  });
  lbs.appendChild(ul);
  card.appendChild(lbs);

  const rb = el("div", "block");
  rb.appendChild(el("h4", null, "Rubric (1–5)"));
  const rul = el("ul", "rubric");
  (opt.rubric || []).forEach((r) => rul.appendChild(el("li", null, `${r.score} — ${r.descriptor}`)));
  rb.appendChild(rul);
  card.appendChild(rb);

  card.appendChild(section("Why it works", opt.why_it_works));

  const ck = el("div", "block");
  ck.appendChild(el("h4", null, "Pre-pilot checklist"));
  const cul = el("ul", "checklist");
  (opt.checklist || []).forEach((c) => {
    const li = el("li", c.status === "ok" ? "ok" : "warn");
    li.textContent = `${c.status === "ok" ? "✓" : "⚠"} ${c.item}${c.note ? " — " + c.note : ""}`;
    cul.appendChild(li);
  });
  ck.appendChild(cul);
  card.appendChild(ck);

  return card;
}

function section(title, body) {
  const b = el("div", "block");
  b.appendChild(el("h4", null, title));
  b.appendChild(el("p", null, body || ""));
  return b;
}

// --- markdown export (matches docs/task-design-template.md shape) ---
function optionToMarkdown(opt) {
  const lbs = (opt.load_bearing_specifics || [])
    .map((s) => `- **${s.detail}** — ${s.why_generic_answers_miss_it}`)
    .join("\n");
  const rubric = (opt.rubric || []).map((r) => `${r.score}. ${r.descriptor}`).join("\n");
  const checklist = (opt.checklist || [])
    .map((c) => `- [${c.status === "ok" ? "x" : " "}] ${c.item}${c.note ? " — " + c.note : ""}`)
    .join("\n");
  return `# Task Design: ${opt.title}

*${opt.angle || ""}*

## Scenario
${opt.scenario}

## Brief
${opt.brief}

## Deliverable
${opt.deliverable}

## Load-bearing specifics
${lbs}

## Rubric (1–5)
${rubric}

## Why it works
${opt.why_it_works}

## Pre-pilot checklist
${checklist}

---
*Draft from Task Forge for the keep-asking study (HREC 83897). Review and sign off before piloting.*
`;
}

function downloadOption(opt, i) {
  const md = optionToMarkdown(opt);
  const slug = (opt.title || `task-${i + 1}`).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const blob = new Blob([md], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `task-design-${slug}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

ensureAccess();

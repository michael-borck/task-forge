import * as pdfjs from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.min.mjs";
pdfjs.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs";

const $ = (id) => document.getElementById(id);

// --- state ---
let mode = "generate";
let history = []; // [{role, content}] — conversation with the model
let lastKickoff = null; // last kickoff sent — "Try again" reuses it for a fresh guess

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
  if (name.endsWith(".txt") || name.endsWith(".md") || name.endsWith(".qmd")) return await file.text();
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
  throw new Error("Unsupported file type (use .docx, .pdf, .txt, .md, or .qmd).");
}

// --- API calls ---
async function callApi(body, statusEl) {
  statusEl.textContent = "Thinking… (this can take 20–40s)";
  const res = await fetch("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status}).`);
  statusEl.textContent = `Done · ${json.model}`;
  history.push(json.assistant);
  return json.data;
}

// Shared by "Generate" (Go) and "Try again": reset history and kick off a fresh
// generation. Go reads the form; Try again reuses the last kickoff verbatim.
async function runKickoff(kickoff, statusEl) {
  history = [];
  lastKickoff = kickoff;
  const data = await callApi({ kickoff }, statusEl);
  render(data);
  $("inputCard").classList.add("hidden");
  $("results").classList.remove("hidden");
  $("results").scrollIntoView({ behavior: "smooth" });
}

$("go").addEventListener("click", async () => {
  const worksheetText = $("source").value;
  if (!worksheetText.trim()) {
    $("status").textContent = "Paste some text or load a file first.";
    return;
  }
  try {
    await runKickoff(
      { mode, worksheetText },
      $("status"),
    );
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
    const data = await callApi({ history, instruction }, $("status2"));
    render(data);
    $("instruction").value = "";
  } catch (err) {
    $("status2").textContent = err.message;
  }
});

// "Try again" = a fresh guess from the same worksheet (new suggestions; current ones discarded).
$("tryAgain").addEventListener("click", async () => {
  if (!lastKickoff) return;
  try {
    await runKickoff(lastKickoff, $("status2"));
  } catch (err) {
    $("status2").textContent = err.message;
  }
});

// "Start over" = back to the compose form. Fields stay pre-filled so the user can
// tweak and regenerate, or clear the box for a brand-new task.
$("startOver").addEventListener("click", () => {
  history = [];
  lastKickoff = null;
  $("results").classList.add("hidden");
  $("inputCard").classList.remove("hidden");
  $("options").innerHTML = "";
  $("summary").innerHTML = "";
  $("status").textContent = "";
  $("status2").textContent = "";
  window.scrollTo({ top: 0, behavior: "smooth" });
});

// --- rendering ---
let lastData = null;
function render(data) {
  lastData = data;
  $("summary").textContent = data.summary || "";
  const wrap = $("options");
  wrap.innerHTML = "";
  (data.options || []).forEach((opt, i) => wrap.appendChild(accordionItem(opt, i)));
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function optionSections(opt) {
  const frag = document.createDocumentFragment();
  if (opt.angle) frag.appendChild(el("p", "angle", opt.angle));
  frag.appendChild(section("Scenario", opt.scenario));
  frag.appendChild(section("Brief", opt.brief));
  frag.appendChild(section("Deliverable", opt.deliverable));

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
  frag.appendChild(lbs);

  const rb = el("div", "block");
  rb.appendChild(el("h4", null, "Rubric (1–5)"));
  const rul = el("ul", "rubric");
  (opt.rubric || []).forEach((r) => rul.appendChild(el("li", null, `${r.score} — ${r.descriptor}`)));
  rb.appendChild(rul);
  frag.appendChild(rb);

  frag.appendChild(section("Why it works", opt.why_it_works));

  const ck = el("div", "block");
  ck.appendChild(el("h4", null, "Pre-pilot checklist"));
  const cul = el("ul", "checklist");
  (opt.checklist || []).forEach((c) => {
    const li = el("li", c.status === "ok" ? "ok" : "warn");
    li.textContent = `${c.status === "ok" ? "✓" : "⚠"} ${c.item}${c.note ? " — " + c.note : ""}`;
    cul.appendChild(li);
  });
  ck.appendChild(cul);
  frag.appendChild(ck);
  return frag;
}

function downloadButtons(opt, i) {
  const dl = el("div", "dl-wrap");
  const md = el("button", "ghost small", "Download .md");
  md.addEventListener("click", (e) => { e.stopPropagation(); downloadOption(opt, i, "md"); });
  const dx = el("button", "ghost small", "Download .docx");
  dx.addEventListener("click", (e) => { e.stopPropagation(); downloadOption(opt, i, "docx"); });
  dl.append(md, dx);
  return dl;
}

function accordionItem(opt, i) {
  const item = el("div", "card acc-item");
  const head = el("div", "acc-head");
  const title = el("div", "acc-title");
  title.appendChild(el("h3", null, `${i + 1}. ${opt.title}`));
  if (opt.angle) title.appendChild(el("p", "angle", opt.angle));
  const right = el("div", "acc-right");
  right.appendChild(downloadButtons(opt, i));
  right.appendChild(el("span", "chev", "▸"));
  head.appendChild(title);
  head.appendChild(right);
  head.addEventListener("click", () => {
    const open = item.classList.toggle("open");
    right.querySelector(".chev").textContent = open ? "▾" : "▸";
  });
  const body = el("div", "acc-body");
  body.appendChild(optionSections(opt));
  item.appendChild(head);
  item.appendChild(body);
  return item;
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

async function downloadOption(opt, i, fmt) {
  const slug = (opt.title || `task-${i + 1}`).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const filename = `task-design-${slug}.${fmt}`;
  try {
    const blob =
      fmt === "docx"
        ? await optionToDocxBlob(opt)
        : new Blob([optionToMarkdown(opt)], { type: "text/markdown" });
    saveBlob(blob, filename);
  } catch (err) {
    console.error(err);
    alert(`Could not create ${filename}: ${err.message}`);
  }
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Real .docx built in the browser via the `docx` library. Lazy-imported so a CDN
// failure can't break the rest of the app — only this download fails (caught above).
async function optionToDocxBlob(opt) {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } =
    await import("https://esm.sh/docx@8.5.0");
  const h = (text) => new Paragraph({ text, heading: HeadingLevel.HEADING_2, spacing: { before: 200, after: 80 } });
  const para = (text) => new Paragraph({ children: [new TextRun(text || "")], spacing: { after: 80 } });
  const bullet = (text) => new Paragraph({ text, bullet: { level: 0 }, spacing: { after: 40 } });
  const boldBullet = (label, rest) =>
    new Paragraph({
      bullet: { level: 0 },
      spacing: { after: 40 },
      children: [new TextRun({ text: label, bold: true }), new TextRun({ text: ` — ${rest}` })],
    });

  const children = [];
  children.push(new Paragraph({ text: opt.title || "Task design", heading: HeadingLevel.HEADING_1 }));
  if (opt.angle) children.push(new Paragraph({ children: [new TextRun({ text: opt.angle, italics: true })], spacing: { after: 120 } }));
  children.push(h("Scenario"), para(opt.scenario));
  children.push(h("Brief"), para(opt.brief));
  children.push(h("Deliverable"), para(opt.deliverable));
  children.push(h("Load-bearing specifics"));
  (opt.load_bearing_specifics || []).forEach((s) => children.push(boldBullet(s.detail, s.why_generic_answers_miss_it)));
  children.push(h("Rubric (1–5)"));
  (opt.rubric || []).forEach((r) => children.push(bullet(`${r.score}. ${r.descriptor}`)));
  children.push(h("Why it works"), para(opt.why_it_works));
  children.push(h("Pre-pilot checklist"));
  (opt.checklist || []).forEach((c) => children.push(bullet(`${c.status === "ok" ? "✓" : "⚠"} ${c.item}${c.note ? ` — ${c.note}` : ""}`)));
  children.push(
    new Paragraph({
      spacing: { before: 200 },
      children: [new TextRun({ text: "Draft from Task Forge for the keep-asking study (HREC 83897). Review and sign off before piloting.", italics: true, color: "666666" })],
    }),
  );

  return await Packer.toBlob(new Document({ sections: [{ children }] }));
}

import * as pdfjs from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.min.mjs";
pdfjs.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs";

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

const DISCLAIMER =
  "Stress-test results flag where a generic AI answer might already cover the task, or where it could better reward students questioning the AI. These are prompts for your awareness — not required fixes — and anything highlighted may be an intentional part of your design. Keep what's deliberate.";

// --- workspace state (persisted per-browser) ---
const KEY = "tf-workspace";
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    return s && Array.isArray(s.ideas) ? s : null;
  } catch {
    return null;
  }
}
function save() {
  localStorage.setItem(KEY, JSON.stringify(state));
}
let state = load() || { boxText: "", fileName: null, ideas: [], visited: false };
let openSet = new Set(); // open-accordion keys; survives re-renders
let uidCounter = state.ideas.reduce((m, i) => Math.max(m, i.id || 0), 0);
let refineTargetId = null;
const find = (id) => state.ideas.find((i) => i.id === id);

// --- file parsing (in browser; raw file never leaves the machine) ---
async function extractText(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".txt") || name.endsWith(".md") || name.endsWith(".qmd")) return await file.text();
  if (name.endsWith(".docx")) {
    const buf = await file.arrayBuffer();
    const { value } = await mammoth.extractRawText({ arrayBuffer: buf });
    return value;
  }
  if (name.endsWith(".pdf")) {
    const data = await file.arrayBuffer();
    const pdf = await pdfjs.getDocument({ data }).promise;
    let out = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await (await pdf.getPage(i)).getTextContent();
      out += page.items.map((it) => it.str).join(" ") + "\n";
    }
    return out;
  }
  throw new Error("Unsupported file type (use .docx, .pdf, .txt, .md, or .qmd).");
}

// --- API ---
async function api(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status}).`);
  return json;
}
const setHint = (msg) => { $("hint").textContent = msg || ""; };

// --- actions ---
async function doGenerate() {
  const t = $("box").value.trim();
  if (!t) return;
  setHint("Generating… (this can take 20–40s)");
  try {
    const { data } = await api("/api/generate", { kickoff: { worksheetText: t } });
    const fresh = (data.options || []).map((opt) => ({
      id: ++uidCounter,
      title: opt.title || "Task design",
      kind: "generated",
      content: opt,
      stress: null,
    }));
    if (!fresh.length) throw new Error("No ideas returned. Try again.");
    state.ideas.push(...fresh);
    save();
    renderList();
  } catch (e) {
    alert(e.message);
  } finally {
    setHint("");
    updateActions();
  }
}

function doAdd() {
  const t = $("box").value.trim();
  if (!t) return;
  state.ideas.push({
    id: ++uidCounter,
    title: (t.slice(0, 60).trim() + (t.length > 60 ? "…" : "")) || "My task",
    kind: "imported",
    content: { freeText: t },
    stress: null,
  });
  save();
  renderList();
  updateActions();
}

async function doStress(id) {
  const idea = find(id);
  if (!idea) return;
  setHint("Stress-testing…");
  try {
    const { result } = await api("/api/stress", { idea: idea.content });
    idea.stress = result;
    openSet.add("stress-" + id);
    save();
    renderList();
  } catch (e) {
    alert(e.message);
  } finally {
    setHint("");
  }
}

function doDelete(id) {
  state.ideas = state.ideas.filter((i) => i.id !== id);
  save();
  renderList();
  updateActions();
}

function doClear() {
  if (!confirm("Clear ALL saved work in this browser? This cannot be undone.")) return;
  state = { boxText: $("box").value, fileName: state.fileName, ideas: [], visited: state.visited };
  save();
  renderList();
  updateActions();
}

async function doRefineGo() {
  const instr = $("refineInstr").value.trim();
  if (!instr || refineTargetId == null) return;
  const idea = find(refineTargetId);
  if (!idea) { closeRefine(); return; }
  $("refineGo").disabled = true;
  setHint("Refining…");
  try {
    const { idea: revised } = await api("/api/refine", { idea: idea.content, instruction: instr });
    idea.content = revised;
    if (revised && revised.title) idea.title = revised.title;
    idea.stress = null;
    openSet.add("wrap-" + idea.id);
    openSet.add("idea-" + idea.id);
    closeRefine();
    save();
    renderList();
  } catch (e) {
    alert(e.message);
  } finally {
    $("refineGo").disabled = false;
    setHint("");
  }
}
function openRefine(id) {
  refineTargetId = id;
  const idea = find(id);
  $("refineTitle").textContent = idea ? idea.title : "";
  $("refineInstr").value = "";
  $("refineOverlay").hidden = false;
  setTimeout(() => $("refineInstr").focus(), 40);
}
function closeRefine() {
  $("refineOverlay").hidden = true;
  refineTargetId = null;
}

// --- rendering ---
function block(title, body) {
  const b = el("div", "block");
  b.appendChild(el("h4", null, title));
  b.appendChild(el("p", null, body || ""));
  return b;
}

function contentBody(idea) {
  const f = document.createDocumentFragment();
  if (idea.content && idea.content.freeText) {
    f.appendChild(block("Your task", idea.content.freeText));
    return f;
  }
  const c = idea.content || {};
  if (c.angle) f.appendChild(el("p", "angle", c.angle));
  f.appendChild(block("Scenario", c.scenario));
  f.appendChild(block("Brief", c.brief));
  f.appendChild(block("Deliverable", c.deliverable));
  const lbs = el("div", "block");
  lbs.appendChild(el("h4", null, "Load-bearing specifics"));
  const ul = el("ul");
  (c.load_bearing_specifics || []).forEach((s) => {
    const li = el("li");
    li.appendChild(el("strong", null, s.detail));
    li.appendChild(document.createTextNode(" — " + s.why_generic_answers_miss_it));
    ul.appendChild(li);
  });
  lbs.appendChild(ul);
  f.appendChild(lbs);
  const rb = el("div", "block");
  rb.appendChild(el("h4", null, "Rubric (1–5)"));
  const rul = el("ul", "rubric");
  (c.rubric || []).forEach((r) => rul.appendChild(el("li", null, `${r.score} — ${r.descriptor}`)));
  rb.appendChild(rul);
  f.appendChild(rb);
  f.appendChild(block("Why it works", c.why_it_works));
  const ck = el("div", "block");
  ck.appendChild(el("h4", null, "Pre-pilot checklist"));
  const cul = el("ul", "checklist");
  (c.checklist || []).forEach((c2) => {
    const li = el("li", c2.status === "ok" ? "ok" : "warn");
    li.textContent = `${c2.status === "ok" ? "✓" : "⚠"} ${c2.item}${c2.note ? " — " + c2.note : ""}`;
    cul.appendChild(li);
  });
  ck.appendChild(cul);
  f.appendChild(ck);
  return f;
}

function stressBody(s) {
  const f = document.createDocumentFragment();
  f.appendChild(block("Verdict", s.verdict));
  const lbs = el("div", "block");
  lbs.appendChild(el("h4", null, "Where it could bite harder"));
  const ul = el("ul");
  (s.specifics || []).forEach((x) => {
    const li = el("li");
    li.appendChild(el("strong", null, x.detail));
    li.appendChild(document.createTextNode(" — " + x.why));
    ul.appendChild(li);
  });
  lbs.appendChild(ul);
  f.appendChild(lbs);
  f.appendChild(block("Improved brief (optional)", s.improved_brief));
  f.appendChild(el("p", "disclaimer", DISCLAIMER));
  return f;
}

function toggle(key, node, chevEl) {
  const open = node.classList.toggle("open");
  if (open) openSet.add(key);
  else openSet.delete(key);
  if (chevEl) chevEl.textContent = open ? "▾" : "▸";
}

function renderIdea(idea) {
  const wrap = el("div", "idea" + (openSet.has("wrap-" + idea.id) ? " open" : ""));
  const head = el("div", "ihead");
  const meta = el("div", "meta");
  meta.appendChild(el("h3", null, idea.title));
  meta.appendChild(el("p", "sub muted", idea.kind === "imported" ? "Your task (imported)" : idea.content && idea.content.angle || ""));
  const acts = el("div", "acts");
  acts.appendChild(el("span", "tag " + idea.kind, idea.kind === "imported" ? "Imported" : "Generated"));
  const ref = el("button", "ghost small", "Refine");
  ref.title = "Refine this idea with an instruction";
  ref.addEventListener("click", (e) => { e.stopPropagation(); openRefine(idea.id); });
  acts.appendChild(ref);
  const del = el("button", "del", "Delete");
  del.title = "Delete this idea";
  del.addEventListener("click", (e) => { e.stopPropagation(); doDelete(idea.id); });
  acts.appendChild(del);
  acts.appendChild(el("span", "chev", openSet.has("wrap-" + idea.id) ? "▾" : "▸"));
  head.appendChild(meta);
  head.appendChild(acts);
  head.addEventListener("click", () => toggle("wrap-" + idea.id, wrap, acts.querySelector(".chev")));

  const body = el("div", "ibody");

  // Idea sub-accordion (with downloads)
  const ideaSub = el("div", "sub" + (openSet.has("idea-" + idea.id) ? " open" : ""));
  const ish = el("div", "sub-head");
  ish.appendChild(el("span", "lbl", "💡 Idea"));
  const dl = el("div", "dl");
  const md = el("button", "ghost small", ".md");
  md.title = "Download as Markdown";
  md.addEventListener("click", (e) => { e.stopPropagation(); downloadIdea(idea, "md"); });
  const dx = el("button", "ghost small", ".docx");
  dx.title = "Download as Word";
  dx.addEventListener("click", (e) => { e.stopPropagation(); downloadIdea(idea, "docx"); });
  dl.appendChild(md);
  dl.appendChild(dx);
  ish.appendChild(dl);
  const ishChev = el("span", "chev", openSet.has("idea-" + idea.id) ? "▾" : "▸");
  ish.appendChild(ishChev);
  ish.addEventListener("click", () => toggle("idea-" + idea.id, ideaSub, ishChev));
  const isb = el("div", "sub-body");
  isb.appendChild(contentBody(idea));
  ideaSub.appendChild(ish);
  ideaSub.appendChild(isb);
  body.appendChild(ideaSub);

  // Stress block
  const stress = el("div", "stress" + (idea.stress && openSet.has("stress-" + idea.id) ? " open" : ""));
  const sh = el("div", "stress-head" + (idea.stress ? " clickable" : ""));
  sh.appendChild(el("span", "lbl", "🧪 Stress test"));
  if (idea.stress) {
    sh.appendChild(el("span", "status done", "Done ✓"));
    const rerun = el("button", "ghost small", "Re-run");
    rerun.title = "Re-run the stress test (replaces the current result)";
    rerun.addEventListener("click", (e) => { e.stopPropagation(); doStress(idea.id); });
    sh.appendChild(rerun);
    const shChev = el("span", "chev", openSet.has("stress-" + idea.id) ? "▾" : "▸");
    sh.appendChild(shChev);
    sh.addEventListener("click", () => toggle("stress-" + idea.id, stress, shChev));
    const sb = el("div", "stress-body");
    sb.appendChild(stressBody(idea.stress));
    stress.appendChild(sh);
    stress.appendChild(sb);
  } else {
    sh.appendChild(el("span", "status notrun", "Not run"));
    const cta = el("button", "primary small", "Stress test this idea");
    cta.title = "Run a stress test on this idea";
    cta.addEventListener("click", (e) => { e.stopPropagation(); doStress(idea.id); });
    sh.appendChild(cta);
    stress.appendChild(sh);
    const note = el("div", "stress-note");
    note.appendChild(el("p", "disclaimer", DISCLAIMER));
    stress.appendChild(note);
  }
  body.appendChild(stress);

  wrap.appendChild(head);
  wrap.appendChild(body);
  return wrap;
}

function renderList() {
  const wrap = $("ideas");
  wrap.innerHTML = "";
  if (!state.ideas.length) {
    wrap.appendChild(el("div", "empty", "No ideas yet. Paste a worksheet and Generate, or paste a task and Add idea."));
    return;
  }
  state.ideas.forEach((idea) => wrap.appendChild(renderIdea(idea)));
}

function updateActions() {
  const boxHas = $("box").value.trim().length > 0;
  $("btnGenerate").disabled = !boxHas;
  $("btnAdd").disabled = !boxHas;
  $("btnClear").disabled = state.ideas.length === 0;
}

function render() {
  $("box").value = state.boxText || "";
  $("fileName").textContent = state.fileName ? `📄 ${state.fileName}` : "";
  renderList();
  updateActions();
}

// --- downloads (.md / .docx) ---
function ideaToMarkdown(idea) {
  if (idea.content && idea.content.freeText) return `# ${idea.title}\n\n${idea.content.freeText}\n`;
  const c = idea.content || {};
  let md = `# ${c.title || idea.title}\n\n`;
  if (c.angle) md += `*${c.angle}*\n\n`;
  md += `## Scenario\n${c.scenario}\n\n## Brief\n${c.brief}\n\n## Deliverable\n${c.deliverable}\n\n`;
  md += `## Load-bearing specifics\n` + (c.load_bearing_specifics || []).map((s) => `- **${s.detail}** — ${s.why_generic_answers_miss_it}`).join("\n") + "\n\n";
  md += `## Rubric\n` + (c.rubric || []).map((r) => `${r.score} — ${r.descriptor}`).join("\n") + "\n\n";
  md += `## Why it works\n${c.why_it_works}\n\n`;
  md += `## Pre-pilot checklist\n` + (c.checklist || []).map((c2) => `${c2.status === "ok" ? "✓" : "⚠"} ${c2.item}${c2.note ? " — " + c2.note : ""}`).join("\n");
  return md;
}

async function ideaToDocxBlob(idea) {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = await import("https://esm.sh/docx@8.5.0");
  const h2 = (t) => new Paragraph({ text: t, heading: HeadingLevel.HEADING_2, spacing: { before: 200, after: 80 } });
  const para = (t) => new Paragraph({ children: [new TextRun(t || "")], spacing: { after: 80 } });
  const bullet = (t) => new Paragraph({ text: t, bullet: { level: 0 }, spacing: { after: 40 } });
  const boldBullet = (l, r) => new Paragraph({ bullet: { level: 0 }, spacing: { after: 40 }, children: [new TextRun({ text: l, bold: true }), new TextRun({ text: ` — ${r}` })] });

  const ch = [];
  ch.push(new Paragraph({ text: idea.title, heading: HeadingLevel.HEADING_1 }));
  if (idea.content && idea.content.freeText) {
    ch.push(para(idea.content.freeText));
  } else {
    const c = idea.content || {};
    if (c.angle) ch.push(new Paragraph({ children: [new TextRun({ text: c.angle, italics: true })], spacing: { after: 120 } }));
    ch.push(h2("Scenario"), para(c.scenario));
    ch.push(h2("Brief"), para(c.brief));
    ch.push(h2("Deliverable"), para(c.deliverable));
    ch.push(h2("Load-bearing specifics"));
    (c.load_bearing_specifics || []).forEach((s) => ch.push(boldBullet(s.detail, s.why_generic_answers_miss_it)));
    ch.push(h2("Rubric (1–5)"));
    (c.rubric || []).forEach((r) => ch.push(bullet(`${r.score}. ${r.descriptor}`)));
    ch.push(h2("Why it works"), para(c.why_it_works));
    ch.push(h2("Pre-pilot checklist"));
    (c.checklist || []).forEach((c2) => ch.push(bullet(`${c2.status === "ok" ? "✓" : "⚠"} ${c2.item}${c2.note ? " — " + c2.note : ""}`)));
  }
  ch.push(new Paragraph({ spacing: { before: 200 }, children: [new TextRun({ text: "Draft from Task Forge for the keep-asking study (HREC 83897). Review and sign off before piloting.", italics: true, color: "666666" })] }));
  return await Packer.toBlob(new Document({ sections: [{ children: ch }] }));
}

async function downloadIdea(idea, fmt) {
  const slug = ((idea.title || "task").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)) || "task";
  try {
    const blob = fmt === "docx" ? await ideaToDocxBlob(idea) : new Blob([ideaToMarkdown(idea)], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `task-design-${slug}.${fmt}`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error(err);
    alert(`Could not create .${fmt}: ${err.message}`);
  }
}

// --- wire up ---
$("btnGenerate").addEventListener("click", doGenerate);
$("btnAdd").addEventListener("click", doAdd);
$("btnClear").addEventListener("click", doClear);
$("box").addEventListener("input", () => { state.boxText = $("box").value; save(); updateActions(); });
$("file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  setHint("Reading file…");
  try {
    const text = await extractText(file);
    $("box").value = text;
    state.boxText = text;
    state.fileName = file.name;
    save();
    $("fileName").textContent = `📄 ${file.name}`;
  } catch (err) {
    alert(err.message);
  } finally {
    setHint("");
    updateActions();
    e.target.value = "";
  }
});
$("refineCancel").addEventListener("click", closeRefine);
$("refineGo").addEventListener("click", doRefineGo);
$("refineInstr").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) doRefineGo(); });
if (!state.visited) { $("overlay").hidden = false; }
$("btnDismiss").addEventListener("click", () => { state.visited = true; save(); $("overlay").hidden = true; });

render();

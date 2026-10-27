import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import { fileURLToPath } from "node:url";

const base = path.dirname(fileURLToPath(import.meta.url));
const resultsPath = path.join(base, "results", "results.json");
const outputPath = path.join(base, "results", "Waiter_Benchmark_Meeting_Brief.pdf");
const results = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
const cfg = results.configs;
const ink = "#102033";
const muted = "#526277";
const blue = "#2563eb";
const teal = "#0f766e";
const violet = "#7c3aed";
const orange = "#ea580c";
const gray = "#94a3b8";
const colors = { "keyword-v1": gray, bm25: blue, vector: teal, hybrid: violet, "hybrid+exp": orange };
const labels = { "keyword-v1": "Keyword v1", bm25: "BM25", vector: "Vector", hybrid: "Hybrid RRF", "hybrid+exp": "Hybrid + query expansion" };
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const doc = new PDFDocument({ size: "A4", margin: 42, bufferPages: true, info: { Title: "Waiter LongMemEval-S Meeting Brief", Author: "Waiter contributors", Subject: "Retrieval-only benchmark results and caveats" } });
const outputStream = fs.createWriteStream(outputPath);
doc.pipe(outputStream);
const W = doc.page.width - 84;
const L = 42;

function topBand(title, subtitle, page) {
  doc.fillColor("#f1f5f9").rect(0, 0, doc.page.width, 104).fill();
  doc.fillColor(blue).rect(0, 0, doc.page.width, 5).fill();
  doc.fillColor(ink).font("Helvetica-Bold").fontSize(22).text(title, L, 28, { width: W });
  doc.fillColor(muted).font("Helvetica").fontSize(9).text(subtitle, L, 61, { width: W });
  doc.fillColor(muted).fontSize(7).text(`WAITER - LONGMEMEVAL-S CLEANED - ${page}`, L, 84, { width: W, align: "right" });
  doc.y = 122;
}
function section(title, y = doc.y) {
  doc.fillColor(ink).font("Helvetica-Bold").fontSize(12).text(title, L, y);
  doc.y = y + 20;
}
function paragraph(text, opts = {}) {
  const x = opts.x ?? L;
  const width = opts.width ?? W;
  const y = opts.y ?? doc.y;
  doc.fillColor(opts.color ?? muted).font(opts.bold ? "Helvetica-Bold" : "Helvetica").fontSize(opts.size ?? 8.5)
    .text(text, x, y, { width, lineGap: 1.8, align: opts.align ?? "left" });
  if (opts.advance !== false) doc.y = Math.max(doc.y, y + doc.heightOfString(text, { width, lineGap: 1.8, font: opts.bold ? "Helvetica-Bold" : "Helvetica", fontSize: opts.size ?? 8.5 }) + 5);
}
function card(x, y, w, label, value, note, color) {
  doc.fillColor("#f8fafc").roundedRect(x, y, w, 65, 7).fill();
  doc.fillColor(color).rect(x, y, 3, 65).fill();
  doc.fillColor(muted).font("Helvetica").fontSize(7).text(label.toUpperCase(), x + 12, y + 10, { width: w - 20 });
  doc.fillColor(ink).font("Helvetica-Bold").fontSize(19).text(value, x + 12, y + 24, { width: w - 20 });
  doc.fillColor(muted).font("Helvetica").fontSize(6.5).text(note, x + 12, y + 49, { width: w - 20 });
}
function drawBars(rows, options = {}) {
  const x = options.x ?? L;
  const y = options.y ?? doc.y;
  const width = options.width ?? W;
  const max = options.max ?? 1;
  const labelWidth = options.labelWidth ?? 132;
  const valueWidth = options.valueWidth ?? 46;
  const plotWidth = width - labelWidth - valueWidth;
  const rowH = options.rowHeight ?? 25;
  const barH = options.barHeight ?? 9;
  const colorsByKey = options.colors ?? colors;
  rows.forEach((r, i) => {
    const yy = y + i * rowH;
    if (options.zebra && i % 2 === 1) doc.fillColor("#f8fafc").rect(x, yy - 3, width, rowH).fill();
    doc.fillColor(ink).font("Helvetica").fontSize(options.fontSize ?? 7.5).text(r.label, x + 2, yy, { width: labelWidth - 8, height: rowH - 2, ellipsis: true, lineBreak: false });
    const barX = x + labelWidth;
    doc.fillColor("#e2e8f0").roundedRect(barX, yy + (rowH - barH) / 2, plotWidth - 4, barH, 3).fill();
    const bw = Math.max(1, Math.min(plotWidth - 4, (r.value / max) * (plotWidth - 4)));
    doc.fillColor(r.color ?? colorsByKey[r.key] ?? blue).roundedRect(barX, yy + (rowH - barH) / 2, bw, barH, 3).fill();
    doc.fillColor(ink).font("Helvetica-Bold").fontSize(options.fontSize ?? 7.5).text(r.display ?? pct(r.value), x + width - valueWidth + 2, yy, { width: valueWidth - 3, align: "right", lineBreak: false });
  });
  doc.y = y + rows.length * rowH;
}
function footer(page) {
  const bottom = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  doc.fillColor("#94a3b8").font("Helvetica").fontSize(7).text(`Waiter - generated from checked-in benchmark results - ${page}`, L, doc.page.height - 29, { width: W, align: "center" });
  doc.page.margins.bottom = bottom;
}
function gridTable({ x, y, widths, rows, rowHeight = 18, fontSize = 7, headerFill = "#eaf0f8", zebra = true }) {
  rows.forEach((row, ri) => {
    const yy = y + ri * rowHeight;
    if (ri === 0) doc.fillColor(headerFill).rect(x, yy - 2, widths.reduce((a, b) => a + b, 0), rowHeight).fill();
    else if (zebra && ri % 2 === 0) doc.fillColor("#f8fafc").rect(x, yy - 2, widths.reduce((a, b) => a + b, 0), rowHeight).fill();
    let xx = x;
    row.forEach((v, ci) => {
      doc.fillColor(ri === 0 || ci === 0 ? ink : muted)
        .font(ri === 0 || ci === 0 ? "Helvetica-Bold" : "Helvetica")
        .fontSize(fontSize)
        .text(v, xx + 4, yy + 2, { width: widths[ci] - 8, height: rowHeight - 4, ellipsis: true, lineBreak: false });
      xx += widths[ci];
    });
  });
}

// Page 1: measured results and the core message.
topBand("Waiter", "A self-hosted memory retrieval API - LongMemEval-S results for discussion", "MEETING BRIEF");
const gap = 9;
const cw = (W - gap * 3) / 4;
const hybrid = cfg.hybrid;
card(L, 126, cw, "Hybrid RRF - Recall@1", pct(hybrid["recall@1"].mean), "+/-3.3 pp; 365 held-out questions", violet);
card(L + cw + gap, 126, cw, "Hybrid RRF - MRR@20", pct(hybrid["mrr@20"].mean), "rank of first relevant session", blue);
card(L + 2 * (cw + gap), 126, cw, "Hybrid RRF - Recall@20", pct(hybrid["recall@20"].mean), "saturated at this candidate count", teal);
card(L + 3 * (cw + gap), 126, cw, "Warm retrieval p50", `${hybrid.latency_ms.p50.toFixed(2)} ms`, "in-process; excludes embedding", orange);

section("Recall@1 - Waiter retrieval configurations", 214);
paragraph("Higher is better. The best observed result is query expansion at 57.1%; its +0.1-point difference over plain Hybrid RRF is within uncertainty and does not establish a real gain.", { y: 232, size: 8 });
drawBars(Object.keys(labels).map((key) => ({ label: labels[key], key, value: cfg[key]["recall@1"].mean, display: `${pct(cfg[key]["recall@1"].mean)} +/-${(cfg[key]["recall@1"].ci95 * 100).toFixed(1)} pp` })), { y: 264, rowHeight: 25, labelWidth: 134, valueWidth: 92, max: 1, barHeight: 11, fontSize: 7.5 });

const callY = 407;
doc.fillColor("#eff6ff").roundedRect(L, callY, W, 78, 7).fill();
doc.fillColor(blue).rect(L, callY, 3, 78).fill();
paragraph("THE MEETING TAKEAWAY", { x: L + 13, y: callY + 10, width: W - 26, size: 8, bold: true, color: blue, advance: false });
paragraph(`Waiter moved from literal substring matching (Recall@1 ${pct(cfg["keyword-v1"]["recall@1"].mean)}) to BM25 retrieval (Recall@1 ${pct(cfg.bm25["recall@1"].mean)}). Hybrid RRF reaches ${pct(hybrid["recall@1"].mean)}. This demonstrates a useful, reproducible retrieval core—not that Waiter beats Supermemory end-to-end.`, { x: L + 13, y: callY + 25, width: W - 26, size: 8.2 });

section("Ranking metrics (higher is better)", 504);
const widths = [142, 65, 65, 66, 67, W - 405];
const order = ["bm25", "vector", "hybrid", "hybrid+exp"];
const rankingLines = [
  "Configuration | Recall@1 | Recall@10 | Recall@20 | NDCG@10 | MRR@20",
  ...order.map((key) => `${labels[key]} | ${pct(cfg[key]["recall@1"].mean)} | ${pct(cfg[key]["recall@10"].mean)} | ${pct(cfg[key]["recall@20"].mean)} | ${pct(cfg[key]["ndcg@10"].mean)} | ${pct(cfg[key]["mrr@20"].mean)}`),
];
rankingLines.forEach((line, i) => {
  const yy = 524 + i * 17;
  if (i === 0) doc.fillColor("#eaf0f8").rect(L, yy - 2, W, 17).fill();
  else if (i % 2 === 0) doc.fillColor("#f8fafc").rect(L, yy - 2, W, 17).fill();
  doc.fillColor(i === 0 ? ink : muted).font(i === 0 ? "Helvetica-Bold" : "Helvetica").fontSize(6.7)
    .text(line, L + 3, yy + 2, { width: W - 6, lineBreak: false });
});
paragraph(`Dataset: 500 cleaned LongMemEval-S questions; 135 dev / 365 test, split by question-id hash. One indexed memory per session. Embeddings: local all-MiniLM-L6-v2. No answer model or LLM judge was run.`, { y: 635, size: 7.6, color: muted });
footer("1 / 2");

// Page 2: category detail and careful market comparison.
doc.addPage();
topBand("Where Waiter works - and where to be careful", "Category results, public competitor claims, and what a fair comparison would require", "EVIDENCE & CAVEATS");
section("Recall@1 by LongMemEval question category", 124);
paragraph("BM25 and vector retrieval complement each other on some categories. Preference has only 23 test examples; read that result as an indication, not a firm ranking.", { y: 142, size: 8 });
const typeOrder = ["single-session-user", "single-session-assistant", "single-session-preference", "knowledge-update", "temporal-reasoning", "multi-session"];
const typeLabels = { "single-session-user": "Single-session user", "single-session-assistant": "Single-session assistant", "single-session-preference": "Single-session preference", "knowledge-update": "Knowledge update", "temporal-reasoning": "Temporal reasoning", "multi-session": "Multi-session" };
const categoryRows = typeOrder.map((t) => {
  const p = results.perType[t];
  return { label: `${typeLabels[t]} (n=${p.bm25.n})`, value: p.hybrid.r1, display: `Hybrid ${pct(p.hybrid.r1)}`, color: violet };
});
drawBars(categoryRows, { y: 176, rowHeight: 27, labelWidth: 185, valueWidth: 80, max: 1, barHeight: 11, fontSize: 7.5 });
// Compact numeric comparison table.
let startY = 344;
const categoryLines = [
  "Category (n) | BM25 R@1 | Vector R@1 | Hybrid R@1",
  ...typeOrder.map((t) => {
    const p = results.perType[t];
    return `${typeLabels[t]} (n=${p.bm25.n}) | ${pct(p.bm25.r1)} | ${pct(p.vector.r1)} | ${pct(p.hybrid.r1)}`;
  }),
];
categoryLines.forEach((line, i) => {
  const y = startY + i * 18;
  if (i === 0) doc.fillColor("#eaf0f8").rect(L, y - 2, W, 17).fill();
  else if (i % 2 === 0) doc.fillColor("#f8fafc").rect(L, y - 2, W, 17).fill();
  doc.fillColor(i === 0 ? ink : muted)
    .font(i === 0 ? "Helvetica-Bold" : "Helvetica")
    .fontSize(7.1)
    .text(line, L + 4, y + 2, { width: W - 8, lineBreak: false });
});

const notesY = 496;
doc.fillColor("#fff7ed").roundedRect(L, notesY, W, 58, 6).fill();
doc.fillColor(orange).rect(L, notesY, 3, 58).fill();
paragraph("WHAT WE CAN SAY ABOUT SUPERMEMORY", { x: L + 12, y: notesY + 8, width: W - 24, size: 7.8, bold: true, color: orange, advance: false });
paragraph("Supermemory's research report publishes 97% LongMemEval-S Recall@20 with aggregation; its GitHub README separately advertises 95% Recall@15 and 99.4% context reduction. These are vendor-published claims. Waiter's 98.8% Recall@20 is from a cleaned, session-retrieval run without the same stated aggregation protocol: it is not a head-to-head win or proof of parity. BM25 alone already scores 97.8% here, so Recall@20 is saturated.", { x: L + 12, y: notesY + 21, width: W - 24, size: 7.3 });

section("Scope comparison", 567);
const scopeLines = [
  "WAITER today: BM25 + optional vectors + RRF; caller writes text; in-memory Node/Express; retrieval only.",
  "Supermemory public description: memory extraction, profiles, hybrid search/RAG, atomic memories, relations, temporal grounding.",
  "Evaluation: Waiter retrieval results here; Supermemory vendor-published LongMemEval claims, not reproduced here.",
];
scopeLines.forEach((line, i) => {
  const y = 589 + i * 25;
  if (i % 2 === 1) doc.fillColor("#f8fafc").rect(L, y - 2, W, 22).fill();
  doc.fillColor(i === 0 ? ink : muted).font(i === 0 ? "Helvetica-Bold" : "Helvetica").fontSize(7.1)
    .text(line, L + 4, y + 2, { width: W - 8, lineBreak: false });
});
paragraph("FAIR NEXT STEP", { y: 657, size: 7.5, bold: true, color: blue, advance: false });
paragraph("A head-to-head needs the same dataset version, ingestion and aggregation protocol, answer model, judge prompts and token budget, plus per-question scores for a paired confidence interval. Waiter has not run LoCoMo, ConvoMem, or the LongMemEval QA half.", { y: 669, size: 7.2 });
paragraph("Sources: supermemory.ai/research/longmembench; github.com/supermemoryai/supermemory; github.com/xiaowu0162/LongMemEval. Raw Waiter run: bench/results/results.json.", { y: 704, size: 6.5, color: muted });
footer("2 / 2");

doc.end();
await new Promise((resolve, reject) => {
  outputStream.on("finish", resolve);
  outputStream.on("error", reject);
});
console.log(`Wrote ${outputPath}`);

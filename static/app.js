/* Breeze TTS 2 控制台 — 前端逻辑 */
"use strict";

const $ = (id) => document.getElementById(id);

const MODES = {
  design: {
    title: "音色设计",
    desc: "用文字描述塑造一个全新的声音，无需参考音频。",
    instructLabel: "声音描述",
    instructPh: "一位温和自信的年轻女性，声音清晰，语气亲切，语速平稳自然。",
    textPh: "[笑] 欢迎来到今晚的故事时间。",
    showInstruct: true, showRef: false,
  },
  clone: {
    title: "音色克隆",
    desc: "上传 3–15 秒参考音频和它的准确文字稿，复刻这个声音。",
    instructLabel: "声音描述",
    instructPh: "",
    textPh: "输入要用克隆音色合成的新文稿…",
    showInstruct: false, showRef: true,
  },
  direct: {
    title: "音色执导",
    desc: "在克隆的基础上叠加表演指令：情绪、语速、停顿、身体状态。",
    instructLabel: "表演指令",
    instructPh: "压低声音，语速放慢，句与句之间留出明显的停顿。",
    textPh: "输入要合成的新文稿…",
    showInstruct: true, showRef: true,
  },
  dialogue: {
    title: "对话配音",
    desc: "为每句台词指派音色库中的角色，一次生成多人对话音频。",
    instructLabel: "声音描述",
    instructPh: "",
    textPh: "",
    showInstruct: false, showRef: false, isDialogue: true,
  },
};

const MODE_BADGE = {
  design: ["design", "设计"], clone: ["clone", "克隆"],
  direct: ["clone", "执导"], dialogue: ["design", "对话"],
};
const PIPELINE = ["排队", "加载模型", "文稿分段", "逐句合成", "拼接静音", "响度归一化", "完成"];
const VIEWS = ["editor", "voices", "templates", "history", "dashboard"];

const S = {
  view: "editor",
  mode: "design",
  model: "4bit",
  format: "wav",
  instructByMode: { design: "", clone: "", direct: "" },
  textByMode: { design: "", clone: "", direct: "" },
  lines: [{ voice_id: "", text: "" }],
  refFile: null,
  refVoice: null, // {id, name}
  pollTimer: null,
  jobId: null,
  jobQueue: [],
  modelSwitchJob: null,
  lastJob: null,
  voices: [],
  templates: [],
  historyItems: [],
  wave: null,
  histPlaying: null,
};

/* ---------------- 工具 ---------------- */
function toast(msg, type = "info") {
  const el = document.createElement("div");
  el.className = `toast ${type === "error" ? "error" : ""}`;
  el.textContent = msg;
  $("toasts").appendChild(el);
  setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 250);
  }, 3800);
}

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `请求失败（${res.status}）`);
  return data;
}

function fmtBytes(kb) {
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`;
}

/* ---------------- 命名弹窗 ---------------- */
let modalCb = null;
function askName(title, cb, placeholder = "名称") {
  modalCb = cb;
  $("modalTitle").textContent = title;
  $("modalInput").value = "";
  $("modalInput").placeholder = placeholder;
  $("modalMask").classList.remove("hidden");
  setTimeout(() => $("modalInput").focus(), 30);
}
function closeModal() {
  modalCb = null;
  $("modalMask").classList.add("hidden");
}

/* ---------------- 视图切换 ---------------- */
const VIEW_META = {
  editor: null, // 用 MODES
  voices: ["音色库", "保存的音色设计、克隆与执导配置，一键应用到工作台。"],
  templates: ["文稿模板", "常用文稿片段，一键插入工作台继续加工。"],
  history: ["历史记录", "所有已生成的音频，点击左侧按钮即可试听。"],
  dashboard: ["仪表盘", "文字到语音的加工流水线与生成统计。"],
};

function updateNav() {
  document.querySelectorAll(".nav-item").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === S.view));
}

function setView(view) {
  if (!VIEWS.includes(view)) return;
  S.view = view;
  VIEWS.forEach((v) => $(v + "View").classList.toggle("hidden", v !== view));
  const meta = VIEW_META[view] || [MODES[S.mode].title, MODES[S.mode].desc];
  $("viewTitle").textContent = meta ? meta[0] : MODES[S.mode].title;
  $("viewDesc").textContent = meta ? meta[1] : MODES[S.mode].desc;
  updateNav();
  if (view === "history") loadHistory();
  if (view === "voices") loadVoices();
  if (view === "templates") loadTemplates();
  if (view === "dashboard") loadDashboard();
}

function updateModeSeg() {
  document.querySelectorAll("#modeSeg button").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === S.mode));
}

function switchMode(mode) {
  if (!MODES[mode] || mode === S.mode) return;
  const old = S.mode;
  if (old !== "dialogue") S.textByMode[old] = $("textInput").value;
  S.instructByMode[old] = $("instructInput").value;
  S.mode = mode;
  const m = MODES[mode];

  $("textField").classList.toggle("hidden", !!m.isDialogue);
  $("dialogueField").classList.toggle("hidden", !m.isDialogue);
  $("textInput").placeholder = m.textPh;
  $("textInput").value = S.textByMode[mode] || "";
  $("instructLabel").textContent = m.instructLabel;
  $("instructField").classList.toggle("hidden", !m.showInstruct);
  $("refField").classList.toggle("hidden", !m.showRef);
  $("instructInput").value = S.instructByMode[mode] || "";
  $("instructInput").placeholder = m.instructPh;
  updateCharCount();
  updateModeSeg();
  if (m.isDialogue) renderLines();

  if (S.view === "editor") {
    $("viewTitle").textContent = m.title;
    $("viewDesc").textContent = m.desc;
  }
}

/* ---------------- 对话台词编辑器 ---------------- */
function addLine(voice_id = "", text = "") {
  S.lines.push({ voice_id, text });
  renderLines();
}

function renderLines() {
  const box = $("lineList");
  box.innerHTML = "";
  S.lines.forEach((l, i) => box.appendChild(lineRow(l, i)));
}

function lineRow(l, i) {
  const row = document.createElement("div");
  row.className = "line-row";
  const opts = [`<option value="">默认设计音色</option>`]
    .concat(S.voices.map((v) => {
      const [, label] = MODE_BADGE[v.mode] || MODE_BADGE.design;
      return `<option value="${v.id}" ${v.id === l.voice_id ? "selected" : ""}>${escapeHtml(v.name)} · ${label}</option>`;
    })).join("");
  row.innerHTML = `
    <select>${opts}</select>
    <input type="text" value="${escapeHtml(l.text)}" placeholder="第 ${i + 1} 句台词…">
    <button class="line-del" title="删除此行" ${S.lines.length <= 1 ? "disabled" : ""}>✕</button>`;
  const [sel, input] = [row.querySelector("select"), row.querySelector("input")];
  sel.onchange = () => { l.voice_id = sel.value; };
  input.oninput = () => { l.text = input.value; };
  row.querySelector(".line-del").onclick = () => {
    S.lines.splice(i, 1);
    renderLines();
  };
  return row;
}

/* ---------------- 标签 ---------------- */
function renderTags(tagsZh, tagsEn) {
  const box = $("tagRow");
  box.innerHTML = "";
  [...tagsZh, ...tagsEn].forEach((t) => {
    const b = document.createElement("button");
    b.className = "tag";
    b.textContent = t;
    b.onclick = () => insertAtCursor($("textInput"), t);
    box.appendChild(b);
  });
}

function insertAtCursor(ta, s) {
  const st = ta.selectionStart ?? ta.value.length;
  const en = ta.selectionEnd ?? ta.value.length;
  ta.value = ta.value.slice(0, st) + s + ta.value.slice(en);
  ta.selectionStart = ta.selectionEnd = st + s.length;
  ta.focus();
  updateCharCount();
}

function updateCharCount() {
  $("charCount").textContent = `${$("textInput").value.length} 字`;
}

/* ---------------- 参考音频（文件 or 音色库） ---------------- */
function updateRefChip() {
  const has = !!S.refVoice;
  $("refChip").classList.toggle("hidden", !has);
  if (has) $("refChipName").textContent = `使用音色库参考：${S.refVoice.name}`;
}

/* ---------------- 模型切换 ---------------- */
function updateModelUI() {
  document.querySelectorAll("#modelPills .pill, #modelSwitch .ms-btn").forEach((x) =>
    x.classList.toggle("active", x.dataset.model === S.model));
}

function pickModel(m) {
  if (!m || m === S.model) return;
  S.model = m;
  updateModelUI();
  syncModelLoad();
}

async function syncModelLoad() {
  if (S.jobId) return; // 有任务在跑，生成时会自动加载所选模型
  try {
    const s = await api("/api/status");
    if (!s.loaded_model || s.loaded_model === S.model) return;
    toast(`正在切换模型到 ${S.model} …`);
    const r = await api("/api/model/load", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: S.model }),
    });
    S.jobId = r.job_id;
    S.modelSwitchJob = r.job_id;
    S.pollTimer = setInterval(pollJob, 600);
    pollJob();
  } catch (e) {
    toast(e.message, "error");
  }
}

/* ---------------- 生成 ---------------- */
async function generate() {
  const busy = !!S.jobId || S.jobQueue.length > 0;
  const m = MODES[S.mode];

  let payload, isJson = false;
  if (m.isDialogue) {
    const lines = S.lines.filter((l) => l.text.trim());
    if (!lines.length) { toast("请至少填写一行台词", "error"); return; }
    payload = {
      lines: lines.map((l) => ({ voice_id: l.voice_id, text: l.text.trim() })),
      model: S.model, cfg: parseFloat($("cfg").value), seed: parseInt($("seed").value || "0", 10),
      normalize: $("normalize").checked,
      gap: parseFloat(S.lines.length > 1 ? $("gap").value : 0.25),
      speed: parseFloat($("speed").value), format: S.format,
    };
    isJson = true;
  } else {
    const text = $("textInput").value.trim();
    if (!text) { toast("文稿不能为空", "error"); $("textInput").focus(); return; }
    if (m.showRef && !S.refFile && !S.refVoice) { toast("请上传参考音频，或从音色库应用一个音色", "error"); return; }
    if (m.showRef && !$("refText").value.trim()) { toast("请填写参考音频的准确文字稿", "error"); return; }
    const fd = new FormData();
    fd.append("text", text);
    fd.append("mode", S.mode);
    fd.append("instruct", m.showInstruct ? $("instructInput").value : "");
    fd.append("ref_text", m.showRef ? $("refText").value : "");
    fd.append("model", S.model);
    fd.append("cfg", $("cfg").value);
    fd.append("seed", $("seed").value || "0");
    fd.append("normalize", $("normalize").checked);
    fd.append("auto_split", $("autoSplit").checked);
    fd.append("gap", $("gap").value);
    fd.append("speed", $("speed").value);
    fd.append("format", S.format);
    if (m.showRef && S.refFile) fd.append("ref_audio", S.refFile);
    else if (m.showRef && S.refVoice) fd.append("ref_voice_id", S.refVoice.id);
    payload = fd;
  }

  if (!busy) {
    $("genBtn").disabled = true;
    $("outputEmpty").classList.add("hidden");
    $("outputResult").classList.add("hidden");
    $("outputProgress").classList.remove("hidden");
    setProgress("提交中", "…", 0, 0);
  }

  try {
    const r = isJson
      ? await api("/api/dialogue", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
      : await api("/api/synthesize", { method: "POST", body: payload });
    if (busy) {
      S.jobQueue.push(r.job_id);
      toast(`已加入队列（前方 ${S.jobQueue.length} 个）`);
    } else {
      S.jobId = r.job_id;
      S.pollTimer = setInterval(pollJob, 600);
      pollJob();
    }
  } catch (e) {
    toast(e.message, "error");
    if (!busy) resetGenerateUI();
  }
}

function setProgress(phase, meta, done, total) {
  $("progressPhase").textContent = phase;
  $("progressMeta").textContent = meta;
  const pct = total > 0 ? (done / total) * 100 : (phase === "提交中" ? 3 : 8);
  $("progressFill").style.width = Math.min(100, pct) + "%";
}

async function pollJob() {
  if (!S.jobId) return;
  let j;
  try {
    j = await api(`/api/jobs/${S.jobId}`);
  } catch (e) {
    toast(e.message, "error");
    clearInterval(S.pollTimer); S.pollTimer = null; S.jobId = null;
    resetGenerateUI();
    return;
  }
  S.lastJob = normalizeJob(j);
  if (S.view === "dashboard") renderPipeline(S.lastJob);

  const p = j.progress || { done: 0, total: 0 };
  const isModelJob = j.id === S.modelSwitchJob;
  if (j.status === "queued") {
    if (!isModelJob) setProgress("排队中", j.queue_position ? `前方 ${j.queue_position} 个任务` : "等待中", 0, 0);
  } else if (j.status === "running") {
    if (isModelJob) {
      $("modelName").textContent = `切换中… ${j.phase}`;
    } else {
      const phase = p.total > 1 ? `${j.phase} · ${p.done}/${p.total} 段` : j.phase;
      setProgress(phase, j.elapsed != null ? `已用 ${j.elapsed}s` : "", p.done, p.total);
    }
  } else if (j.status === "done") {
    clearInterval(S.pollTimer); S.pollTimer = null; S.jobId = null;
    if (j.result && j.result.loaded) {
      S.modelSwitchJob = null;
      refreshStatus();
      if (S.view === "dashboard") renderPipeline(S.lastJob);
      if (S.model !== j.result.loaded) {
        syncModelLoad(); // 切换期间用户又选了别的模型，继续切
      } else {
        toast(`已切换到 ${j.result.loaded}`);
      }
    } else {
      showResult(j.result);
      refreshStatus();
      loadHistory();
      if (S.view === "dashboard") loadDashboard();
      toast(j.result && j.result.dialogue ? "对话配音完成" : "生成完成");
    }
    advanceQueue();
  } else if (j.status === "cancelled") {
    clearInterval(S.pollTimer); S.pollTimer = null; S.jobId = null; S.modelSwitchJob = null;
    toast("排队任务已取消");
    advanceQueue();
  } else if (j.status === "error") {
    clearInterval(S.pollTimer); S.pollTimer = null; S.jobId = null; S.modelSwitchJob = null;
    toast(`生成失败：${j.error || "未知错误"}`, "error");
    advanceQueue();
  }
}

function advanceQueue() {
  if (S.jobQueue.length) {
    S.jobId = S.jobQueue.shift();
    $("outputProgress").classList.remove("hidden");
    $("outputResult").classList.add("hidden");
    setProgress("排队中", `队列剩余 ${S.jobQueue.length} 个`, 0, 0);
    S.pollTimer = setInterval(pollJob, 600);
    pollJob();
  } else {
    resetGenerateUI();
  }
}

function normalizeJob(j) {
  return {
    id: j.id, status: j.status, phase: j.phase, elapsed: j.elapsed,
    pipeline: j.pipeline, error: j.error, result: j.result,
    mode: S.mode, text: ($("textInput").value || "").slice(0, 40),
    time: null,
  };
}

function resetGenerateUI() {
  $("genBtn").disabled = false;
  $("outputProgress").classList.add("hidden");
  if ($("outputResult").classList.contains("hidden")) {
    $("outputEmpty").classList.remove("hidden");
  }
}

function showResult(r) {
  $("outputProgress").classList.add("hidden");
  $("outputResult").classList.remove("hidden");
  $("outAudio").src = r.url;
  $("downloadBtn").href = `${r.url}?download=1`;
  $("downloadBtn").setAttribute("download", r.name);
  const info = [
    ["时长", `${r.duration}s`],
    ["耗时", `${r.elapsed}s`],
    ["RTF", r.rtf ?? "-"],
    [r.dialogue ? "台词" : "分段", `${r.segments} 段`],
    ["采样率", `${r.sample_rate} Hz`],
    ["模型", r.model],
  ];
  if (r.speed && r.speed !== 1) info.push(["语速", `${r.speed}×`]);
  if (r.format === "mp3") info.push(["格式", "MP3"]);
  $("infoGrid").innerHTML = info
    .map(([k, v]) => `<div class="info-item"><div class="k">${k}</div><div class="v">${v}</div></div>`).join("");
  drawWaveform(r.url);
}

/* ---------------- 波形 ---------------- */
async function drawWaveform(url) {
  const canvas = $("waveCanvas");
  try {
    const buf = await (await fetch(url)).arrayBuffer();
    const actx = new (window.AudioContext || window.webkitAudioContext)();
    const audio = await actx.decodeAudioData(buf);
    const data = audio.getChannelData(0);
    const peaks = [];
    const buckets = 400;
    const per = Math.max(1, Math.floor(data.length / buckets));
    for (let i = 0; i < buckets; i++) {
      let max = 0;
      const off = i * per;
      for (let k = 0; k < per; k += 24) {
        const v = Math.abs(data[off + k] || 0);
        if (v > max) max = v;
      }
      peaks.push(max);
    }
    S.wave = { peaks, played: 0 };
    actx.close();
    paintWave();
    const player = $("outAudio");
    player.ontimeupdate = () => {
      if (S.wave && player.duration) {
        S.wave.played = player.currentTime / player.duration;
        paintWave();
      }
    };
  } catch {
    canvas.style.display = "none";
  }
}

function paintWave() {
  const canvas = $("waveCanvas");
  if (!S.wave) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const { peaks, played } = S.wave;
  const n = peaks.length;
  const bw = w / n;
  const mid = h / 2;
  for (let i = 0; i < n; i++) {
    const bh = Math.max(2, peaks[i] * (h - 10));
    const x = i * bw;
    const isPlayed = x / w <= played;
    ctx.fillStyle = isPlayed ? "#2dd4bf" : "rgba(255,255,255,0.22)";
    const bwDraw = Math.max(1, bw * 0.62);
    ctx.beginPath();
    ctx.roundRect(x, mid - bh / 2, bwDraw, bh, bwDraw / 2);
    ctx.fill();
  }
}

/* ---------------- 历史 ---------------- */
async function loadHistory() {
  try {
    const data = await api("/api/history");
    S.historyItems = data.items;
    $("histCount").textContent = data.count;
    $("outDir").textContent = data.dir.replace(/^\/Users\/[^/]+/, "~");
    renderHistoryList();
  } catch (e) {
    toast(e.message, "error");
  }
}

function histKind(name) {
  if (name.includes("_dialogue_")) return "dialogue";
  if (name.includes("_clone_")) return "clone";
  return "design";
}

function renderHistoryList() {
  const q = ($("histSearch").value || "").trim().toLowerCase();
  const filter = $("histFilter").value;
  const items = S.historyItems.filter((it) => {
    if (filter && histKind(it.name) !== filter) return false;
    if (q && !it.name.toLowerCase().includes(q)) return false;
    return true;
  });
  const list = $("historyList");
  list.innerHTML = "";
  $("historyEmpty").classList.toggle("hidden", items.length > 0);
  items.forEach((it) => list.appendChild(histRow(it)));
}

function histRow(it) {
  const row = document.createElement("div");
  row.className = "hist-row";
  const kind = histKind(it.name);
  const kindLabel = { clone: "克隆", design: "设计", dialogue: "对话" }[kind];
  row.innerHTML = `
    <button class="hist-play" title="播放">
      <svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5Z"/></svg>
    </button>
    <div class="hist-name">
      <span class="hist-badge ${kind === "design" ? "design" : "clone"}">${kindLabel}</span>${it.name}
    </div>
    <div class="hist-meta">${fmtBytes(it.size_kb)} · ${it.time}</div>
    <div class="hist-actions">
      <a class="icon-btn" title="下载" href="${it.url}?download=1" download="${it.name}">
        <svg viewBox="0 0 24 24"><path d="M11 3h2v10.2l3.6-3.6L18 11l-6 6-6-6 1.4-1.4L11 13.2V3ZM4 19h16v2H4v-2Z"/></svg>
      </a>
      <button class="icon-btn danger" title="删除">
        <svg viewBox="0 0 24 24"><path d="M9 3h6l1 2h4v2H4V5h4l1-2ZM6 8h12l-1 13H7L6 8Zm4 3v8h1.5v-8H10Zm3 0v8h1.5v-8H13Z"/></svg>
      </button>
    </div>`;
  const player = $("histPlayer");
  row.querySelector(".hist-play").onclick = () => {
    if (S.histPlaying === it.name) { player.pause(); return; }
    S.histPlaying = it.name;
    player.src = it.url;
    player.classList.remove("hidden");
    player.play();
    document.querySelectorAll(".hist-row.playing").forEach((r) => r.classList.remove("playing"));
    row.classList.add("playing");
  };
  player.onended = () => {
    document.querySelectorAll(".hist-row.playing").forEach((r) => r.classList.remove("playing"));
    S.histPlaying = null;
  };
  row.querySelector(".icon-btn.danger").onclick = async () => {
    if (!confirm(`删除 ${it.name}？`)) return;
    try {
      await api(`/api/history/${encodeURIComponent(it.name)}`, { method: "DELETE" });
      if (S.histPlaying === it.name) { player.pause(); player.classList.add("hidden"); S.histPlaying = null; }
      loadHistory();
      toast("已删除");
    } catch (e) { toast(e.message, "error"); }
  };
  return row;
}

/* ---------------- 音色库 ---------------- */
async function loadVoices() {
  try {
    const d = await api("/api/voices");
    S.voices = d.items;
    $("voiceCount").textContent = d.items.length;
    $("navVoices").textContent = d.items.length;
    $("navVoices").classList.toggle("hidden", d.items.length === 0);
    const grid = $("voiceGrid");
    grid.innerHTML = "";
    $("voicesEmpty").classList.toggle("hidden", d.items.length > 0);
    d.items.forEach((v) => grid.appendChild(voiceCard(v)));
    if (MODES[S.mode].isDialogue) renderLines(); // 台词编辑器里的角色下拉同步刷新
  } catch (e) {
    toast(e.message, "error");
  }
}

function voiceCard(v) {
  const [cls, label] = MODE_BADGE[v.mode] || MODE_BADGE.design;
  const el = document.createElement("div");
  el.className = "voice-card";
  el.innerHTML = `
    <div class="vc-head">
      <span class="vc-name">${escapeHtml(v.name)}</span>
      <span class="hist-badge ${cls}">${label}</span>
      <span style="flex:1"></span>
      <span class="hist-meta">${v.created || ""}</span>
    </div>
    <div class="vc-desc ${v.instruct ? "" : "empty"}">${v.instruct ? escapeHtml(v.instruct) : "（无声音描述）"}</div>
    ${v.has_ref ? `<audio controls preload="none" src="/api/voices/${v.id}/ref"></audio>
    <div class="vc-ref">${v.ref_text ? "参考文字稿：" + escapeHtml(v.ref_text.slice(0, 30)) : "参考音频已保存"}</div>` : ""}
    <div class="vc-actions">
      <button class="btn primary small apply">应用到工作台</button>
      <button class="btn ghost small del">删除</button>
    </div>`;
  el.querySelector(".apply").onclick = () => applyVoice(v);
  el.querySelector(".del").onclick = async () => {
    if (!confirm(`删除音色「${v.name}」？`)) return;
    try {
      await api(`/api/voices/${v.id}`, { method: "DELETE" });
      if (S.refVoice && S.refVoice.id === v.id) { S.refVoice = null; updateRefChip(); }
      loadVoices();
      toast("已删除");
    } catch (e) { toast(e.message, "error"); }
  };
  return el;
}

function applyVoice(v) {
  if (v.mode !== S.mode) switchMode(v.mode);
  if (MODES[v.mode].showInstruct) $("instructInput").value = v.instruct || "";
  if (MODES[v.mode].showRef) {
    $("refText").value = v.ref_text || "";
    if (v.has_ref) {
      S.refVoice = { id: v.id, name: v.name };
      S.refFile = null;
      $("refAudio").value = "";
      $("refName").textContent = "未选择文件";
      updateRefChip();
    } else {
      S.refVoice = null;
      updateRefChip();
    }
  }
  setView("editor");
  toast(`已应用音色「${v.name}」`);
}

function saveVoice() {
  const m = MODES[S.mode];
  if (m.showRef && !S.refFile && !S.refVoice) {
    toast("克隆 / 执导音色需要先上传参考音频，或先应用一个已有音色", "error");
    return;
  }
  askName("存入音色库", async (name) => {
    const fd = new FormData();
    fd.append("name", name);
    fd.append("mode", S.mode);
    fd.append("instruct", $("instructInput").value);
    fd.append("ref_text", $("refText").value);
    if (S.refFile) fd.append("ref_audio", S.refFile);
    else if (S.refVoice) fd.append("ref_voice_id", S.refVoice.id);
    await api("/api/voices", { method: "POST", body: fd });
    toast(`音色「${name}」已保存`);
    loadVoices();
  }, "例如：温柔旁白女声");
}

/* ---------------- 文稿模板 ---------------- */
async function loadTemplates() {
  try {
    const d = await api("/api/templates");
    S.templates = d.items;
    $("tplCount").textContent = d.items.length;
    $("navTemplates").textContent = d.items.length;
    $("navTemplates").classList.toggle("hidden", d.items.length === 0);
    const list = $("tplList");
    list.innerHTML = "";
    $("tplEmpty").classList.toggle("hidden", d.items.length > 0);
    d.items.forEach((t) => list.appendChild(tplRow(t)));
  } catch (e) {
    toast(e.message, "error");
  }
}

function tplRow(t) {
  const [cls, label] = MODE_BADGE[t.mode] || MODE_BADGE.design;
  const el = document.createElement("div");
  el.className = "tpl-row";
  el.innerHTML = `
    <div class="tpl-name">${escapeHtml(t.name)} <span class="hist-badge ${cls}">${label}</span></div>
    <div class="tpl-actions">
      <button class="btn ghost small use">应用到工作台</button>
      <button class="icon-btn danger del" title="删除">
        <svg viewBox="0 0 24 24"><path d="M9 3h6l1 2h4v2H4V5h4l1-2ZM6 8h12l-1 13H7L6 8Zm4 3v8h1.5v-8H10Zm3 0v8h1.5v-8H13Z"/></svg>
      </button>
    </div>
    <div class="tpl-text">${escapeHtml(t.text || "（空文稿）")}</div>`;
  el.querySelector(".use").onclick = () => applyTemplate(t);
  el.querySelector(".del").onclick = async () => {
    if (!confirm(`删除模板「${t.name}」？`)) return;
    try {
      await api(`/api/templates/${t.id}`, { method: "DELETE" });
      loadTemplates();
      toast("已删除");
    } catch (e) { toast(e.message, "error"); }
  };
  return el;
}

function applyTemplate(t) {
  if (t.mode && t.mode !== S.mode) switchMode(t.mode);
  if (t.text) {
    const ta = $("textInput");
    ta.value = ta.value.trim() ? ta.value.trim() + "\n" + t.text : t.text;
    updateCharCount();
  }
  if (t.instruct && MODES[S.mode].showInstruct) $("instructInput").value = t.instruct;
  setView("editor");
  toast(`已应用模板「${t.name}」`);
}

function saveTemplate() {
  const text = $("textInput").value.trim();
  if (!text) { toast("文稿为空，没有可保存的内容", "error"); return; }
  askName("存为文稿模板", async (name) => {
    await api("/api/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, mode: S.mode, text, instruct: $("instructInput").value }),
    });
    toast(`模板「${name}」已保存`);
    loadTemplates();
  }, "例如：开场白");
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------------- 仪表盘 ---------------- */
async function loadDashboard() {
  try {
    const d = await api("/api/stats");
    $("stTotal").textContent = d.total;
    $("stToday").textContent = d.today;
    $("stSize").textContent = d.size_mb >= 1024 ? `${(d.size_mb / 1024).toFixed(1)} GB` : `${d.size_mb} MB`;
    $("stLib").textContent = `${d.voice_count} / ${d.template_count}`;
    renderBars(d.daily);
    renderRecent(d.recent);
    renderPipeline(S.lastJob);
  } catch (e) {
    toast(e.message, "error");
  }
}

function renderBars(days) {
  const max = Math.max(1, ...days.map((d) => d.count));
  $("dailyBars").innerHTML = days.map((d) => `
    <div class="bar-col" title="${d.date}：${d.count} 条">
      <span class="bar-val">${d.count || ""}</span>
      <div class="bar ${d.count ? "" : "zero"}" style="height:${Math.max(2, (d.count / max) * 100)}%"></div>
      <span class="bar-date">${d.date}</span>
    </div>`).join("");
}

function renderRecent(rows) {
  $("recentEmpty").classList.toggle("hidden", rows.length > 0);
  $("recentJobs").innerHTML = rows.map((r) => {
    const [cls, label] = r.kind === "model"
      ? ["", "切换模型"]
      : (MODE_BADGE[r.mode] || ["", r.mode || "-"]);
    const pillCls = r.status === "done" ? "done" : r.status === "error" ? "error" : "running";
    const pillText = { done: "完成", error: "失败", running: "运行中", queued: "排队中", cancelled: "已取消" }[r.status] || r.status;
    const info = r.kind === "model"
      ? ""
      : `${r.duration != null ? r.duration + "s" : "-"} · ${r.elapsed != null ? r.elapsed + "s" : "-"}`;
    const text = r.kind === "model" ? "切换模型" : escapeHtml(r.text || "（无文稿）");
    const btn = r.kind === "model" ? "" :
      r.status === "queued"
        ? `<button class="btn ghost tiny rj-cancel" data-id="${r.id}">取消</button>`
        : (r.status === "done" || r.status === "error" || r.status === "cancelled")
          ? `<button class="btn ghost tiny rj-rerun" data-id="${r.id}">再生成</button>` : "";
    return `
    <div class="rj-row">
      <span class="rj-time">${r.time}</span>
      <span class="rj-text"><span class="hist-badge ${cls}">${label}</span>${text}</span>
      <span class="rj-info">${info}</span>
      <span class="rj-btns">${btn}</span>
      <span class="status-pill ${pillCls}">${pillText}</span>
    </div>`;
  }).join("");

  document.querySelectorAll(".rj-cancel").forEach((b) => {
    b.onclick = async () => {
      try {
        await api(`/api/jobs/${b.dataset.id}`, { method: "DELETE" });
        toast("任务已取消");
        loadDashboard();
      } catch (e) { toast(e.message, "error"); }
    };
  });
  document.querySelectorAll(".rj-rerun").forEach((b) => {
    b.onclick = async () => {
      try {
        const r = await api(`/api/jobs/${b.dataset.id}/rerun`, { method: "POST" });
        submitExternalJob(r.job_id, "已重新提交生成");
      } catch (e) { toast(e.message, "error"); }
    };
  });
}

/* 外部来源的任务（再生成等）进入同一轮询/队列体系 */
function submitExternalJob(jobId, msg) {
  if (S.jobId || S.jobQueue.length) {
    S.jobQueue.push(jobId);
    toast(`${msg}（已入队，前方 ${S.jobQueue.length} 个）`);
  } else {
    S.jobId = jobId;
    $("outputProgress").classList.remove("hidden");
    $("outputEmpty").classList.add("hidden");
    S.pollTimer = setInterval(pollJob, 600);
    pollJob();
    toast(msg);
  }
}

const ICON_CHECK = '<svg viewBox="0 0 24 24"><path d="M9.5 16.2 5.8 12.5l-1.4 1.4 5.1 5.1 12-12-1.4-1.4Z"/></svg>';
const ICON_CROSS = '<svg viewBox="0 0 24 24"><path d="M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4 17.6 5 12 10.6Z"/></svg>';

function renderPipeline(job) {
  const wrap = $("pipeline");
  const stages = (job && job.pipeline && job.pipeline.stages) || PIPELINE;
  let doneUpTo = 0, activeAt = -1, failedAt = -1;
  if (job) {
    if (job.status === "error") {
      failedAt = (job.pipeline && job.pipeline.current) || 0;
      doneUpTo = failedAt;
    } else if (job.status === "done") {
      doneUpTo = stages.length;
    } else {
      activeAt = (job.pipeline && job.pipeline.current) || 0;
      doneUpTo = activeAt;
    }
  }
  wrap.innerHTML = stages.map((s, i) => {
    let cls = "pipe-stage";
    let icon = "";
    if (i < doneUpTo) { cls += " done"; icon = ICON_CHECK; }
    if (i === failedAt && job.status === "error") { cls += " failed"; icon = ICON_CROSS; }
    else if (i === activeAt && job && job.status !== "done" && job.status !== "error") { cls += " active"; }
    return `<div class="${cls}"><div class="pipe-dot">${icon}</div><div class="pipe-label">${s}</div></div>`;
  }).join("");

  const segs = job && job.pipeline && job.pipeline.segments;
  let meta = "";
  if (job) {
    const statusTxt = job.status === "done" ? "已完成"
      : job.status === "error" ? `失败：${job.error || ""}`
      : job.phase || job.status;
    meta = `<div class="pipe-seg ${job.status === "running" ? "running" : "done"}">${statusTxt}${job.elapsed != null ? ` · 已用 ${job.elapsed}s` : ""}</div>`;
  } else {
    meta = `<div class="pipe-seg">待命 — 在工作台提交生成任务后，这里会实时显示加工进度</div>`;
  }
  $("pipeSegments").innerHTML = meta + (segs ? segs.map((s) =>
    `<div class="pipe-seg ${s.status === "running" ? "running" : s.status === "done" ? "done" : ""}">${escapeHtml(s.text || "…")}</div>`
  ).join("") : "");
}

/* ---------------- 状态 ---------------- */
async function refreshStatus() {
  try {
    const s = await api("/api/status");
    const loaded = !!s.loaded_model;
    $("modelDot").classList.toggle("loaded", loaded);
    $("modelName").textContent = loaded ? `已加载 ${s.loaded_model}` : "未加载";
    $("memText").textContent = `内存 ${s.memory_gb} GB`;
    $("queueText").textContent = `队列 ${s.queue_size}`;
    if (s.tags_zh) renderTags(s.tags_zh, s.tags_en);
    return s;
  } catch { return null; }
}

/* ---------------- 事件绑定 ---------------- */
function bind() {
  document.querySelectorAll(".nav-item").forEach((b) => {
    b.onclick = () => setView(b.dataset.view);
  });
  document.querySelectorAll("#modeSeg button").forEach((b) => {
    b.onclick = () => switchMode(b.dataset.mode);
  });

  $("textInput").addEventListener("input", updateCharCount);

  $("refAudio").addEventListener("change", (e) => {
    S.refFile = e.target.files[0] || null;
    $("refName").textContent = S.refFile ? S.refFile.name : "未选择文件";
    if (S.refFile) { S.refVoice = null; updateRefChip(); }
  });
  $("refChipClear").onclick = () => { S.refVoice = null; updateRefChip(); };

  document.querySelectorAll("#modelPills .pill, #modelSwitch .ms-btn").forEach((p) => {
    p.onclick = () => pickModel(p.dataset.model);
  });

  $("cfg").addEventListener("input", () => {
    $("cfgVal").textContent = Number($("cfg").value).toFixed(1);
    paintRange($("cfg"));
  });
  $("gap").addEventListener("input", () => {
    $("gapVal").textContent = `${Number($("gap").value).toFixed(2)}s`;
    paintRange($("gap"));
  });
  $("speed").addEventListener("input", () => {
    $("speedVal").textContent = `${Number($("speed").value).toFixed(2)}×`;
    paintRange($("speed"));
  });
  document.querySelectorAll("#formatPills .pill").forEach((p) => {
    p.onclick = () => {
      S.format = p.dataset.fmt;
      document.querySelectorAll("#formatPills .pill").forEach((x) =>
        x.classList.toggle("active", x === p));
    };
  });

  $("addLineBtn").onclick = () => addLine();
  $("importBtn").onclick = () => $("importTxt").click();
  $("importTxt").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    const text = (await f.text()).trim();
    if (!text) { toast("文件为空", "error"); return; }
    if (MODES[S.mode].isDialogue) {
      const parts = text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
      S.lines = parts.map((t) => ({ voice_id: "", text: t }));
      renderLines();
      toast(`已导入 ${parts.length} 行台词`);
    } else {
      $("textInput").value = text;
      updateCharCount();
      toast(`已导入文稿（${text.length} 字）`);
    }
  });

  $("histSearch").addEventListener("input", renderHistoryList);
  $("histFilter").addEventListener("change", renderHistoryList);

  $("diceBtn").onclick = () => { $("seed").value = Math.floor(Math.random() * 1000000); };
  $("genBtn").onclick = generate;
  $("saveVoiceBtn").onclick = saveVoice;
  $("saveTemplateBtn").onclick = saveTemplate;

  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); generate(); }
  });

  $("downloadBtn").onclick = (e) => {
    if (!$("downloadBtn").href) e.preventDefault();
  };
  $("gotoHistoryBtn").onclick = () => setView("history");
  $("refreshHistBtn").onclick = loadHistory;
  $("refreshVoicesBtn").onclick = loadVoices;
  $("refreshTplBtn").onclick = loadTemplates;

  $("unloadBtn").onclick = async () => {
    try { await api("/api/model/unload", { method: "POST" }); refreshStatus(); toast("模型内存已释放"); }
    catch (e) { toast(e.message, "error"); }
  };
  $("openFolderBtn").onclick = () => api("/api/open-folder", { method: "POST" }).catch(() => {});

  $("modalCancel").onclick = closeModal;
  $("modalMask").addEventListener("click", (e) => {
    if (e.target === $("modalMask")) closeModal();
  });
  $("modalOk").onclick = async () => {
    const v = $("modalInput").value.trim();
    if (!v || !modalCb) return;
    const cb = modalCb;
    closeModal();
    try { await cb(v); } catch (e) { toast(e.message, "error"); }
  };
  $("modalInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("modalOk").click();
  });

  window.addEventListener("resize", paintWave);
}

/* ---------------- 启动 ---------------- */
function paintRange(el) {
  const pct = ((el.value - el.min) / (el.max - el.min)) * 100;
  el.style.setProperty("--fill", pct + "%");
}

bind();
paintRange($("cfg"));
paintRange($("gap"));
paintRange($("speed"));
updateModeSeg();
updateRefChip();
renderLines();
refreshStatus().then((s) => {
  if (s && s.loaded_model) { S.model = s.loaded_model; updateModelUI(); }
});
loadVoices().then(() => renderLines());
loadHistory();
setInterval(refreshStatus, 5000);
setInterval(() => { if (S.view === "dashboard") loadDashboard(); }, 5000);

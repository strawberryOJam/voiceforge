import { createContext, useContext, useState, useEffect, useRef, useCallback } from "react";
import { api } from "./api";

const Ctx = createContext(null);
export const useApp = () => useContext(Ctx);

export const MODES = {
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

export const MODE_BADGE = {
  design: ["design", "设计"], clone: ["clone", "克隆"],
  direct: ["clone", "执导"], dialogue: ["design", "对话"],
};

export const PIPELINE = ["排队", "加载模型", "文稿分段", "逐句合成", "拼接静音", "响度归一化", "完成"];

export function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

let toastSeq = 0;

export function AppProvider({ children }) {
  // ---------- 视图 / 模式 / 表单 ----------
  const [view, setViewState] = useState("editor");
  const [mode, setModeState] = useState("design");
  const [text, setText] = useState("");
  const [instruct, setInstruct] = useState("");
  const [textByMode, setTextByMode] = useState({ design: "", clone: "", direct: "" });
  const [instructByMode, setInstructByMode] = useState({ design: "", clone: "", direct: "" });
  const [refText, setRefText] = useState("");
  const [refFile, setRefFile] = useState(null);
  const [refVoice, setRefVoice] = useState(null); // {id, name}
  const [lines, setLines] = useState([{ voice_id: "", text: "" }]);
  const [model, setModelState] = useState("4bit");
  const [format, setFormatState] = useState("wav");
  const [cfg, setCfg] = useState(4);
  const [seed, setSeed] = useState(42);
  const [gap, setGap] = useState(0.35);
  const [speed, setSpeed] = useState(1);
  const [normalize, setNormalize] = useState(true);
  const [autoSplit, setAutoSplit] = useState(true);

  // ---------- 服务端状态 ----------
  const [status, setStatus] = useState(null);
  const [settings, setSettings] = useState(null);
  const [voices, setVoices] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [history, setHistory] = useState({ items: [], count: 0, dir: "" });

  // ---------- UI ----------
  const [toasts, setToasts] = useState([]);
  const [modal, setModal] = useState(null); // {title, placeholder, cb}

  // ---------- 任务系统 ----------
  const [jobState, setJobState] = useState({
    active: false, submitting: false, phase: "", meta: "", pct: 0,
    result: null, error: null, queueLeft: 0,
  });
  const [lastJob, setLastJob] = useState(null);
  const jobRef = useRef({ id: null, queue: [], timer: null, modelSwitch: false });

  const toast = useCallback((msg, type = "info") => {
    const id = ++toastSeq;
    setToasts((ts) => [...ts, { id, msg, type }]);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 4000);
  }, []);

  const askName = useCallback((title, cb, placeholder = "名称") => {
    setModal({ title, placeholder, cb });
  }, []);

  const closeModal = useCallback(() => setModal(null), []);

  const confirmModal = useCallback(async (value) => {
    const m = modal;
    setModal(null);
    if (!m || !value.trim()) return;
    try { await m.cb(value.trim()); } catch (e) { toast(e.message, "error"); }
  }, [modal, toast]);

  // ---------- 数据加载 ----------
  const refreshStatus = useCallback(async () => {
    try {
      const s = await api("/api/status");
      setStatus(s);
      return s;
    } catch { return null; }
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      const s = await api("/api/settings");
      setSettings(s);
      return s;
    } catch { return null; }
  }, []);

  const loadVoices = useCallback(async () => {
    try {
      const d = await api("/api/voices");
      setVoices(d.items);
      return d.items;
    } catch { return []; }
  }, []);

  const loadTemplates = useCallback(async () => {
    try {
      const d = await api("/api/templates");
      setTemplates(d.items);
      return d.items;
    } catch { return []; }
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const d = await api("/api/history");
      setHistory(d);
      return d;
    } catch { return null; }
  }, []);

  // ---------- 模式切换（含每模式记忆） ----------
  const switchMode = useCallback((m) => {
    setModeState((old) => {
      if (!MODES[m] || m === old) return old;
      setTextByMode((prev) => (old === "dialogue" ? prev : { ...prev, [old]: text }));
      setInstructByMode((prev) => ({ ...prev, [old]: instruct }));
      setText(m === "dialogue" ? "" : (textByMode[m] || ""));
      setInstruct(instructByMode[m] || "");
      return m;
    });
  }, [text, instruct, textByMode, instructByMode]);

  // ---------- 模型切换 ----------
  const updateModelUI = () => {};

  const syncModelLoad = useCallback(async () => {
    if (jobRef.current.id) return;
    try {
      const s = await api("/api/status");
      if (!s.loaded_model || s.loaded_model === model) return;
      toast(`正在切换模型到 ${model} …`);
      const r = await api("/api/model/load", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
      });
      startJob(r.job_id, true);
    } catch (e) { toast(e.message, "error"); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, toast]);

  const pickModel = useCallback((m) => {
    if (!m || m === model) return;
    setModelState(m);
    syncModelLoad();
  }, [model, syncModelLoad]);

  // ---------- 任务轮询 ----------
  const setProgress = useCallback((phase, meta, pct) => {
    setJobState((j) => ({ ...j, phase, meta, pct }));
  }, []);

  const advanceQueue = useCallback(() => {
    const ref = jobRef.current;
    if (ref.queue.length) {
      ref.id = ref.queue.shift();
      setJobState((j) => ({
        ...j, active: true, result: null, error: null,
        phase: "排队中", meta: `队列剩余 ${ref.queue.length} 个`, pct: 4, queueLeft: ref.queue.length,
      }));
      ref.timer = setInterval(pollRef.current, 600);
      pollRef.current();
    } else {
      ref.id = null;
      setJobState((j) => ({ ...j, active: false, submitting: false }));
    }
  }, []);

  const handleTerminal = useCallback((j) => {
    const ref = jobRef.current;
    clearInterval(ref.timer); ref.timer = null; ref.id = null;
    const isModel = j.result && j.result.loaded;
    const isDownload = j.result && j.result.downloaded;
    if (isModel) {
      ref.modelSwitch = false;
      refreshStatus();
      if (model !== j.result.loaded) {
        setModelState(j.result.loaded);
        syncModelLoad();
      } else {
        toast(`已切换到 ${j.result.loaded}`);
      }
    } else if (isDownload) {
      ref.modelSwitch = false;
      toast(`模型下载完成：${j.result.downloaded}`);
      refreshStatus();
      loadSettings();
    } else {
      setJobState((s) => ({ ...s, result: j.result, active: false }));
      refreshStatus();
      loadHistory();
      toast(j.result && j.result.dialogue ? "对话配音完成" : "生成完成");
    }
    advanceQueue();
  }, [model, toast, refreshStatus, loadHistory, loadSettings, syncModelLoad, advanceQueue]);

  const pollRef = useRef(async () => {});
  pollRef.current = async () => {
    const ref = jobRef.current;
    if (!ref.id) return;
    let j;
    try {
      j = await api(`/api/jobs/${ref.id}`);
    } catch (e) {
      toast(e.message, "error");
      clearInterval(ref.timer); ref.timer = null; ref.id = null;
      setJobState((s) => ({ ...s, active: false, submitting: false }));
      return;
    }
    setLastJob({
      id: j.id, status: j.status, phase: j.phase, elapsed: j.elapsed,
      pipeline: j.pipeline, error: j.error, result: j.result,
    });
    const p = j.progress || { done: 0, total: 0 };
    if (j.status === "queued") {
      if (!ref.modelSwitch) setProgress("排队中", j.queue_position ? `前方 ${j.queue_position} 个任务` : "等待中", 4);
    } else if (j.status === "running") {
      if (ref.modelSwitch) {
        setStatus((s) => s && { ...s, loaded_model: null });
        setJobState((st) => ({ ...st, phase: `切换中… ${j.phase}` }));
      } else {
        const phase = p.total > 1 ? `${j.phase} · ${p.done}/${p.total} 段` : j.phase;
        const pct = p.total > 0 ? Math.min(100, (p.done / p.total) * 88) : 8;
        setProgress(phase, j.elapsed != null ? `已用 ${j.elapsed}s` : "", pct);
      }
    } else if (j.status === "done" || j.status === "error" || j.status === "cancelled") {
      if (j.status === "cancelled") toast("排队任务已取消");
      else if (j.status === "error") toast(`生成失败：${j.error || "未知错误"}`, "error");
      handleTerminal({ ...j, status: j.status === "cancelled" ? "cancelled" : j.status });
    }
  };

  const startJob = useCallback((jobId, isModelSwitch = false) => {
    const ref = jobRef.current;
    ref.id = jobId;
    ref.modelSwitch = isModelSwitch;
    setJobState({
      active: true, submitting: false, phase: "提交中", meta: "…", pct: 3,
      result: isModelSwitch ? null : jobState.result, error: null, queueLeft: ref.queue.length,
    });
    ref.timer = setInterval(() => pollRef.current(), 600);
    pollRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submitJob = useCallback(async (postFn) => {
    const ref = jobRef.current;
    const busy = ref.id || ref.queue.length;
    if (!busy) setJobState((j) => ({ ...j, active: true, submitting: true, phase: "提交中", meta: "…", pct: 2 }));
    try {
      const r = await postFn();
      if (busy) {
        ref.queue.push(r.job_id);
        setJobState((j) => ({ ...j, queueLeft: ref.queue.length }));
        toast(`已加入队列（前方 ${ref.queue.length} 个）`);
      } else {
        startJob(r.job_id);
      }
      return r;
    } catch (e) {
      toast(e.message, "error");
      if (!busy) setJobState((j) => ({ ...j, active: false, submitting: false }));
      throw e;
    }
  }, [toast, startJob]);

  const submitExternalJob = useCallback((jobId, msg) => {
    const ref = jobRef.current;
    if (ref.id || ref.queue.length) {
      ref.queue.push(jobId);
      toast(`${msg}（已入队，前方 ${ref.queue.length} 个）`);
    } else {
      toast(msg);
      startJob(jobId);
    }
  }, [toast, startJob]);

  // ---------- 生成 ----------
  const generate = useCallback(async () => {
    const m = MODES[mode];
    const ref = jobRef.current;
    if (m.isDialogue) {
      const valid = lines.filter((l) => l.text.trim());
      if (!valid.length) { toast("请至少填写一行台词", "error"); return; }
      await submitJob(() => api("/api/dialogue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lines: valid.map((l) => ({ voice_id: l.voice_id, text: l.text.trim() })),
          model, cfg, seed, normalize,
          gap: valid.length > 1 ? gap : 0.25,
          speed, format,
        }),
      }));
    } else {
      const t = text.trim();
      if (!t) { toast("文稿不能为空", "error"); return; }
      if (m.showRef && !refFile && !refVoice) { toast("请上传参考音频，或从音色库应用一个音色", "error"); return; }
      if (m.showRef && !refText.trim()) { toast("请填写参考音频的准确文字稿", "error"); return; }
      const fd = new FormData();
      fd.append("text", t);
      fd.append("mode", mode);
      fd.append("instruct", m.showInstruct ? instruct : "");
      fd.append("ref_text", m.showRef ? refText : "");
      fd.append("model", model);
      fd.append("cfg", String(cfg));
      fd.append("seed", String(seed));
      fd.append("normalize", String(normalize));
      fd.append("auto_split", String(autoSplit));
      fd.append("gap", String(gap));
      fd.append("speed", String(speed));
      fd.append("format", format);
      if (m.showRef && refFile) fd.append("ref_audio", refFile);
      else if (m.showRef && refVoice) fd.append("ref_voice_id", refVoice.id);
      await submitJob(() => api("/api/synthesize", { method: "POST", body: fd }));
    }
  }, [mode, lines, text, instruct, refText, refFile, refVoice, model, cfg, seed, gap, speed, format, normalize, autoSplit, submitJob, toast]);

  // ---------- 视图切换 ----------
  const setView = useCallback((v) => {
    setViewState(v);
    if (v === "history") loadHistory();
    if (v === "voices") loadVoices();
    if (v === "templates") loadTemplates();
    if (v === "settings") loadSettings();
  }, [loadHistory, loadVoices, loadTemplates, loadSettings]);

  // ---------- 启动 ----------
  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    (async () => {
      const [s, st] = await Promise.all([loadSettings(), refreshStatus()]);
      if (s) {
        setFormatState(s.default_format === "mp3" ? "mp3" : "wav");
        if (!st || !st.loaded_model) setModelState(s.default_model in (s.models || {}) ? s.default_model : "4bit");
      }
      if (st && st.loaded_model) setModelState(st.loaded_model);
      loadVoices();
      loadHistory();
    })();
    const t1 = setInterval(refreshStatus, 5000);
    return () => clearInterval(t1);
  }, [loadSettings, refreshStatus, loadVoices, loadHistory]);

  const value = {
    view, setView, mode, switchMode,
    text, setText, instruct, setInstruct, refText, setRefText,
    refFile, setRefFile, refVoice, setRefVoice,
    lines, setLines, model, pickModel, format, setFormat: (f) => setFormatState(f),
    cfg, setCfg, seed, setSeed, gap, setGap, speed, setSpeed,
    normalize, setNormalize, autoSplit, setAutoSplit,
    status, settings, refreshStatus, loadSettings,
    voices, loadVoices, templates, loadTemplates, history, loadHistory,
    toasts, toast, modal, askName, closeModal, confirmModal,
    jobState, lastJob, generate, submitJob, submitExternalJob,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

import { useEffect } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useApp, MODES } from "./store.jsx";
import { Toasts, NameModal, Aurora } from "./components.jsx";
import Editor from "./views/Editor.jsx";
import Voices from "./views/Voices.jsx";
import Templates from "./views/Templates.jsx";
import History from "./views/History.jsx";
import Dashboard from "./views/Dashboard.jsx";
import Settings from "./views/Settings.jsx";
import { api } from "./api";

const VIEW_META = {
  voices: ["音色库", "保存的音色设计、克隆与执导配置，一键应用到工作台。"],
  templates: ["文稿模板", "常用文稿片段，一键插入工作台继续加工。"],
  history: ["历史记录", "所有已生成的音频，点击左侧按钮即可试听。"],
  dashboard: ["仪表盘", "文字到语音的加工流水线与生成统计。"],
  settings: ["设置", "模型配置、生成默认值与输出目录。"],
};

const NAV = [
  ["editor", "工作台", <path key="i" d="M12 3a4 4 0 0 0-4 4v5a4 4 0 0 0 8 0V7a4 4 0 0 0-4-4Zm6 9a6 6 0 0 1-12 0H4a8 8 0 0 0 7 7.94V22h2v-2.06A8 8 0 0 0 20 12Z" />],
  ["voices", "音色库", <path key="i" d="M12 3a5 5 0 0 0-5 5v3a5 5 0 0 0 10 0V8a5 5 0 0 0-5-5Zm-7 8a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2a5 5 0 0 1-4 4.9A5 5 0 0 1 9 11Zm-4 0H3a9 9 0 0 0 8 8.94V22h2v-2.06A9 9 0 0 0 21 11h-2a7 7 0 0 1-6 6.93A7 7 0 0 1 5 11Z" />],
  ["templates", "文稿模板", <path key="i" d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm2 4v2h10V7H7Zm0 4v2h10v-2H7Zm0 4v2h7v-2H7Z" />],
  ["history", "历史记录", <path key="i" d="M12 2a10 10 0 1 0 10 10h-2a8 8 0 1 1-8-8V2Zm1 2.06V2a10 10 0 0 1 8 8h-2.06A8 8 0 0 0 13 4.06ZM13 12l4.5 2.6-1 1.73L11 13.5V8h2Z" />],
  ["dashboard", "仪表盘", <path key="i" d="M3 13h4a8 8 0 0 1 16 0h-4a4 4 0 0 0-8 0Zm0-4h4a12 12 0 0 1 3 .39V3h2v6.46a12 12 0 0 1 3 1.78V3h2v10a10 10 0 0 1 1 4H2a10 10 0 0 1 1-4Zm9 11h2v2h-2v-2Z" />],
  ["settings", "设置", <path key="i" d="M4 7h9v2H4V7Zm11 0h5v2h-5V7ZM4 11h3v2H4v-2Zm5 0h11v2H9v-2ZM4 15h12v2H4v-2Zm14 0h2v2h-2v-2Z" />],
];

export default function App() {
  const { view, setView, mode, status, model, pickModel, refreshStatus, toast, generate, jobState } = useApp();
  const busy = jobState.active || jobState.submitting;

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        generate();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [generate]);

  const meta = VIEW_META[view];
  const loaded = status && status.loaded_model;
  const models = (status && status.models) || {};

  return (
    <div className="app">
      <Aurora />
      <aside className="sidebar">
        <div className="brand">
          <div className={`brand-eq ${busy ? "fast" : ""}`} aria-hidden="true"><span></span><span></span><span></span><span></span></div>
          <div className="brand-text">
            <div className="brand-name">声铸 VoiceForge</div>
            <div className="brand-sub">本地语音工坊 · MLX</div>
          </div>
        </div>

        <nav className="nav">
          {NAV.map(([v, label, icon]) => (
            <button key={v} className={`nav-item ${view === v ? "active" : ""}`} onClick={() => setView(v)}>
              <svg viewBox="0 0 24 24">{icon}</svg>
              {label}
            </button>
          ))}
        </nav>

        <div className="side-card" id="modelCard">
          <div className="side-card-title">模型状态</div>
          <div className="model-row">
            <span className={`dot ${loaded ? "loaded" : ""}`}></span>
            <span className="model-name">{loaded ? `已加载 ${loaded}` : "未加载"}</span>
          </div>
          <div className="model-switch" id="modelSwitch">
            {Object.keys(models).map((m) => (
              <button key={m} className={`ms-btn ${model === m ? "active" : ""}`} onClick={() => pickModel(m)}>{m}</button>
            ))}
          </div>
          <div className="model-meta">
            <span>内存 {(status && status.memory_gb != null) ? status.memory_gb : "--"} GB</span>
            <span>队列 {(status && status.queue_size) || 0}</span>
          </div>
          <button className="btn ghost small full" onClick={async () => {
            try { await api("/api/model/unload", { method: "POST" }); refreshStatus(); toast("模型内存已释放"); }
            catch (e) { toast(e.message, "error"); }
          }}>释放模型内存</button>
        </div>

        <div className="side-foot">
          <button className="btn ghost small full" onClick={() => api("/api/open-folder", { method: "POST" }).catch(() => {})}>
            打开输出文件夹
          </button>
          <div className="side-hint">输出目录<br /><code>~/models/breeze-out/ui</code></div>
        </div>
      </aside>

      <main className="main">
        <header className="page-head">
          <h1>{meta ? meta[0] : MODES[mode].title}</h1>
          <p>{meta ? meta[1] : MODES[mode].desc}</p>
        </header>

        <AnimatePresence mode="wait">
          <motion.div
            key={view}
            className="view-motion"
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
          >
            {view === "editor" && <Editor />}
            {view === "voices" && <Voices />}
            {view === "templates" && <Templates />}
            {view === "history" && <History />}
            {view === "dashboard" && <Dashboard />}
            {view === "settings" && <Settings />}
          </motion.div>
        </AnimatePresence>
      </main>

      <AnimatePresence>
        <NameModal />
      </AnimatePresence>
      <Toasts />
    </div>
  );
}

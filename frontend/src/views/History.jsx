import { useState } from "react";
import { useApp } from "../store.jsx";
import { api } from "../api";

function fmtBytes(kb) {
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`;
}

function histKind(name) {
  if (name.includes("_dialogue_")) return "dialogue";
  if (name.includes("_clone_")) return "clone";
  return "design";
}
const KIND_LABEL = { clone: "克隆", design: "设计", dialogue: "对话" };

export default function History() {
  const { history, loadHistory, toast } = useApp();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("");
  const [playing, setPlaying] = useState(null); // {name, url}

  const items = (history.items || []).filter((it) => {
    if (filter && histKind(it.name) !== filter) return false;
    if (query && !it.name.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  });

  const del = async (it) => {
    if (!window.confirm(`删除 ${it.name}？`)) return;
    try {
      await api(`/api/history/${encodeURIComponent(it.name)}`, { method: "DELETE" });
      if (playing && playing.name === it.name) setPlaying(null);
      toast("已删除");
      loadHistory();
    } catch (e) { toast(e.message, "error"); }
  };

  return (
    <section className="view">
      <div className="card">
        <div className="history-toolbar">
          <div className="card-title">已生成音频 <span className="count-badge">{history.count || 0}</span></div>
          <div className="toolbar-actions">
            <input type="search" className="hist-search" placeholder="搜索文件名…" value={query} onChange={(e) => setQuery(e.target.value)} />
            <select className="hist-filter" value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="">全部类型</option>
              <option value="design">设计</option>
              <option value="clone">克隆</option>
              <option value="dialogue">对话</option>
            </select>
            <audio controls autoPlay key={playing ? playing.name : "none"}
              className={playing ? "" : "hidden"}
              src={playing ? playing.url : undefined}
              onEnded={() => setPlaying(null)}></audio>
            <button className="btn ghost small" onClick={loadHistory}>
              <svg viewBox="0 0 24 24"><path d="M12 4a8 8 0 0 1 7.4 5H17v2h6V5h-2v2.3A10 10 0 0 0 2 12h2a8 8 0 0 1 8-8Zm8 8a8 8 0 0 1-15.4 3H7v-2H1v6h2v-2.3A10 10 0 0 0 22 12Z" /></svg>
              刷新
            </button>
          </div>
        </div>
        <div className="history-list">
          {items.map((it) => {
            const kind = histKind(it.name);
            const isPlaying = playing && playing.name === it.name;
            return (
              <div className={`hist-row ${isPlaying ? "playing" : ""}`} key={it.name}>
                <button className="hist-play" title="播放" onClick={() => {
                  if (isPlaying) { setPlaying(null); return; }
                  setPlaying({ name: it.name, url: it.url });
                }}>
                  <svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5Z" /></svg>
                </button>
                <div className="hist-name">
                  <span className={`hist-badge ${kind === "design" ? "design" : "clone"}`}>{KIND_LABEL[kind]}</span>
                  {it.name}
                </div>
                <div className="hist-meta">{fmtBytes(it.size_kb)} · {it.time}</div>
                <div className="hist-actions">
                  <a className="icon-btn" title="下载" href={`${it.url}?download=1`} download={it.name}>
                    <svg viewBox="0 0 24 24"><path d="M11 3h2v10.2l3.6-3.6L18 11l-6 6-6-6 1.4-1.4L11 13.2V3ZM4 19h16v2H4v-2Z" /></svg>
                  </a>
                  <button className="icon-btn danger" title="删除" onClick={() => del(it)}>
                    <svg viewBox="0 0 24 24"><path d="M9 3h6l1 2h4v2H4V5h4l1-2ZM6 8h12l-1 13H7L6 8Zm4 3v8h1.5v-8H10Zm3 0v8h1.5v-8H13Z" /></svg>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        {items.length === 0 && <div className="history-empty">没有匹配的生成记录</div>}
      </div>
    </section>
  );
}

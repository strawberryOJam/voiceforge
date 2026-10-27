import { useApp, MODE_BADGE } from "../store.jsx";
import { api } from "../api";

export default function Templates() {
  const { templates, loadTemplates, toast, setView, switchMode, setText, setInstruct, mode } = useApp();

  const applyTemplate = (t) => {
    if (t.mode && t.mode !== mode) switchMode(t.mode);
    if (t.text) {
      setText((prev) => {
        const cur = prev.trim();
        return cur ? cur + "\n" + t.text : t.text;
      });
    }
    if (t.instruct && ["design", "direct"].includes(mode)) setInstruct(t.instruct);
    setView("editor");
    toast(`已应用模板「${t.name}」`);
  };

  const del = async (t) => {
    if (!window.confirm(`删除模板「${t.name}」？`)) return;
    try {
      await api(`/api/templates/${t.id}`, { method: "DELETE" });
      toast("已删除");
      loadTemplates();
    } catch (e) { toast(e.message, "error"); }
  };

  return (
    <section className="view">
      <div className="card">
        <div className="history-toolbar">
          <div className="card-title">文稿模板 <span className="count-badge">{templates.length}</span></div>
          <div className="toolbar-actions">
            <button className="btn ghost small" onClick={loadTemplates}>
              <svg viewBox="0 0 24 24"><path d="M12 4a8 8 0 0 1 7.4 5H17v2h6V5h-2v2.3A10 10 0 0 0 2 12h2a8 8 0 0 1 8-8Zm8 8a8 8 0 0 1-15.4 3H7v-2H1v6h2v-2.3A10 10 0 0 0 22 12Z" /></svg>
              刷新
            </button>
          </div>
        </div>
        <div className="tpl-list">
          {templates.map((t) => {
            const [cls, label] = MODE_BADGE[t.mode] || MODE_BADGE.design;
            return (
              <div className="tpl-row" key={t.id}>
                <div className="tpl-name">{t.name} <span className={`hist-badge ${cls}`}>{label}</span></div>
                <div className="tpl-actions">
                  <button className="btn ghost small" onClick={() => applyTemplate(t)}>应用到工作台</button>
                  <button className="icon-btn danger" title="删除" onClick={() => del(t)}>
                    <svg viewBox="0 0 24 24"><path d="M9 3h6l1 2h4v2H4V5h4l1-2ZM6 8h12l-1 13H7L6 8Zm4 3v8h1.5v-8H10Zm3 0v8h1.5v-8H13Z" /></svg>
                  </button>
                </div>
                <div className="tpl-text">{t.text || "（空文稿）"}</div>
              </div>
            );
          })}
        </div>
        {templates.length === 0 && (
          <div className="history-empty">还没有文稿模板<br />在工作台写好文稿后，点「存为模板」即可保存</div>
        )}
      </div>
    </section>
  );
}

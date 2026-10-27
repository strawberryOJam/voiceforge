import { useApp, MODE_BADGE } from "../store.jsx";
import { api } from "../api";

export default function Voices() {
  const { voices, loadVoices, toast, askName, setView, switchMode, setInstruct, setRefText, setRefVoice, setRefFile, mode } = useApp();

  const applyVoice = (v) => {
    if (v.mode !== mode) switchMode(v.mode);
    if (["design", "direct"].includes(v.mode)) setInstruct(v.instruct || "");
    if (["clone", "direct"].includes(v.mode)) {
      setRefText(v.ref_text || "");
      if (v.has_ref) {
        setRefVoice({ id: v.id, name: v.name });
        setRefFile(null);
      } else {
        setRefVoice(null);
      }
    }
    setView("editor");
    toast(`已应用音色「${v.name}」`);
  };

  const del = async (v) => {
    if (!window.confirm(`删除音色「${v.name}」？`)) return;
    try {
      await api(`/api/voices/${v.id}`, { method: "DELETE" });
      toast("已删除");
      loadVoices();
    } catch (e) { toast(e.message, "error"); }
  };

  return (
    <section className="view">
      <div className="card">
        <div className="history-toolbar">
          <div className="card-title">已保存音色 <span className="count-badge">{voices.length}</span></div>
          <div className="toolbar-actions">
            <button className="btn ghost small" onClick={loadVoices}>
              <svg viewBox="0 0 24 24"><path d="M12 4a8 8 0 0 1 7.4 5H17v2h6V5h-2v2.3A10 10 0 0 0 2 12h2a8 8 0 0 1 8-8Zm8 8a8 8 0 0 1-15.4 3H7v-2H1v6h2v-2.3A10 10 0 0 0 22 12Z" /></svg>
              刷新
            </button>
          </div>
        </div>
        <div className="voice-grid">
          {voices.map((v) => {
            const [cls, label] = MODE_BADGE[v.mode] || MODE_BADGE.design;
            return (
              <div className="voice-card" key={v.id}>
                <div className="vc-head">
                  <span className="vc-name">{v.name}</span>
                  <span className={`hist-badge ${cls}`}>{label}</span>
                  <span style={{ flex: 1 }}></span>
                  <span className="hist-meta">{v.created || ""}</span>
                </div>
                <div className={`vc-desc ${v.instruct ? "" : "empty"}`}>{v.instruct || "（无声音描述）"}</div>
                {v.has_ref && (
                  <>
                    <audio controls preload="none" src={`/api/voices/${v.id}/ref`}></audio>
                    <div className="vc-ref">{v.ref_text ? "参考文字稿：" + v.ref_text.slice(0, 30) : "参考音频已保存"}</div>
                  </>
                )}
                <div className="vc-actions">
                  <button className="btn primary small" onClick={() => applyVoice(v)}>应用到工作台</button>
                  <button className="btn ghost small" onClick={() => del(v)}>删除</button>
                </div>
              </div>
            );
          })}
        </div>
        {voices.length === 0 && (
          <div className="history-empty">还没有保存的音色<br />在工作台调好参数后，点「存入音色库」即可保存</div>
        )}
      </div>
    </section>
  );
}

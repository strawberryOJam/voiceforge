import { useEffect, useState } from "react";
import { useApp } from "../store.jsx";
import { api } from "../api";

const PRESETS = [
  { name: "Breeze TTS 2 · 4bit", repo: "mlx-community/Breeze-TTS-2-4bit", note: "约3GB · 快 · 中文表现强" },
  { name: "Breeze TTS 2 · bf16", repo: "mlx-community/Breeze-TTS-2-bf16", note: "约7.6GB · 细节更好" },
  { name: "Kokoro 82M · bf16", repo: "mlx-community/Kokoro-82M-bf16", note: "约330MB · 54音色 · 多语言" },
  { name: "VoxCPM2 · bf16", repo: "mlx-community/VoxCPM2-bf16", note: "约5GB · 高表现多语言" },
];

export default function Settings() {
  const { settings, loadSettings, status, toast, submitExternalJob, refreshStatus, pickModel } = useApp();
  const models = (settings && settings.models) || {};
  const [cmName, setCmName] = useState("");
  const [cmRepo, setCmRepo] = useState("");
  const [cmPath, setCmPath] = useState("");
  const [outDir, setOutDir] = useState("");

  useEffect(() => {
    if (settings) setOutDir(settings.output_dir || "");
  }, [settings]);

  if (!settings) return <section className="view"><div className="card">加载中…</div></section>;

  const update = async (patch, msg) => {
    try {
      await api("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
      if (msg) toast(msg);
      await loadSettings();
      refreshStatus();
    } catch (e) { toast(e.message, "error"); }
  };

  const downloadModel = async (id) => {
    try {
      const r = await api(`/api/models/${id}/download`, { method: "POST" });
      toast("已开始下载模型");
      submitExternalJob(r.job_id, "模型下载任务已提交");
    } catch (e) { toast(e.message, "error"); }
  };

  const addPreset = async (p) => {
    try {
      const r = await api("/api/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: p.name, repo: p.repo, path: `~/models/${p.repo.split("/").pop()}` }),
      });
      toast(`已添加 ${p.name}，开始下载`);
      const d = await api(`/api/models/${r.id}/download`, { method: "POST" });
      submitExternalJob(d.job_id, "模型下载任务已提交");
    } catch (e) { toast(e.message, "error"); }
  };

  const addCustom = async () => {
    try {
      await api("/api/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: cmName, repo: cmRepo, path: cmPath }),
      });
      toast("自定义模型已添加");
      setCmName(""); setCmRepo(""); setCmPath("");
      await loadSettings();
      refreshStatus();
    } catch (e) { toast(e.message, "error"); }
  };

  const delModel = async (id, name) => {
    if (!window.confirm(`删除模型配置「${name}」？（不会删除磁盘文件）`)) return;
    try {
      await api(`/api/models/${id}`, { method: "DELETE" });
      toast("已删除");
      await loadSettings();
      refreshStatus();
    } catch (e) { toast(e.message, "error"); }
  };

  const openPath = async (p) => {
    try { await api("/api/open-path", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: p }) }); }
    catch (e) { toast(e.message, "error"); }
  };

  return (
    <section className="view">
      <div className="card dash-card">
        <div className="card-title">模型配置</div>
        <div className="model-cfg-list">
          {Object.entries(models).map(([id, m]) => (
            <div className="model-cfg-row" key={id}>
              <div className="mc-main">
                <div className="mc-name">
                  {m.name}
                  {m.builtin ? <span className="hist-badge design">内置</span> : <span className="hist-badge clone">自定义</span>}
                  {settings.default_model === id && <span className="status-pill done">默认</span>}
                  {status && status.loaded_model === id && <span className="status-pill running">已加载</span>}
                </div>
                <div className="mc-path">{m.path}</div>
                {m.repo && <div className="mc-repo">HF: {m.repo}</div>}
              </div>
              <div className="mc-status">
                <span className={`status-pill ${m.exists ? "done" : "running"}`}>{m.exists ? "可用" : "未下载"}</span>
              </div>
              <div className="mc-actions">
                {!m.exists && m.repo && <button className="btn primary small" onClick={() => downloadModel(id)}>下载</button>}
                <button className="btn ghost small" onClick={() => openPath(m.exists ? m.path : m.path.split("/").slice(0, -1).join("/") || "~")}>目录</button>
                {settings.default_model !== id && <button className="btn ghost small" onClick={() => update({ default_model: id }, `默认模型已设为 ${id}`)}>设为默认</button>}
                {!m.builtin && <button className="btn ghost small" onClick={() => delModel(id, m.name)}>删除</button>}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="card dash-card">
        <div className="card-title">预置模型 <span className="label-hint">mlx-audio 生态主流模型，点击即添加并下载</span></div>
        <div className="preset-grid">
          {PRESETS.map((p) => (
            <div className="preset-card" key={p.repo}>
              <div className="preset-name">{p.name}</div>
              <div className="preset-note">{p.note}</div>
              <div className="preset-repo">{p.repo}</div>
              <div className="preset-actions">
                <button className="btn primary small" onClick={() => addPreset(p)}>添加并下载</button>
                <a className="btn ghost small" href={`https://huggingface.co/${p.repo}`} target="_blank" rel="noreferrer">仓库页</a>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="card dash-card">
        <div className="card-title">自定义模型</div>
        <div className="custom-model-form">
          <input value={cmName} placeholder="显示名称" onChange={(e) => setCmName(e.target.value)} />
          <input value={cmRepo} placeholder="HuggingFace 仓库 ID（可选），如 mlx-community/Kokoro-82M-bf16" onChange={(e) => setCmRepo(e.target.value)} />
          <input value={cmPath} placeholder="本地路径（可选），如 ~/models/Kokoro-82M" onChange={(e) => setCmPath(e.target.value)} />
          <button className="btn primary small" onClick={addCustom} disabled={!cmName.trim() || (!cmRepo.trim() && !cmPath.trim())}>添加</button>
        </div>
      </div>

      <div className="card dash-card">
        <div className="card-title">生成设置</div>
        <div className="settings-grid">
          <div className="field">
            <label>默认模型</label>
            <select value={settings.default_model} onChange={(e) => update({ default_model: e.target.value }, "默认模型已更新")}>
              {Object.entries(models).map(([id, m]) => <option key={id} value={id}>{m.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>默认导出格式</label>
            <div className="pills">
              {["wav", "mp3"].map((f) => (
                <button key={f} className={`pill ${settings.default_format === f ? "active" : ""}`}
                  onClick={() => update({ default_format: f }, `默认格式已设为 ${f.toUpperCase()}`)}>{f.toUpperCase()}</button>
              ))}
            </div>
          </div>
          <div className="field">
            <label>响度目标 <span className="label-hint">{Number(settings.loudness_target).toFixed(0)} LUFS</span></label>
            <input type="range" min={-30} max={-6} step={1} value={settings.loudness_target}
              style={{ "--fill": ((settings.loudness_target + 30) / 24) * 100 + "%" }}
              onChange={(e) => update({ loudness_target: parseFloat(e.target.value) })} />
          </div>
          <div className="field toggle-field">
            <label className="switch-row">
              <span className="switch">
                <input type="checkbox" checked={!!settings.autoplay}
                  onChange={(e) => update({ autoplay: e.target.checked }, e.target.checked ? "生成后将自动播放" : "已关闭自动播放")} />
                <span className="knob"></span>
              </span>
              生成完成后自动播放
            </label>
          </div>
        </div>
      </div>

      <div className="card dash-card">
        <div className="card-title">输出目录</div>
        <div className="outdir-row">
          <input value={outDir} onChange={(e) => setOutDir(e.target.value)} />
          <button className="btn primary small" onClick={() => update({ output_dir: outDir }, "输出目录已更新")}>应用</button>
          <button className="btn ghost small" onClick={() => openPath(outDir)}>打开</button>
          <button className="btn ghost small" onClick={() => update({ output_dir: settings.data_dir }, "已恢复默认目录")}>恢复默认</button>
        </div>
      </div>

      <div className="card">
        <div className="card-title">关于</div>
        <div className="about-box">
          <div className="about-name">声铸 VoiceForge <span>v1.0</span></div>
          <div className="about-line">MLX 引擎 · Apple Silicon 本地推理 · 数据目录 {settings.data_dir}</div>
          <div className="about-line">音色库 {settings.voices_count} 个 · 模板 {settings.templates_count} 个</div>
        </div>
      </div>
    </section>
  );
}

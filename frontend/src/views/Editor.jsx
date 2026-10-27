import { useRef } from "react";
import { motion } from "motion/react";
import { useApp, MODES } from "../store.jsx";
import { Waveform, Magnetic } from "../components.jsx";

function TagChips() {
  const { status, text, setText, mode } = useApp();
  if (MODES[mode].isDialogue) return null;
  const tags = status ? [...status.tags_zh, ...status.tags_en] : [];
  const insert = (t) => {
    const ta = document.getElementById("textInput");
    const st = ta && ta.selectionStart != null ? ta.selectionStart : text.length;
    const en = ta && ta.selectionEnd != null ? ta.selectionEnd : text.length;
    const nv = text.slice(0, st) + t + text.slice(en);
    setText(nv);
    requestAnimationFrame(() => { ta.focus(); ta.selectionStart = ta.selectionEnd = st + t.length; });
  };
  return (
    <div className="tags">
      {tags.map((t) => <button key={t} className="tag" onClick={() => insert(t)}>{t}</button>)}
    </div>
  );
}

function LineEditor() {
  const { lines, setLines, voices } = useApp();
  const update = (i, patch) => setLines((ls) => ls.map((l, idx) => idx === i ? { ...l, ...patch } : l));
  return (
    <div className="field" id="dialogueField">
      <div className="field-head">
        <label>角色台词 <span className="label-hint">每行指派一个音色，一次生成多人对话</span></label>
        <button className="btn ghost tiny" onClick={() => setLines((ls) => [...ls, { voice_id: "", text: "" }])}>+ 添加一行</button>
      </div>
      <div className="line-list">
        {lines.map((l, i) => (
          <div className="line-row" key={i}>
            <select value={l.voice_id} onChange={(e) => update(i, { voice_id: e.target.value })}>
              <option value="">默认设计音色</option>
              {voices.map((v) => {
                const label = { design: "设计", clone: "克隆", direct: "执导" }[v.mode] || v.mode;
                return <option key={v.id} value={v.id}>{v.name} · {label}</option>;
              })}
            </select>
            <input
              type="text"
              value={l.text}
              placeholder={`第 ${i + 1} 句台词…`}
              onChange={(e) => update(i, { text: e.target.value })}
            />
            <button
              className="line-del"
              disabled={lines.length <= 1}
              title="删除此行"
              onClick={() => setLines((ls) => ls.filter((_, idx) => idx !== i))}
            >✕</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function Range({ label, hint, min, max, step, value, onChange, fmt }) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="field">
      <label>{label} <span className="label-hint">{fmt(value)}</span></label>
      <input
        type="range" min={min} max={max} step={step} value={value}
        style={{ "--fill": pct + "%" }}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
    </div>
  );
}

function OutputCard() {
  const { jobState, setView, settings } = useApp();
  const { active, submitting, phase, meta, pct, result } = jobState;
  const showResult = result && !active && !submitting;

  return (
    <div className="card output-card">
      <div className="card-title">输出</div>
      {!active && !showResult && (
        <div className="output-empty">
          <svg viewBox="0 0 24 24"><path d="M3 10v4h4l5 5V5L7 10H3Zm13.5 2a3.5 3.5 0 0 0-2-3.15v6.3a3.5 3.5 0 0 0 2-3.15ZM14 3.2v2.1a6 6 0 0 1 0 11.4v2.1a8 8 0 0 0 0-15.6Z" /></svg>
          <p>生成的音频会显示在这里</p>
        </div>
      )}
      {(active || submitting) && (
        <div className="output-progress">
          <div className="progress-head">
            <span>{phase}</span>
            <span>{meta}</span>
          </div>
          <div className="progress-track"><div className="progress-fill" style={{ width: pct + "%" }}></div></div>
        </div>
      )}
      {showResult && (
        <motion.div
          className="output-result"
          initial={{ opacity: 0, y: 16, scale: 0.985 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        >
          <Waveform key={result.name} url={result.url} />
          <div className="info-grid">
            <div className="info-item"><div className="k">时长</div><div className="v">{result.duration}s</div></div>
            <div className="info-item"><div className="k">耗时</div><div className="v">{result.elapsed}s</div></div>
            <div className="info-item"><div className="k">RTF</div><div className="v">{result.rtf ?? "-"}</div></div>
            <div className="info-item"><div className="k">{result.dialogue ? "台词" : "分段"}</div><div className="v">{result.segments} 段</div></div>
            <div className="info-item"><div className="k">采样率</div><div className="v">{result.sample_rate} Hz</div></div>
            <div className="info-item"><div className="k">模型</div><div className="v">{result.model}</div></div>
            {result.speed && result.speed !== 1 && (
              <div className="info-item"><div className="k">语速</div><div className="v">{result.speed}×</div></div>
            )}
            {result.format === "mp3" && (
              <div className="info-item"><div className="k">格式</div><div className="v">MP3</div></div>
            )}
          </div>
          <div className="result-actions">
            <a className="btn ghost small" href={`${result.url}?download=1`} download={result.name}>
              <svg viewBox="0 0 24 24"><path d="M11 3h2v10.2l3.6-3.6L18 11l-6 6-6-6 1.4-1.4L11 13.2V3ZM4 19h16v2H4v-2Z" /></svg>
              下载 {result.format === "mp3" ? "MP3" : "WAV"}
            </a>
            <button className="btn ghost small" onClick={() => setView("history")}>
              <svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 10 10h-2a8 8 0 1 1-8-8V2Zm1 2.06V2a10 10 0 0 1 8 8h-2.06A8 8 0 0 0 13 4.06ZM13 12l4.5 2.6-1 1.73L11 13.5V8h2Z" /></svg>
              查看历史
            </button>
          </div>
        </motion.div>
      )}
    </div>
  );
}

export default function Editor() {
  const app = useApp();
  const { mode, switchMode, status, model, pickModel, format, setFormat } = app;
  const m = MODES[mode];
  const models = (status && status.models) || {};
  const importRef = useRef(null);

  const importTxt = async (f) => {
    if (!f) return;
    const t = (await f.text()).trim();
    if (!t) { app.toast("文件为空", "error"); return; }
    if (m.isDialogue) {
      const parts = t.split(/\n+/).map((s) => s.trim()).filter(Boolean);
      app.setLines(parts.map((x) => ({ voice_id: "", text: x })));
      app.toast(`已导入 ${parts.length} 行台词`);
    } else {
      app.setText(t);
      app.toast(`已导入文稿（${t.length} 字）`);
    }
  };

  return (
    <>
      <div className="mode-seg" id="modeSeg">
        {Object.keys(MODES).map((k) => (
          <button key={k} className={mode === k ? "active" : ""} onClick={() => switchMode(k)}>{MODES[k].title}</button>
        ))}
      </div>

      <div className="editor-grid">
        <div className="card form-card">
          {!m.isDialogue && (
            <div className="field" id="textField">
              <div className="field-head">
                <label>文稿</label>
                <div className="mini-actions">
                  <span className="char-count">{app.text.length} 字</span>
                  <button className="btn ghost tiny" onClick={() => importRef.current && importRef.current.click()}>导入</button>
                  <input ref={importRef} type="file" accept=".txt,.md,text/plain" className="hidden"
                    onChange={(e) => { importTxt(e.target.files[0]); e.target.value = ""; }} />
                  <button className="btn ghost tiny" onClick={saveTemplate}>存为模板</button>
                  <button className="btn ghost tiny" onClick={saveVoice}>存入音色库</button>
                </div>
              </div>
              <textarea
                id="textInput"
                rows={5}
                value={app.text}
                placeholder={m.textPh}
                onChange={(e) => app.setText(e.target.value)}
              ></textarea>
              <TagChips />
            </div>
          )}

          {m.isDialogue && <LineEditor />}

          {m.showRef && (
            <div className="field" id="refField">
              <label>参考音频 <span className="label-hint">3–15 秒干净人声 · 支持 m4a / mp3 / wav</span></label>
              <div className="ref-row">
                <input type="file" accept=".m4a,.wav,.mp3,.aac,.ogg,.opus,.flac,audio/*" className="file-input"
                  onChange={(e) => {
                    const f = e.target.files[0] || null;
                    app.setRefFile(f);
                    if (f) app.setRefVoice(null);
                  }} />
                <span className="file-name">{app.refFile ? app.refFile.name : "未选择文件"}</span>
              </div>
              {app.refVoice && (
                <div className="ref-chip">
                  <svg viewBox="0 0 24 24"><path d="M12 3a5 5 0 0 0-5 5v3a5 5 0 0 0 10 0V8a5 5 0 0 0-5-5Zm-3 8a3 3 0 0 0 6 0V8a3 3 0 0 0-6 0Z" /></svg>
                  <span>使用音色库参考：{app.refVoice.name}</span>
                  <button onClick={() => app.setRefVoice(null)} title="清除">✕</button>
                </div>
              )}
              <textarea rows={2} value={app.refText} placeholder="参考音频的准确文字稿（必填）"
                onChange={(e) => app.setRefText(e.target.value)}></textarea>
            </div>
          )}

          {m.showInstruct && (
            <div className="field" id="instructField">
              <label>{m.instructLabel}</label>
              <textarea rows={3} value={app.instruct} placeholder={m.instructPh}
                onChange={(e) => app.setInstruct(e.target.value)}></textarea>
            </div>
          )}

          <div className="params">
            <div className="field">
              <label>模型</label>
              <div className="pills" id="modelPills">
                {Object.entries(models).map(([id, v]) => {
                  const short = v.name.includes("·") ? v.name.split("·").pop().trim() : v.name;
                  return (
                    <button key={id} className={`pill ${model === id ? "active" : ""}`} onClick={() => pickModel(id)}>
                      {short}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="param-grid">
              <Range label="cfg_scale" min={1} max={8} step={0.5} value={app.cfg}
                onChange={app.setCfg} fmt={(v) => v.toFixed(1)} />
              <div className="field">
                <label>随机种子</label>
                <div className="seed-row">
                  <input type="number" value={app.seed} min={0} step={1} onChange={(e) => app.setSeed(parseInt(e.target.value || "0", 10))} />
                  <button className="btn ghost tiny" title="随机种子" onClick={() => app.setSeed(Math.floor(Math.random() * 1000000))}>
                    <svg viewBox="0 0 24 24"><path d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm3 4a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm8 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm-4 5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm-4 5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm8 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z" /></svg>
                  </button>
                </div>
              </div>
            </div>

            <div className="param-grid">
              <Range label="语速" min={0.5} max={2} step={0.05} value={app.speed}
                onChange={app.setSpeed} fmt={(v) => v.toFixed(2) + "×"} />
              <div className="field">
                <label>导出格式</label>
                <div className="pills">
                  {["wav", "mp3"].map((f) => (
                    <button key={f} className={`pill ${format === f ? "active" : ""}`} onClick={() => setFormat(f)}>{f.toUpperCase()}</button>
                  ))}
                </div>
              </div>
            </div>

            <div className="param-grid">
              <Range label="句间静音" min={0} max={1.5} step={0.05} value={app.gap}
                onChange={app.setGap} fmt={(v) => v.toFixed(2) + "s"} />
              <div className="field toggle-field">
                <label className="switch-row">
                  <span className="switch"><input type="checkbox" checked={app.normalize} onChange={(e) => app.setNormalize(e.target.checked)} /><span className="knob"></span></span>
                  响度归一化 <span className="label-hint">{(app.settings && app.settings.loudness_target) || -16} LUFS</span>
                </label>
                {!m.isDialogue && (
                  <label className="switch-row">
                    <span className="switch"><input type="checkbox" checked={app.autoSplit} onChange={(e) => app.setAutoSplit(e.target.checked)} /><span className="knob"></span></span>
                    按句自动分段
                  </label>
                )}
              </div>
            </div>
          </div>

          <Magnetic className="full">
            <button className="btn primary full generate" onClick={app.generate} disabled={app.jobState.active && !app.jobState.result}>
              <svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5Z" /></svg>
              生成语音
              <span className="kbd">⌘↵</span>
            </button>
          </Magnetic>
          <div className="form-hint">首次生成会加载模型，需 5–20 秒；纯克隆建议 cfg=1 且不填表演指令。</div>
        </div>

        <OutputCard />
      </div>
    </>
  );

  function saveVoice() {
    const mm = MODES[app.mode];
    if (mm.showRef && !app.refFile && !app.refVoice) {
      app.toast("克隆 / 执导音色需要先上传参考音频，或先应用一个已有音色", "error");
      return;
    }
    app.askName("存入音色库", async (name) => {
      const fd = new FormData();
      fd.append("name", name);
      fd.append("mode", app.mode);
      fd.append("instruct", app.instruct);
      fd.append("ref_text", app.refText);
      if (app.refFile) fd.append("ref_audio", app.refFile);
      else if (app.refVoice) fd.append("ref_voice_id", app.refVoice.id);
      await api("/api/voices", { method: "POST", body: fd });
      app.toast(`音色「${name}」已保存`);
      app.loadVoices();
    }, "例如：温柔旁白女声");
  }

  function saveTemplate() {
    const t = app.text.trim();
    if (!t) { app.toast("文稿为空，没有可保存的内容", "error"); return; }
    app.askName("存为文稿模板", async (name) => {
      await api("/api/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, mode: app.mode, text: t, instruct: app.instruct }),
      });
      app.toast(`模板「${name}」已保存`);
      app.loadTemplates();
    }, "例如：开场白");
  }
}

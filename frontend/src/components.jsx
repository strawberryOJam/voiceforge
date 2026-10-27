import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion, useMotionValue, useSpring } from "motion/react";
import { useApp, PIPELINE } from "./store.jsx";

/* ---------------- 极光背景 ---------------- */
export function Aurora() {
  return (
    <div className="aurora" aria-hidden="true">
      <div className="blob-c"></div>
    </div>
  );
}

/* ---------------- 聚光边框卡片 ---------------- */
export function Spotlight({ children, className = "" }) {
  const ref = useRef(null);
  const onMove = (e) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--mx", (e.clientX - r.left) + "px");
    el.style.setProperty("--my", (e.clientY - r.top) + "px");
  };
  return (
    <div ref={ref} className={`spotlight ${className}`} onMouseMove={onMove}>
      {children}
    </div>
  );
}

/* ---------------- 磁吸按钮（仅精细指针 + 非降级动效） ---------------- */
export function Magnetic({ children, strength = 0.25, className = "" }) {
  const reduce = useReducedMotion();
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const sx = useSpring(x, { stiffness: 220, damping: 16 });
  const sy = useSpring(y, { stiffness: 220, damping: 16 });
  const fine = typeof window !== "undefined" && window.matchMedia("(pointer: fine)").matches;

  if (reduce || !fine) return <div className={className}>{children}</div>;

  return (
    <motion.div
      className={className}
      style={{ x: sx, y: sy, display: "inline-block" }}
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        x.set((e.clientX - r.left - r.width / 2) * strength);
        y.set((e.clientY - r.top - r.height / 2) * strength);
      }}
      onMouseLeave={() => { x.set(0); y.set(0); }}
    >
      {children}
    </motion.div>
  );
}

/* ---------------- Toasts ---------------- */
export function Toasts() {
  const { toasts } = useApp();
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <motion.div
          key={t.id}
          className={`toast ${t.type === "error" ? "error" : ""}`}
          initial={{ opacity: 0, x: 40, scale: 0.96 }}
          animate={{ opacity: 1, x: 0, scale: 1 }}
          exit={{ opacity: 0, x: 40 }}
          transition={{ type: "spring", stiffness: 380, damping: 28 }}
          layout
        >
          {t.msg}
        </motion.div>
      ))}
    </div>
  );
}

/* ---------------- 命名弹窗 ---------------- */
export function NameModal() {
  const { modal, closeModal, confirmModal } = useApp();
  const [value, setValue] = useState("");
  useEffect(() => { setValue(""); }, [modal]);
  if (!modal) return null;
  return (
    <motion.div
      className="modal-mask"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      onClick={(e) => e.target === e.currentTarget && closeModal()}
    >
      <motion.div
        className="modal"
        initial={{ scale: 0.92, y: 14, opacity: 0 }}
        animate={{ scale: 1, y: 0, opacity: 1 }}
        transition={{ type: "spring", stiffness: 420, damping: 30 }}
      >
        <div className="modal-title">{modal.title}</div>
        <input
          autoFocus
          type="text"
          value={value}
          placeholder={modal.placeholder}
          maxLength={40}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && confirmModal(value)}
        />
        <div className="modal-actions">
          <button className="btn ghost small" onClick={closeModal}>取消</button>
          <button className="btn primary small" onClick={() => confirmModal(value)}>保存</button>
        </div>
      </motion.div>
    </motion.div>
  );
}

/* ---------------- 波形（渐变 + 播放头光晕） ---------------- */
export function Waveform({ url }) {
  const canvasRef = useRef(null);
  const audioRef = useRef(null);
  const peaksRef = useRef(null);
  const [played, setPlayed] = useState(0);
  const { settings } = useApp();

  useEffect(() => {
    if (!url) return;
    let dead = false;
    (async () => {
      try {
        const buf = await (await fetch(url)).arrayBuffer();
        const actx = new (window.AudioContext || window.webkitAudioContext)();
        const audio = await actx.decodeAudioData(buf);
        if (dead) return;
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
        peaksRef.current = peaks;
        actx.close();
        paint(0);
        if (settings && settings.autoplay && audioRef.current) {
          audioRef.current.play().catch(() => {});
        }
      } catch { /* 波形失败不阻塞 */ }
    })();
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  function paint(p) {
    const canvas = canvasRef.current;
    const peaks = peaksRef.current;
    if (!canvas || !peaks) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, "#2dd4bf");
    grad.addColorStop(1, "#38bdf8");

    const n = peaks.length;
    const bw = w / n;
    const mid = h / 2;
    for (let i = 0; i < n; i++) {
      const bh = Math.max(2, peaks[i] * (h - 10));
      const x = i * bw;
      const isPlayed = x / w <= p;
      ctx.fillStyle = isPlayed ? grad : "rgba(255,255,255,0.22)";
      const bwDraw = Math.max(1, bw * 0.62);
      ctx.beginPath();
      ctx.roundRect(x, mid - bh / 2, bwDraw, bh, bwDraw / 2);
      ctx.fill();
    }
    // 播放头光晕
    if (p > 0 && p < 1) {
      const px = p * w;
      const glow = ctx.createRadialGradient(px, mid, 0, px, mid, 26);
      glow.addColorStop(0, "rgba(45,212,191,.4)");
      glow.addColorStop(1, "rgba(45,212,191,0)");
      ctx.fillStyle = glow;
      ctx.fillRect(px - 26, 0, 52, h);
    }
  }

  useEffect(() => { paint(played); }, [played]);

  return (
    <>
      <canvas ref={canvasRef} id="waveCanvas" height="88"></canvas>
      <audio
        ref={audioRef}
        src={url}
        controls
        onTimeUpdate={(e) => {
          const a = e.currentTarget;
          if (a.duration) setPlayed(a.currentTime / a.duration);
        }}
        onEnded={() => setPlayed(0)}
      ></audio>
    </>
  );
}

/* ---------------- 流水线 ---------------- */
const ICON_CHECK = '<svg viewBox="0 0 24 24"><path d="M9.5 16.2 5.8 12.5l-1.4 1.4 5.1 5.1 12-12-1.4-1.4Z"/></svg>';
const ICON_CROSS = '<svg viewBox="0 0 24 24"><path d="M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4 17.6 5 12 10.6Z"/></svg>';

export function Pipeline({ job }) {
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
  return (
    <>
      <div className="pipeline">
        {stages.map((s, i) => {
          let cls = "pipe-stage";
          let icon = "";
          if (i < doneUpTo) { cls += " done"; icon = ICON_CHECK; }
          if (i === failedAt && job.status === "error") { cls += " failed"; icon = ICON_CROSS; }
          else if (i === activeAt && job && job.status !== "done" && job.status !== "error") cls += " active";
          return (
            <div key={i} className={cls}>
              <div className="pipe-dot" dangerouslySetInnerHTML={{ __html: icon }}></div>
              <div className="pipe-label">{s}</div>
            </div>
          );
        })}
      </div>
      <div className="pipe-segments">
        {job ? (
          <div className={`pipe-seg ${job.status === "running" ? "running" : "done"}`}>
            {job.status === "done" ? "已完成"
              : job.status === "error" ? `失败：${job.error || ""}`
              : (job.phase || job.status)}
            {job.elapsed != null ? ` · 已用 ${job.elapsed}s` : ""}
          </div>
        ) : (
          <div className="pipe-seg">待命 — 在工作台提交生成任务后，这里会实时显示加工进度</div>
        )}
        {job && job.pipeline && job.pipeline.segments && job.pipeline.segments.map((s, i) => (
          <motion.div
            key={i}
            className={`pipe-seg ${s.status === "running" ? "running" : s.status === "done" ? "done" : ""}`}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.05, duration: 0.3 }}
          >
            {s.text}
          </motion.div>
        ))}
      </div>
    </>
  );
}

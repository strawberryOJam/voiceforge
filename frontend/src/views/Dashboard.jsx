import { useEffect, useState } from "react";
import { useApp, MODE_BADGE, PIPELINE } from "../store.jsx";
import { Pipeline } from "../components.jsx";
import { api } from "../api";

export default function Dashboard() {
  const { lastJob, toast, submitExternalJob } = useApp();
  const [stats, setStats] = useState(null);
  const [liveJob, setLiveJob] = useState(null);

  useEffect(() => {
    let dead = false;
    const load = async () => {
      try {
        const d = await api("/api/stats");
        if (!dead) setStats(d);
      } catch { /* ignore */ }
    };
    load();
    const t = setInterval(load, 5000);
    return () => { dead = true; clearInterval(t); };
  }, []);

  // 活跃任务时优先展示实时管线
  useEffect(() => {
    setLiveJob(lastJob);
  }, [lastJob]);

  const cancel = async (id) => {
    try {
      await api(`/api/jobs/${id}`, { method: "DELETE" });
      toast("任务已取消");
      setStats(await api("/api/stats"));
    } catch (e) { toast(e.message, "error"); }
  };
  const rerun = async (id) => {
    try {
      const r = await api(`/api/jobs/${id}/rerun`, { method: "POST" });
      submitExternalJob(r.job_id, "已重新提交生成");
    } catch (e) { toast(e.message, "error"); }
  };

  const jobForPipeline = liveJob && liveJob.pipeline ? liveJob : null;

  return (
    <section className="view">
      <div className="stat-grid">
        <div className="stat-card"><div className="stat-k">累计生成</div><div className="stat-v">{stats ? stats.total : "-"}</div></div>
        <div className="stat-card"><div className="stat-k">今日生成</div><div className="stat-v">{stats ? stats.today : "-"}</div></div>
        <div className="stat-card"><div className="stat-k">音频总大小</div><div className="stat-v">{stats ? (stats.size_mb >= 1024 ? (stats.size_mb / 1024).toFixed(1) + " GB" : stats.size_mb + " MB") : "-"}</div></div>
        <div className="stat-card"><div className="stat-k">音色库 / 模板</div><div className="stat-v">{stats ? `${stats.voice_count} / ${stats.template_count}` : "-"}</div></div>
      </div>

      <div className="card dash-card">
        <div className="card-title">文字 → 语音 · 加工流水线</div>
        <Pipeline job={jobForPipeline && jobForPipeline.pipeline ? jobForPipeline : null} />
      </div>

      <div className="card dash-card">
        <div className="card-title">近 14 天生成量</div>
        <div className="bars">
          {(stats ? stats.daily : []).map((d) => {
            const max = Math.max(1, ...(stats ? stats.daily.map((x) => x.count) : [1]));
            return (
              <div className="bar-col" key={d.date} title={`${d.date}：${d.count} 条`}>
                <span className="bar-val">{d.count || ""}</span>
                <div className={`bar ${d.count ? "" : "zero"}`} style={{ height: Math.max(2, (d.count / max) * 100) + "%" }}></div>
                <span className="bar-date">{d.date}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="card dash-card">
        <div className="card-title">最近任务</div>
        <div className="recent-jobs">
          {(stats ? stats.recent : []).map((r) => {
            const [cls, label] = r.kind === "model" ? ["", "切换模型"] : (MODE_BADGE[r.mode] || ["", r.mode || "-"]);
            const pillCls = r.status === "done" ? "done" : r.status === "error" ? "error" : r.status === "cancelled" ? "" : "running";
            const pillText = { done: "完成", error: "失败", running: "运行中", queued: "排队中", cancelled: "已取消" }[r.status] || r.status;
            const info = r.kind === "model" ? "" : `${r.duration != null ? r.duration + "s" : "-"} · ${r.elapsed != null ? r.elapsed + "s" : "-"}`;
            const btn = r.kind === "model" ? null :
              r.status === "queued" ? <button className="btn ghost tiny" onClick={() => cancel(r.id)}>取消</button> :
              ["done", "error", "cancelled"].includes(r.status) ? <button className="btn ghost tiny" onClick={() => rerun(r.id)}>再生成</button> : null;
            return (
              <div className="rj-row" key={r.id}>
                <span className="rj-time">{r.time}</span>
                <span className="rj-text"><span className={`hist-badge ${cls}`}>{label}</span>{r.kind === "model" ? "切换模型" : (r.text || "（无文稿）")}</span>
                <span className="rj-info">{info}</span>
                <span className="rj-btns">{btn}</span>
                <span className={`status-pill ${pillCls}`}>{pillText}</span>
              </div>
            );
          })}
        </div>
        {stats && stats.recent.length === 0 && <div className="history-empty">本轮服务启动后还没有任务</div>}
      </div>
    </section>
  );
}

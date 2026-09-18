/**
 * Splash / boot screen.
 *
 * 全窗口开屏：纯 CSS/SVG 绘制（背景弧形光晕 + 矢量 ∞ logo + 品牌文字），
 * 避免位图全屏 cover 时的失真。determinate 进度条捕获后端真实启动进度。
 * 进入条件：进度达到 100 且最短展示时间已到 → 淡出进入应用；另有 10s 超时兜底
 * （防止进度轮询异常时永远卡在开屏）。
 * 非 Tauri 环境（纯浏览器 dev / E2E mock 未实现时）轮询返回 null → 用模拟进度走完。
 */
import { useEffect, useRef, useState } from "react";
import * as tauri from "../../services/tauri";
import { SquareLogo } from "./SquareLogo";
import "./SplashScreen.css";

const MIN_VISIBLE_MS = 1500;
const FADE_MS = 450;
const POLL_MS = 100;
const FORCE_TIMEOUT_MS = 10000;

export function SplashScreen({ onDone }: { onDone: () => void }) {
  const [fading, setFading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [minElapsed, setMinElapsed] = useState(false);
  const doneRef = useRef(false);

  // 进入应用（幂等）：进度 100 + 最小展示时间到，或超时兜底 → 淡出并卸载。
  const finish = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    setFading(true);
    window.setTimeout(onDone, FADE_MS);
  };

  // 最短展示时间
  useEffect(() => {
    const t = window.setTimeout(() => setMinElapsed(true), MIN_VISIBLE_MS);
    return () => window.clearTimeout(t);
  }, []);

  // 轮询后端真实启动进度；非 Tauri（返回 null）用模拟进度保证能走完。
  useEffect(() => {
    let cancelled = false;
    let fake = 0;
    const tick = async () => {
      if (cancelled) return;
      let real: number | null = null;
      try {
        real = await tauri.startupProgress();
      } catch {
        /* non-tauri */
      }
      if (cancelled) return;
      if (real !== null) {
        setProgress((prev) => Math.min(100, Math.max(prev, real))); // 单调不回退
      } else {
        fake = Math.min(100, fake + 15);
        setProgress(fake);
      }
    };
    void tick();
    const poll = window.setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(poll);
    };
  }, []);

  // 进度 100 + 最小时间 → 进入
  useEffect(() => {
    if (progress >= 100 && minElapsed) finish();
  }, [progress, minElapsed]);

  // 超时兜底：无论进度如何，到点强制进入（防卡死）。
  useEffect(() => {
    const t = window.setTimeout(finish, FORCE_TIMEOUT_MS);
    return () => window.clearTimeout(t);
  }, []);

  return (
    <div className={`splash-screen${fading ? " is-fading" : ""}`}>
      {/* 背景：CSS radial-gradient 弧形光晕（替代原位图） */}
      <div className="splash-bg" aria-hidden="true">
        <div className="splash-glow splash-glow--top" />
        <div className="splash-glow splash-glow--bottom" />
      </div>

      {/* 中央品牌区：矢量 ∞ logo + 品牌名 + slogan */}
      <div className="splash-inner">
        <div className="splash-brand">
          {/* 方形 logo（1024×1024 蓝白渐变 ∞）—— 启动屏用方形比 3:2 横向更协调 */}
          <SquareLogo className="splash-logo-svg" />
          <h1 className="splash-wordmark">OneDesktop</h1>
          <p className="splash-slogan">One Desktop, All Solutions</p>
        </div>

        <div className="splash-loader">
          <div
            className="splash-progress"
            role="progressbar"
            aria-label="启动加载中"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
          >
            <div className="splash-progress-bar" style={{ width: `${progress}%` }} />
          </div>
          <span>正在启动… {progress}%</span>
        </div>
      </div>
    </div>
  );
}

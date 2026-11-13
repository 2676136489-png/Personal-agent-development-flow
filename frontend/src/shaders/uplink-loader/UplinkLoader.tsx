/**
 * Uplink Loader — cinematic secure-uplink loader (module-level Suspense fallback).
 *
 * Source: ThreeUI Community · https://threeui.com · MIT License (Meng To / Design+Code)
 * Component page: https://threeui.com/component/uplink-loader
 * ThreeUI category: CSS
 *
 * 原版 HTML/CSS/JS 完整保留在同目录 uplink-loader.html，通过 Vite 的 ?raw
 * 注入沙箱 iframe 渲染 —— 零样式泄漏，也不与全站 CSS 互相污染。
 * 站内局部加载态（卡片 / 列表 / 表格）用的是同风格的紧凑面板移植版，
 * 见 components/LoadingState.tsx，不走 iframe。
 */
import { useState, type CSSProperties } from "react";

import uplinkLoaderSource from "./uplink-loader.html?raw";

export type UplinkLoaderProps = {
  className?: string;
  style?: CSSProperties;
};

export function UplinkLoader({ className = "", style }: UplinkLoaderProps) {
  const [ready, setReady] = useState(false);

  return (
    <div
      className={`uplink-loader${className ? ` ${className}` : ""}`}
      data-state={ready ? "ready" : "loading"}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        overflow: "hidden",
        background: "#030806",
        ...style,
      }}
    >
      <iframe
        title="SYS.LINK uplink progress loader"
        srcDoc={uplinkLoaderSource}
        sandbox="allow-scripts"
        loading="eager"
        onLoad={() => setReady(true)}
        style={{
          position: "absolute",
          inset: 0,
          display: "block",
          width: "100%",
          height: "100%",
          border: 0,
          background: "#030806",
        }}
      />
    </div>
  );
}

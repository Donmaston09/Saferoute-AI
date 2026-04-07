import { useEffect } from "react";

const COLORS = {
  GREEN: "#22c55e",
  YELLOW: "#f59e0b",
  RED: "#ef4444",
};

export default function HUDOverlay({
  canvasRef,
  detections,
  threatLevel,
  isProcessing,
  nightMode,
}) {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const parent = canvas.parentElement;
    const deviceScale = window.devicePixelRatio || 1;
    const displayWidth = parent?.clientWidth || canvas.clientWidth;
    const displayHeight = parent?.clientHeight || canvas.clientHeight;

    if (!displayWidth || !displayHeight) return;

    const scaledWidth = Math.floor(displayWidth * deviceScale);
    const scaledHeight = Math.floor(displayHeight * deviceScale);
    if (canvas.width !== scaledWidth || canvas.height !== scaledHeight) {
      canvas.width = scaledWidth;
      canvas.height = scaledHeight;
      canvas.style.width = `${displayWidth}px`;
      canvas.style.height = `${displayHeight}px`;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.setTransform(deviceScale, 0, 0, deviceScale, 0, 0);
    ctx.clearRect(0, 0, displayWidth, displayHeight);

    const color = COLORS[threatLevel] || COLORS.GREEN;
    const cornerLength = 32;
    const cornerThickness = 4;

    ctx.strokeStyle = color;
    ctx.lineWidth = cornerThickness;
    ctx.lineCap = "round";
    ctx.globalAlpha = 0.7;

    const corners = [
      [20, 20, 1, 1],
      [displayWidth - 20, 20, -1, 1],
      [20, displayHeight - 20, 1, -1],
      [displayWidth - 20, displayHeight - 20, -1, -1],
    ];

    for (const [x, y, dx, dy] of corners) {
      ctx.beginPath();
      ctx.moveTo(x + dx * cornerLength, y);
      ctx.lineTo(x, y);
      ctx.lineTo(x, y + dy * cornerLength);
      ctx.stroke();
    }

    ctx.globalAlpha = 1;

    for (const detection of detections) {
      const { x, y, w, h } = detection.bbox;
      const boxColor = COLORS[detection.threatLevel] || COLORS.GREEN;
      const labelY = Math.max(y - 26, 6);

      if (detection.threatLevel === "RED") {
        ctx.shadowColor = boxColor;
        ctx.shadowBlur = 12;
      }

      ctx.strokeStyle = boxColor;
      ctx.lineWidth = detection.threatLevel === "RED" ? 3 : 2;
      ctx.strokeRect(x, y, w, h);
      ctx.shadowBlur = 0;

      const label = `${detection.label.toUpperCase()} ${(detection.confidence * 100).toFixed(0)}%`;
      ctx.font = "bold 13px 'JetBrains Mono', monospace";
      const textWidth = ctx.measureText(label).width;
      const pillPadding = 8;

      ctx.fillStyle = `${boxColor}cc`;
      ctx.beginPath();
      ctx.roundRect(x, labelY, textWidth + pillPadding * 2, 22, 4);
      ctx.fill();

      ctx.fillStyle = "#fff";
      ctx.fillText(label, x + pillPadding, labelY + 16);

      if (detection.frameRatio > 0.1) {
        const progress = Math.min(detection.frameRatio / 0.5, 1);
        ctx.fillStyle = `${boxColor}55`;
        ctx.fillRect(x, y + h + 2, w, 4);
        ctx.fillStyle = boxColor;
        ctx.fillRect(x, y + h + 2, w * progress, 4);

        if (detection.isClose) {
          ctx.fillStyle = boxColor;
          ctx.font = "bold 11px sans-serif";
          ctx.fillText("TOO CLOSE", x + 4, y + h + 18);
        }
      }
    }

    if (isProcessing) {
      ctx.fillStyle = "#ffffff44";
      ctx.font = "11px monospace";
      ctx.fillText("SCANNING...", displayWidth - 90, displayHeight - 12);
    }

    if (nightMode) {
      ctx.fillStyle = "#f59e0b88";
      ctx.font = "11px monospace";
      ctx.fillText("◐ NIGHT MODE", 20, displayHeight - 12);
    }
  }, [canvasRef, detections, isProcessing, nightMode, threatLevel]);

  return (
    <canvas
      ref={canvasRef}
      className="hud-canvas"
      style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
    />
  );
}

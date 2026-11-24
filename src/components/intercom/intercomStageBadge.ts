// Nhãn "Trước" (lượt giao), "Sau" (lượt thu) ở góc TRÊN TRÁI ảnh giao nhận intercom: khối bo tròn nền cam, chữ
// trắng đậm. Chỉ vẽ khi ảnh được in dấu (cùng điều kiện với `drawStamp`). Hàm riêng của intercom, không đụng
// `src/lib/photoStamp.ts`.

import type { IntercomKind } from "@/lib/intercom/staffIntercom";

const BADGE_FONT_FAMILY = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif";
const BADGE_BACKGROUND = "#c04a1a";
const BADGE_TEXT = "#ffffff";

export function stageBadgeLabel(kind: IntercomKind): string {
  return kind === "deliver" ? "Trước" : "Sau";
}

/** Cỡ chữ khoảng 4% cạnh ngắn ảnh, tối thiểu 20px; lề, đệm, bo góc tính theo cỡ chữ. */
export function drawStageBadge(
  ctx: CanvasRenderingContext2D,
  input: { label: string; width: number; height: number },
): void {
  const fontSize = Math.max(20, Math.round(Math.min(input.width, input.height) * 0.04));
  const margin = Math.round(fontSize * 0.6);
  const padX = Math.round(fontSize * 0.6);
  const padY = Math.round(fontSize * 0.3);
  ctx.save();
  ctx.font = `700 ${fontSize}px ${BADGE_FONT_FAMILY}`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  const textWidth = Math.ceil(ctx.measureText(input.label).width);
  const boxWidth = textWidth + padX * 2;
  const boxHeight = Math.round(fontSize * 1.2) + padY * 2;
  const radius = Math.round(boxHeight * 0.3);
  ctx.fillStyle = BADGE_BACKGROUND;
  ctx.beginPath();
  ctx.moveTo(margin + radius, margin);
  ctx.arcTo(margin + boxWidth, margin, margin + boxWidth, margin + boxHeight, radius);
  ctx.arcTo(margin + boxWidth, margin + boxHeight, margin, margin + boxHeight, radius);
  ctx.arcTo(margin, margin + boxHeight, margin, margin, radius);
  ctx.arcTo(margin, margin, margin + boxWidth, margin, radius);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = BADGE_TEXT;
  ctx.fillText(input.label, margin + padX, margin + boxHeight / 2);
  ctx.restore();
}

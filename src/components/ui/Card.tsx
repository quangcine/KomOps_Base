import type { ElementType, HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

// Bóng chỉ dành cho thẻ BẤM ĐƯỢC (`pressable`). Đây là quy ước ngầm nhưng khách đọc được ngay: có bóng nghĩa là
// chạm vào được. Đổ bóng cho thẻ chỉ để đọc là làm hỏng tín hiệu đó. Đã bỏ hiệu ứng thu nhỏ khi ấn: `transform` đẻ
// khối chứa mới, phá mọi thứ `position: fixed` bên trong thẻ.
export type CardProps = {
  as?: ElementType;
  pressable?: boolean;
  // Đệm khác mặc định thì `padded={false}` kèm lớp `p-N`: Tailwind xếp `p-[var(--block-pad)]` sau `p-0` tới `p-10`
  // nên lớp `p-N` trơn truyền qua `className` luôn thua token.
  padded?: boolean;
  className?: string;
  children?: ReactNode;
  // Khai thẳng ở đây thay vì dựng kiểu đa hình: đa hình đúng nghĩa cần generic hai tầng, đắt hơn nhiều so với thứ nó
  // giải quyết.
  href?: string;
} & Omit<HTMLAttributes<HTMLElement>, "className" | "children">;

export function Card({
  as: Tag = "div",
  pressable = false,
  padded = true,
  className,
  children,
  ...rest
}: CardProps) {
  return (
    <Tag
      className={cn(
        "rounded-card border border-border bg-card",
        padded && "p-[var(--block-pad)]",
        pressable && "shadow-[var(--shadow-e1)]",
        className,
      )}
      {...rest}
    >
      {children}
    </Tag>
  );
}

"use client";

// MỘT CỠ DUY NHẤT: cao 40px, bo tròn hoàn toàn, chữ 14px, icon 16px. `Chip` là NHÃN chỉ để đọc (cao 26px), đừng
// nhầm nó với chip lọc bấm được: chip bấm được là control, phải dùng `Button` ở đây. Focus: nút ra viền cam 2px
// cách 2px khi tới bằng bàn phím (`FOCUS_BUTTON`), ô nhập, ô chọn ra viền cam cộng vầng 3px khi bấm vào
// (`FOCUS_FIELD`). Chỉ làm trong tệp này, không có luật `:focus` chung ở `globals.css`.

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import Link from "next/link";
import { cn } from "@/lib/cn";

/** Cao 40px, bo tròn hoàn toàn, chữ 14px. Mọi control đều bắt đầu từ đây. */
const BASE_CLASS = "h-10 rounded-full text-body";

const FOCUS_BUTTON = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";

/** Khung nút chỉ có icon (40x40, vùng chạm 44): chung cho `IconButton` và `IconLink`. */
const ICON_CONTROL_CLASS = "touch-target size-10 rounded-full inline-flex shrink-0 items-center justify-center";

/**
 * Viền focus vẽ vào trong cho nút `SegmentedControl`: vẽ ra ngoài thì chạm viền hộp và viên bên cạnh (đệm, khe
 * chỉ 4px); mục đang chọn là nút `disabled` nên không nhận focus.
 */
const FOCUS_SEGMENT = "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand";

const FOCUS_FIELD = "focus:border-brand focus:outline-none focus:ring-3 focus:ring-brand/35";

/**
 * Bốn kiểu nút. `ghost` CỐ Ý không viền không nền: nó dành cho hành động thứ yếu như *Đóng* hay *Bỏ qua*. Cho nó
 * viền là ba nút cạnh nhau trông ngang vai nhau, người dùng không biết nút nào là chính.
 */
const VARIANT_CLASSES = {
  primary: "bg-brand-cta text-white font-medium",
  neutral: "border border-border bg-surface-2 text-fg font-medium",
  ghost: "text-muted",
  danger: "border border-danger/40 text-danger font-medium",
} as const;

export type ButtonVariant = keyof typeof VARIANT_CLASSES;

type ButtonProps = {
  variant?: ButtonVariant;
  /** Icon 16px đặt trước chữ. Truyền `<Plus className="size-4" aria-hidden />`. */
  icon?: ReactNode;
  children?: ReactNode;
  className?: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children">;

/**
 * Nút chữ. Mặc định `type="button"`. ĐỪNG bỏ: nút nằm trong `<form>` mà thiếu thuộc tính này thì trình duyệt coi
 * nó là nút gửi biểu mẫu, bấm vào là nạp lại trang và mất sạch thứ người dùng vừa gõ.
 */
export function Button({ variant = "neutral", icon, children, className, type = "button", ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        BASE_CLASS,
        // Vùng chạm ẩn 44px trên màn cảm ứng, hình giữ 40.
        "touch-target inline-flex shrink-0 items-center justify-center gap-1.5 px-3",
        "disabled:opacity-55",
        FOCUS_BUTTON,
        VARIANT_CLASSES[variant],
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}

type IconButtonProps = {
  variant?: ButtonVariant;
  icon: ReactNode;
  /** Bắt buộc: nút chỉ có icon thì người dùng trình đọc màn hình không biết nó làm gì. */
  label: string;
  className?: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children" | "aria-label">;

/** Nút chỉ có icon, vuông 40x40. */
export function IconButton({ variant = "neutral", icon, label, className, type = "button", ...rest }: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cn(
        ICON_CONTROL_CLASS,
        "disabled:opacity-55",
        FOCUS_BUTTON,
        VARIANT_CLASSES[variant],
        className,
      )}
      {...rest}
    >
      {icon}
    </button>
  );
}

type IconLinkProps = {
  href: string;
  variant?: ButtonVariant;
  icon: ReactNode;
  /** Bắt buộc, như `IconButton`: vào `aria-label` và `title`. */
  label: string;
  className?: string;
};

/**
 * Liên kết dáng `IconButton` (vuông 40x40, cùng lớp): dùng khi nút icon dẫn sang trang khác, để vẫn là `<a
 * href>` thật (chuột giữa, chuột phải mở tab mới được).
 */
export function IconLink({ href, variant = "neutral", icon, label, className }: IconLinkProps) {
  return (
    <Link
      href={href}
      aria-label={label}
      title={label}
      className={cn(ICON_CONTROL_CLASS, FOCUS_BUTTON, VARIANT_CLASSES[variant], className)}
    >
      {icon}
    </Link>
  );
}

type InputProps = {
  className?: string;
  /** Icon 16px nằm trong ô, sát mép trái. */
  icon?: ReactNode;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "className">;

/**
 * Ô nhập và ô tìm. Trên iPhone, ô nhập có chữ **nhỏ hơn 16px** làm Safari tự phóng to cả trang khi người dùng
 * chạm vào. Nếu về sau có màn nhập liệu dùng nhiều trên điện thoại thì xử lý bằng `maximum-scale` ở khai báo màn
 * hình, đừng phá thang chữ của cả app.
 */
export function Input({ className, icon, ...rest }: InputProps) {
  const field = (
    <input
      className={cn(
        BASE_CLASS,
        "w-full border border-border bg-surface px-3 text-fg",
        "placeholder:text-faint disabled:opacity-55",
        FOCUS_FIELD,
        // Ba ngôi chứ không phải `&&`: `ReactNode` gồm cả số, nên `icon && "pl-9"` có thể trả về chính số 0 và `cn` không
        // nhận kiểu đó.
        icon ? "pl-9" : null,
        className,
      )}
      {...rest}
    />
  );
  if (!icon) return field;
  return (
    <label className="relative flex min-w-0 flex-1 items-center">
      <span className="pointer-events-none absolute left-3 flex text-faint">{icon}</span>
      {field}
    </label>
  );
}

type SelectProps = {
  className?: string;
  children: ReactNode;
} & Omit<SelectHTMLAttributes<HTMLSelectElement>, "className" | "children">;

/**
 * Ô chọn: MỘT thẻ `select` duy nhất, `className` nơi gọi đặt thẳng lên nó. VÌ SAO ẩn mũi tên gốc của trình
 * duyệt: mũi tên gốc nằm sát mép phải, đè lên viền bo `rounded-full`. `appearance-none` ẩn nó, rồi vẽ lại
 * chevron bằng `background-image` cách mép phải 12px. Màu nét là `--muted` nhưng ảnh SVG nhúng không đọc được
 * biến CSS, nên chép tay hai mã hex: tối `#a1a6ad` (mặc định) và sáng `#5a636e` (`globals.css`,
 * khi `html[data-theme="light"]`). Đổi `--muted` thì sửa cả hai mã ở đây. Theme chạy bằng `data-theme` chứ không
 * bằng `prefers-color-scheme`, nên biến thể `dark:` của Tailwind không dùng được ở đây. `disabled:opacity-55` làm mờ
 * cả mũi tên vì mũi tên là nền của chính `select`.
 */
export function Select({ className, children, ...rest }: SelectProps) {
  return (
    <select
      className={cn(
        BASE_CLASS,
        "appearance-none border border-border bg-surface bg-[length:16px_16px] bg-[position:right_12px_center] bg-no-repeat pl-3 pr-9 text-fg disabled:opacity-55",
        FOCUS_FIELD,
        "bg-[url(data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2024%2024%27%20fill=%27none%27%20stroke=%27%23a1a6ad%27%20stroke-width=%272%27%20stroke-linecap=%27round%27%20stroke-linejoin=%27round%27%3E%3Cpath%20d=%27m6%209%206%206%206-6%27/%3E%3C/svg%3E)] [[data-theme=light]_&]:bg-[url(data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2024%2024%27%20fill=%27none%27%20stroke=%27%235a636e%27%20stroke-width=%272%27%20stroke-linecap=%27round%27%20stroke-linejoin=%27round%27%3E%3Cpath%20d=%27m6%209%206%206%206-6%27/%3E%3C/svg%3E)]",
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
}

/**
 * Hai nút gạt qua lại, ví dụ *Không VAT* và *VAT 8%*. Kiểu A: hộp ngoài bo tròn, có viền, nền `bg-surface-2`,
 * đệm 4px; nút đang chọn là viên cam bo tròn nằm trong hộp, nút chưa chọn không nền. Cao cụm 42px như cũ (đệm
 * 4px hai mép, viên 32px, viền 1px hai mép). Hộp không `overflow-hidden` để viền focus không bị xén. Viên
 * `flex-1 min-w-fit`: hộp co theo nội dung (`self-start`, `w-fit`, `ml-auto`) thì mỗi viên ôm chữ; hộp kéo hết
 * bề ngang thì các viên rộng bằng nhau, lấp kín hộp.
 */
export function SegmentedControl<T extends string>({
  options,
  selected,
  onSelect,
  disabled,
  className,
}: {
  options: readonly { value: T; label: string }[];
  selected: T;
  onSelect: (value: T) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex gap-1 rounded-full border border-border bg-surface-2 p-1", className)}>
      {options.map((m) => {
        const isSelected = m.value === selected;
        return (
          <button
            key={m.value}
            type="button"
            disabled={disabled || isSelected}
            // Màu là dấu hiệu DUY NHẤT của nút đang chọn, trình đọc màn hình không thấy màu.
            aria-pressed={isSelected}
            onClick={() => onSelect(m.value)}
            className={cn(
              "touch-target h-8 min-w-fit flex-1 rounded-full px-3 text-body",
              FOCUS_SEGMENT,
              isSelected ? "bg-brand-cta font-medium text-white" : "text-muted disabled:opacity-55",
            )}
          >
            {m.label}
          </button>
        );
      })}
    </div>
  );
}

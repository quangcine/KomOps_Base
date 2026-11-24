import { Headphones } from "lucide-react";
import { APP_NAME } from "@/adapters/brand";

/** Chỗ đặt logo của bạn. */
export function WorkLogo({ text = APP_NAME }: { text?: string }) {
  return (
    <span className="flex items-center gap-2 text-base font-semibold text-fg">
      <Headphones className="size-5 text-brand" aria-hidden />
      {text}
    </span>
  );
}

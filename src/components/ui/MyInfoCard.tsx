"use client";

import { Mail, Phone } from "lucide-react";
import { useWork } from "@/adapters/SessionGate";
import { Card } from "./Card";

export function MyInfoCard() {
  const { profile } = useWork();
  return (
    <Card>
      <p className="text-body font-semibold text-fg">Thông tin của bạn</p>
      <div className="mt-2 flex flex-col gap-2 text-body text-fg">
        <span className="flex items-center gap-2">
          <Phone size={16} aria-hidden /> {profile?.phone || "-"}
        </span>
        <span className="flex items-center gap-2">
          <Mail size={16} aria-hidden /> {profile?.email || "-"}
        </span>
      </div>
    </Card>
  );
}

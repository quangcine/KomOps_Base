"use client";

// Danh sách dự án intercom và dự án đang chọn (nhớ ở `localStorage`), dùng chung cho màn chụp và dashboard.

import { useCallback, useEffect, useState } from "react";
import { listIntercomProjects, type IntercomProject } from "@/lib/intercom/staffIntercom";
import { readStoredProjectId, storeProjectId } from "./intercomView";

export function useIntercomProject() {
  const [projects, setProjects] = useState<IntercomProject[] | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listIntercomProjects()
      .then((list) => {
        if (cancelled) return;
        setProjects(list);
        const stored = readStoredProjectId();
        // Dự án đã nhớ không còn trong danh sách: chọn dự án đầu, không báo lỗi; ghi lại để footer, màn khác mở đúng dự án
        // mới.
        const pick = list.find((p) => p.id === stored) ?? list[0] ?? null;
        setProjectId(pick?.id ?? null);
        if (pick && pick.id !== stored) storeProjectId(pick.id);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Chưa tải được danh sách dự án.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectProject = useCallback((id: string) => {
    setProjectId(id);
    storeProjectId(id);
  }, []);

  return { projects, projectId, selectProject, error };
}

"use client";

// Khối Kỹ thuật (thành viên dự án) của màn chi tiết dự án intercom.
// - Không chặn tự bỏ mình hay bỏ người cuối; bỏ chính mình thì hỏi "Bạn sẽ không còn thấy dự án này" trước. Ô tìm
// không điều khiển (`defaultValue` cộng `onInput`): bàn phím tiếng Việt iOS bỏ dấu bằng xoá lùi rồi chèn lại, ô
// `value` ghi đè.

import { useCallback, useEffect, useRef, useState } from "react";
import { Search, Wrench } from "lucide-react";
import {
  addIntercomMembers,
  getIntercomAccess,
  listIntercomMembers,
  removeIntercomMember,
  searchIntercomMemberCandidates,
  type IntercomMember,
  type IntercomMemberCandidate,
} from "@/lib/intercom/staffIntercom";
import { Modal } from "@/components/ui/Modal";
import { useWork } from "@/adapters/SessionGate";
import { useConfirm } from "@/components/ui/useConfirm";
import { IntercomAccordionBlock } from "./IntercomAccordionBlock";

const SECONDARY_BUTTON =
  "h-11 rounded-control border border-border bg-surface px-3 text-base text-fg active:bg-surface-2 disabled:opacity-50";
const SEARCH_DELAY_MS = 300;
const NO_LOGIN_LABEL = "Cộng tác viên, chưa có tài khoản";

export function IntercomMemberSection({
  projectId,
  onSelfRemoved,
}: {
  projectId: string;
  onSelfRemoved: () => void;
}) {
  const { userId, perms } = useWork();
  const [isManager, setIsManager] = useState(false);
  const canEdit = perms.isStaff || isManager;
  const [members, setMembers] = useState<IntercomMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const { ask, dialog } = useConfirm();

  const reload = useCallback(async () => {
    try {
      setMembers(await listIntercomMembers(projectId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Chưa tải được danh sách kỹ thuật.");
    }
  }, [projectId]);

  // Quản lý không phải nhân viên cũng sửa được (như hàm SQL). Lỗi đọc quyền thì để ẩn nút.
  useEffect(() => {
    let alive = true;
    getIntercomAccess()
      .then((access) => {
        if (alive) setIsManager(access.is_manager);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    setMembers(null);
    void reload();
  }, [reload]);

  const remove = async (member: IntercomMember) => {
    const isSelf = member.profile_id === userId;
    if (
      isSelf &&
      !(await ask({
        title: "Bỏ chính mình",
        content: "Bạn sẽ không còn thấy dự án này.",
        confirmLabel: "Bỏ",
        danger: true,
      }))
    ) {
      return;
    }
    setRemovingId(member.profile_id);
    setNotice(null);
    try {
      await removeIntercomMember(projectId, member.profile_id);
      if (isSelf) {
        onSelfRemoved();
        return;
      }
      setNotice(`Đã bỏ ${member.name}.`);
      await reload();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Chưa bỏ được kỹ thuật.");
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <IntercomAccordionBlock
      title="Kỹ thuật"
      icon={Wrench}
      count={members?.length}
      onAdd={canEdit ? () => setAdding(true) : undefined}
    >
      {error ? <p className="text-base text-danger">{error}</p> : null}
      {!members && !error ? <p className="text-base text-muted">Đang tải...</p> : null}
      {members && members.length === 0 ? <p className="text-base text-muted">Chưa có kỹ thuật nào.</p> : null}
      {notice ? <p className="text-base text-muted">{notice}</p> : null}

      {members && members.length > 0 ? (
        <ul className="divide-y divide-border">
          {members.map((m) => (
            <li key={m.profile_id} className="flex items-center gap-2 py-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-base font-semibold text-fg">
                  {m.name}
                  {m.profile_id === userId ? <span className="font-normal text-muted"> (bạn)</span> : null}
                </span>
                {!m.has_login ? <span className="block text-sm text-muted">{NO_LOGIN_LABEL}</span> : null}
              </span>
              {canEdit ? (
                <button
                  type="button"
                  disabled={removingId !== null}
                  onClick={() => void remove(m)}
                  className="h-11 rounded-control border border-danger px-3 text-base text-danger active:bg-danger/10 disabled:opacity-50"
                >
                  {removingId === m.profile_id ? "Đang bỏ..." : "Bỏ"}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {canEdit ? (
        <AddMembersDialog
          open={adding}
          projectId={projectId}
          memberIds={new Set((members ?? []).map((m) => m.profile_id))}
          onClose={() => setAdding(false)}
          onAdded={async (added, picked) => {
            setAdding(false);
            const skipped = picked - added;
            setNotice(
              skipped > 0
                ? `Đã thêm ${added} người; ${skipped} người đã là kỹ thuật hoặc không thêm được.`
                : `Đã thêm ${added} người.`,
            );
            await reload();
          }}
        />
      ) : null}
      {dialog}
    </IntercomAccordionBlock>
  );
}

function AddMembersDialog({
  open,
  projectId,
  memberIds,
  onClose,
  onAdded,
}: {
  open: boolean;
  projectId: string;
  memberIds: ReadonlySet<string>;
  onClose: () => void;
  onAdded: (added: number, picked: number) => Promise<void>;
}) {
  const [search, setSearch] = useState("");
  const [candidates, setCandidates] = useState<IntercomMemberCandidate[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Map<string, string>>(new Map());
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const { ask, dialog } = useConfirm();

  // Mở lại thì bắt đầu sạch.
  useEffect(() => {
    if (!open) return;
    setSearch("");
    setPicked(new Map());
    setSaveError(null);
    if (searchRef.current) searchRef.current.value = "";
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const timer = window.setTimeout(() => {
      searchIntercomMemberCandidates(search.trim())
        .then((list) => {
          if (!alive) return;
          setCandidates(list);
          setLoadError(null);
        })
        .catch((e: unknown) => {
          if (alive) setLoadError(e instanceof Error ? e.message : "Chưa tìm được người.");
        });
    }, SEARCH_DELAY_MS);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [open, search]);

  const requestClose = async () => {
    if (busy) return;
    if (picked.size > 0 && !(await ask({ content: "Bỏ thay đổi?", confirmLabel: "Bỏ thay đổi", danger: true }))) return;
    onClose();
  };

  const toggle = (c: IntercomMemberCandidate) => {
    setPicked((prev) => {
      const next = new Map(prev);
      if (next.has(c.profile_id)) next.delete(c.profile_id);
      else next.set(c.profile_id, c.name);
      return next;
    });
  };

  const submit = async () => {
    if (picked.size === 0) return;
    setBusy(true);
    setSaveError(null);
    try {
      const added = await addIntercomMembers(projectId, [...picked.keys()]);
      await onAdded(added, picked.size);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Chưa thêm được kỹ thuật.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => void requestClose()}
      title="Thêm kỹ thuật"
      width="narrow"
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" onClick={() => void requestClose()} className={SECONDARY_BUTTON}>
            Huỷ
          </button>
          <button
            type="button"
            disabled={busy || picked.size === 0}
            onClick={() => void submit()}
            className="h-11 rounded-control bg-brand-cta px-4 text-base font-semibold text-white active:bg-brand-cta-hover disabled:opacity-50"
          >
            {busy ? "Đang thêm..." : picked.size > 0 ? `Thêm ${picked.size} người` : "Thêm"}
          </button>
        </div>
      }
    >
      <div className="space-y-2">
        <label className="relative flex items-center">
          <Search className="pointer-events-none absolute left-3 size-4 text-muted" aria-hidden />
          <input
            ref={searchRef}
            type="search"
            defaultValue=""
            onInput={(e) => setSearch(e.currentTarget.value)}
            placeholder="Tìm tên"
            aria-label="Tìm người để thêm"
            autoComplete="off"
            className="h-12 w-full rounded-control border border-border bg-surface pl-9 pr-3 text-base text-fg"
          />
        </label>
        {loadError ? <p className="text-base text-danger">{loadError}</p> : null}
        {!candidates && !loadError ? <p className="text-base text-muted">Đang tải...</p> : null}
        {candidates && candidates.length === 0 ? <p className="text-base text-muted">Không có người khớp tìm kiếm.</p> : null}
        {candidates && candidates.length > 0 ? (
          <ul className="divide-y divide-border">
            {candidates.map((c) => {
              const isMember = memberIds.has(c.profile_id);
              return (
                <li key={c.profile_id}>
                  <label className="flex min-h-11 items-center gap-3 py-2 active:bg-surface-2">
                    <input
                      type="checkbox"
                      checked={isMember || picked.has(c.profile_id)}
                      disabled={isMember || busy}
                      onChange={() => toggle(c)}
                      className="size-5 shrink-0"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-base text-fg">{c.name}</span>
                      {isMember ? (
                        <span className="block text-sm text-muted">Đã là kỹ thuật</span>
                      ) : !c.has_login ? (
                        <span className="block text-sm text-muted">{NO_LOGIN_LABEL}</span>
                      ) : null}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        ) : null}
        {saveError ? <p className="text-base text-danger">{saveError}</p> : null}
      </div>
      {dialog}
    </Modal>
  );
}

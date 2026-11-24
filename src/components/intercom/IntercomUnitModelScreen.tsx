"use client";

// Màn danh mục Model tai nghe `/intercom/models`: danh sách Model (ảnh, tên, số tai, giờ), lọc "Chưa duyệt", sửa,
// duyệt, gộp vào Model khác, tải ảnh. Model đã gộp hiện mờ kèm "Đã gộp vào <tên>", không còn nút thao tác. Tệp này
// cũng xuất phần dùng chung với form Thêm bộ (`IntercomUnitSetBlock`): ô ảnh Model, ô nhập thông số Model, đọc
// giờ.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronLeft, Headphones } from "lucide-react";
import { compressAvatar } from "@/lib/avatar";
import { cn } from "@/lib/cn";
import { Modal } from "@/components/ui/Modal";
import {
  INTERCOM_HOURS_MAX,
  INTERCOM_HOURS_MIN,
  INTERCOM_MODEL_NAME_MAX,
  INTERCOM_MODEL_REGULAR_MAX,
  approveIntercomUnitModel,
  hasStaffRole,
  intercomHoursLabel,
  listIntercomUnitModels,
  mergeIntercomUnitModel,
  saveIntercomUnitModel,
  unitModelPhotoUrl,
  type IntercomUnitModel,
  type IntercomUnitModelInput,
} from "@/lib/intercom/staffIntercomUnitModel";
import { useConfirm } from "@/components/ui/useConfirm";

const FIELD_CLASS = "mt-1 h-12 w-full rounded-control border border-border bg-surface px-3 text-base text-fg";
const SECONDARY_BUTTON =
  "h-11 whitespace-nowrap rounded-control border border-border bg-surface px-3 text-base text-fg active:bg-surface-2 disabled:opacity-50";
const PRIMARY_BUTTON =
  "h-11 rounded-control bg-brand-cta px-4 text-base font-semibold text-white active:bg-brand-cta-hover disabled:opacity-50";

function errorText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

// Phần dùng chung với form Thêm bộ, Sửa bộ.

/** Đọc ô giờ: nhận `0,5` hoặc `0.5`, một chữ số thập phân, 0,5 tới 48. Ô trống hoặc sai là `null`. */
export function parseHours(text: string): number | null {
  const normalized = text.trim().replace(",", ".");
  if (!/^\d{1,2}(\.\d)?$/.test(normalized)) return null;
  const n = Number(normalized);
  return n >= INTERCOM_HOURS_MIN && n <= INTERCOM_HOURS_MAX ? n : null;
}

/** Giờ ra chữ cho ô nhập: `0,5`; `null` là ô trống. */
export function hoursText(n: number | null | undefined): string {
  return n === null || n === undefined ? "" : String(n).replace(".", ",");
}

export const HOURS_ERROR = `Giờ pin từ ${hoursText(INTERCOM_HOURS_MIN)} tới ${INTERCOM_HOURS_MAX}, tối đa một số lẻ.`;

/** Ô ảnh vuông của Model: ảnh nhỏ `_t` hoặc hình tai nghe khi chưa có ảnh, ảnh lỗi. */
export function IntercomUnitModelThumb({ model, className }: { model: IntercomUnitModel; className?: string }) {
  const url = model.photo_key ? unitModelPhotoUrl(model.id, model.photo_key, "thumb") : null;
  // Giữ theo đường dẫn, không theo cờ: thay ảnh mới thì tự thử tải lại.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return (
    <span className={cn("block shrink-0 overflow-hidden rounded-control border border-border bg-surface-2", className)}>
      {url && url !== failedUrl ? (
        <img src={url} alt="" loading="lazy" onError={() => setFailedUrl(url)} className="size-full object-cover" />
      ) : (
        <span className="flex size-full items-center justify-center text-muted">
          <Headphones className="size-1/3" aria-hidden />
        </span>
      )}
    </span>
  );
}

/** Nháp ô nhập thông số một Model (chữ, chưa đọc). */
export type UnitModelDraft = {
  name: string;
  maxUnits: string;
  hasMaster: boolean;
  isHub: boolean;
  unitHours: string;
  masterMin: string;
  masterMax: string;
  hubHours: string;
};

export const EMPTY_MODEL_DRAFT: UnitModelDraft = {
  name: "",
  maxUnits: "",
  hasMaster: true,
  isHub: false,
  unitHours: "",
  masterMin: "",
  masterMax: "",
  hubHours: "",
};

export function draftFromModel(model: IntercomUnitModel): UnitModelDraft {
  return {
    name: model.name,
    maxUnits: String(model.max_units),
    hasMaster: model.has_master,
    isHub: model.is_hub,
    unitHours: hoursText(model.unit_hours),
    masterMin: hoursText(model.master_hours_min),
    masterMax: hoursText(model.master_hours_max),
    hubHours: hoursText(model.hub_hours),
  };
}

/** Trần số tai của Model: có tai chủ thì 20 tai thường cộng `M`. */
export function modelUnitsCap(hasMaster: boolean): number {
  return hasMaster ? INTERCOM_MODEL_REGULAR_MAX + 1 : INTERCOM_MODEL_REGULAR_MAX;
}

/** Đọc nháp ra thông số gửi máy chủ; sai thì trả câu báo. Cùng luật hàm SQL `_intercom_unit_model_validate`. */
export function readModelDraft(draft: UnitModelDraft): { input: IntercomUnitModelInput } | { error: string } {
  const name = draft.name.trim();
  if (name === "" || name.length > INTERCOM_MODEL_NAME_MAX) {
    return { error: `Tên Model từ 1 tới ${INTERCOM_MODEL_NAME_MAX} ký tự.` };
  }
  const hasMaster = draft.hasMaster && !draft.isHub;
  const cap = modelUnitsCap(hasMaster);
  const minUnits = hasMaster ? 2 : 1;
  const maxUnits = Number(draft.maxUnits);
  if (!Number.isInteger(maxUnits) || maxUnits < minUnits || maxUnits > cap) {
    return {
      error: hasMaster
        ? `Số tai tối đa từ 2 tới ${cap} (tai chủ cộng tối đa ${INTERCOM_MODEL_REGULAR_MAX} tai thường).`
        : `Số tai tối đa từ 1 tới ${cap}.`,
    };
  }
  const unitHours = parseHours(draft.unitHours);
  if (unitHours === null) return { error: `Giờ tai thường: ${HOURS_ERROR}` };
  let masterMin: number | null = null;
  let masterMax: number | null = null;
  if (hasMaster) {
    masterMin = parseHours(draft.masterMin);
    masterMax = parseHours(draft.masterMax);
    if (masterMin === null || masterMax === null) return { error: `Giờ tai chủ Từ, Đến: ${HOURS_ERROR}` };
    if (masterMin > masterMax) return { error: "Giờ tai chủ: Từ không lớn hơn Đến." };
  }
  let hubHours: number | null = null;
  if (draft.hubHours.trim() !== "") {
    hubHours = parseHours(draft.hubHours);
    if (hubHours === null) return { error: `Giờ pin Hub: ${HOURS_ERROR}` };
  }
  return {
    input: { name, maxUnits, hasMaster, isHub: draft.isHub, unitHours, masterMin, masterMax, hubHours: draft.isHub ? hubHours : null },
  };
}

/** Một ô giờ (bàn phím số có dấu phẩy). */
export function HoursField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block text-base text-fg">
      {label}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode="decimal"
        autoComplete="off"
        maxLength={4}
        placeholder={placeholder}
        className={FIELD_CLASS}
      />
    </label>
  );
}

/** Ô nhập thông số Model: Custom ở form Thêm bộ và hộp Sửa Model của màn danh mục. Bật "Là Hub" thì tắt tai chủ. */
export function UnitModelFields({ draft, onChange }: { draft: UnitModelDraft; onChange: (draft: UnitModelDraft) => void }) {
  const set = (patch: Partial<UnitModelDraft>) => onChange({ ...draft, ...patch });
  const hasMaster = draft.hasMaster && !draft.isHub;
  return (
    <div className="space-y-3">
      <label className="block text-base text-fg">
        Tên Model
        <input
          value={draft.name}
          onChange={(e) => set({ name: e.target.value })}
          maxLength={INTERCOM_MODEL_NAME_MAX}
          autoComplete="off"
          placeholder="Vd: Tên Model"
          className={FIELD_CLASS}
        />
      </label>
      <label className="block text-base text-fg">
        Số tai tối đa (tối đa {modelUnitsCap(hasMaster)})
        <input
          type="number"
          inputMode="numeric"
          min={hasMaster ? 2 : 1}
          max={modelUnitsCap(hasMaster)}
          value={draft.maxUnits}
          onChange={(e) => set({ maxUnits: e.target.value })}
          className={FIELD_CLASS}
        />
      </label>
      <label className="flex min-h-11 items-center gap-3 text-base text-fg">
        <input
          type="checkbox"
          checked={hasMaster}
          disabled={draft.isHub}
          onChange={(e) => set({ hasMaster: e.target.checked })}
          className="size-5 shrink-0"
        />
        Có tai chủ (mã M)
      </label>
      <label className="flex min-h-11 items-center gap-3 text-base text-fg">
        <input
          type="checkbox"
          checked={draft.isHub}
          onChange={(e) => set({ isHub: e.target.checked, hasMaster: e.target.checked ? false : draft.hasMaster })}
          className="size-5 shrink-0"
        />
        Là Hub
      </label>
      <HoursField label="Giờ pin tai thường" value={draft.unitHours} onChange={(v) => set({ unitHours: v })} placeholder="Vd: 10" />
      {hasMaster ? (
        <div className="grid grid-cols-2 gap-2">
          <HoursField label="Tai chủ Từ (giờ)" value={draft.masterMin} onChange={(v) => set({ masterMin: v })} />
          <HoursField label="Tai chủ Đến (giờ)" value={draft.masterMax} onChange={(v) => set({ masterMax: v })} />
        </div>
      ) : null}
      {draft.isHub ? (
        <HoursField
          label="Giờ pin Hub (không bắt buộc)"
          value={draft.hubHours}
          onChange={(v) => set({ hubHours: v })}
        />
      ) : null}
    </div>
  );
}

// Ảnh Model: cắt vuông ở trình duyệt, gửi JSON base64. Bản lớn 720, bản nhỏ 256 (`compressAvatar`).

const PHOTO_ROUTE = "/api/intercom/unit-model-photo";
const SOURCE_MAX_BYTES = 25 * 1024 * 1024;
const PHOTO_SIDE = 720;
const JPEG_QUALITY = 0.82;

function stripDataUrlPrefix(dataUrl: string): string {
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

/** Cắt vuông giữa ảnh, trả data URL JPEG 720x720. */
async function cropSquarePhoto(file: File): Promise<string> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("Không đọc được ảnh.");
  }
  try {
    const canvas = document.createElement("canvas");
    canvas.width = PHOTO_SIDE;
    canvas.height = PHOTO_SIDE;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Trình duyệt không xử lý được ảnh này.");
    const side = Math.min(bitmap.width, bitmap.height);
    ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, PHOTO_SIDE, PHOTO_SIDE);
    return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  } finally {
    bitmap.close();
  }
}

async function readRouteError(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === "string" && body.error !== "" ? body.error : fallback;
}

async function uploadModelPhoto(modelId: string, file: File): Promise<void> {
  if (file.size > SOURCE_MAX_BYTES) throw new Error("Ảnh quá lớn, tối đa 25MB.");
  // Lần lượt, không song song: hai lần giải mã cùng lúc nặng bộ nhớ trên iPhone.
  const photo = await cropSquarePhoto(file);
  const thumb = await compressAvatar(file);
  const res = await fetch(`${PHOTO_ROUTE}/${modelId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ photo: stripDataUrlPrefix(photo), thumb: stripDataUrlPrefix(thumb) }),
  });
  if (!res.ok) throw new Error(await readRouteError(res, "Chưa lưu được ảnh, thử lại giúp tôi."));
}

async function removeModelPhoto(modelId: string): Promise<void> {
  const res = await fetch(`${PHOTO_ROUTE}/${modelId}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await readRouteError(res, "Chưa gỡ được ảnh, thử lại giúp tôi."));
}

// Màn danh mục.

type SeatState = "checking" | "seated" | "denied";

export function IntercomUnitModelScreen() {
  const [seat, setSeat] = useState<SeatState>("checking");
  const [models, setModels] = useState<IntercomUnitModel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingOnly, setPendingOnly] = useState(false);
  const [editing, setEditing] = useState<IntercomUnitModel | null>(null);
  const [merging, setMerging] = useState<IntercomUnitModel | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  /** Model đang mở hàng nút; bấm vào dòng Model để mở, bấm lại để đóng. */
  const [openId, setOpenId] = useState<string | null>(null);
  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const photoTargetRef = useRef<string | null>(null);
  const editDirtyRef = useRef(false);
  const { ask, dialog } = useConfirm();

  const load = useCallback(async () => {
    try {
      setModels(await listIntercomUnitModels());
      setError(null);
    } catch (e) {
      setError(errorText(e, "Chưa tải được danh mục Model."));
    }
  }, []);

  useEffect(() => {
    let alive = true;
    hasStaffRole().then((seated) => {
      if (!alive) return;
      setSeat(seated ? "seated" : "denied");
      if (seated) void load();
    });
    return () => {
      alive = false;
    };
  }, [load]);

  const nameOf = (id: string | null) => (id ? (models?.find((m) => m.id === id)?.name ?? "Model khác") : "");

  const runAction = async (id: string, action: () => Promise<string>) => {
    setBusyId(id);
    setError(null);
    setNotice(null);
    try {
      setNotice(await action());
      await load();
    } catch (e) {
      setError(errorText(e, "Chưa làm được, thử lại giúp tôi."));
    } finally {
      setBusyId(null);
    }
  };

  const requestCloseEdit = async () => {
    if (editDirtyRef.current && !(await ask({ content: "Bỏ các thay đổi chưa lưu?", confirmLabel: "Bỏ thay đổi", danger: true }))) {
      return;
    }
    editDirtyRef.current = false;
    setEditing(null);
  };

  const pickPhoto = (id: string) => {
    photoTargetRef.current = id;
    photoInputRef.current?.click();
  };

  const header = (
    <div className="flex items-center gap-2">
      <Link
        href="/intercom/projects"
        aria-label="Về màn Dự án"
        className="flex size-11 items-center justify-center rounded-control text-fg active:bg-surface-2"
      >
        <ChevronLeft className="size-5" aria-hidden />
      </Link>
      <h1 className="min-w-0 flex-1 text-card font-semibold text-fg">Danh mục Model</h1>
    </div>
  );

  if (seat !== "seated") {
    return (
      <div className="mx-auto w-full max-w-2xl space-y-3">
        {header}
        <p className="py-6 text-base text-muted">
          {seat === "checking" ? "Đang kiểm tra quyền..." : "Chỉ nhân viên mở được danh mục Model."}
        </p>
      </div>
    );
  }

  const pendingCount = (models ?? []).filter((m) => m.status === "pending" && !m.merged_into).length;
  const shown = (models ?? []).filter((m) => !pendingOnly || (m.status === "pending" && !m.merged_into));

  return (
    <div className="mx-auto w-full max-w-2xl space-y-3">
      {header}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          aria-pressed={pendingOnly}
          onClick={() => setPendingOnly((v) => !v)}
          className={cn(
            "h-11 rounded-control px-3 text-base",
            pendingOnly ? "bg-brand-cta font-semibold text-white" : "border border-border bg-surface text-fg active:bg-surface-2",
          )}
        >
          Chưa duyệt ({pendingCount})
        </button>
      </div>

      {error ? (
        <p className="text-base text-danger" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="text-base text-muted" role="status">
          {notice}
        </p>
      ) : null}
      {!models && !error ? <p className="py-6 text-base text-muted">Đang tải...</p> : null}
      {models && shown.length === 0 ? <p className="py-6 text-base text-muted">Không có Model nào.</p> : null}

      {shown.length > 0 ? (
        <ul className="divide-y divide-border rounded-card border border-border bg-surface">
          {shown.map((m) => {
            const merged = m.merged_into !== null;
            const busy = busyId === m.id;
            const open = !merged && openId === m.id;
            const summary = (
              <>
                <IntercomUnitModelThumb model={m} className="size-16" />
                <span className="min-w-0 flex-1">
                  <span className="block text-block font-semibold text-fg">
                    {m.name}
                    {m.status === "pending" && !merged ? (
                      <span className="ml-2 rounded-control bg-surface-2 px-1.5 py-0.5 text-sm font-normal text-muted">
                        Chưa duyệt
                      </span>
                    ) : null}
                  </span>
                  <span className="block text-sm text-muted">
                    {m.max_units} tai{m.is_hub ? " · Hub" : ""} · {intercomHoursLabel(m)}
                  </span>
                  {merged ? <span className="block text-sm text-muted">Đã gộp vào {nameOf(m.merged_into)}</span> : null}
                </span>
              </>
            );
            return (
              <li key={m.id} className={cn("flex flex-wrap items-center gap-3 p-3", merged && "opacity-50")}>
                {merged ? (
                  summary
                ) : (
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => setOpenId((current) => (current === m.id ? null : m.id))}
                    className="flex min-w-0 flex-1 items-center gap-3 rounded-control text-left active:bg-surface-2"
                  >
                    {summary}
                  </button>
                )}
                {open ? (
                  <span className="flex basis-full flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        editDirtyRef.current = false;
                        setEditing(m);
                      }}
                      className={SECONDARY_BUTTON}
                    >
                      Sửa
                    </button>
                    {m.status === "pending" ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void runAction(m.id, async () => {
                            await approveIntercomUnitModel(m.id);
                            return `Đã duyệt ${m.name}.`;
                          })
                        }
                        className={SECONDARY_BUTTON}
                      >
                        Duyệt
                      </button>
                    ) : null}
                    <button type="button" disabled={busy} onClick={() => setMerging(m)} className={SECONDARY_BUTTON}>
                      Gộp
                    </button>
                    <button type="button" disabled={busy} onClick={() => pickPhoto(m.id)} className={SECONDARY_BUTTON}>
                      {m.photo_key ? "Thay ảnh" : "Tải ảnh"}
                    </button>
                    {m.photo_key ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void (async () => {
                            const ok = await ask({ content: `Gỡ ảnh của ${m.name}?`, confirmLabel: "Gỡ ảnh", danger: true });
                            if (!ok) return;
                            await runAction(m.id, async () => {
                              await removeModelPhoto(m.id);
                              return `Đã gỡ ảnh ${m.name}.`;
                            });
                          })()
                        }
                        className={SECONDARY_BUTTON}
                      >
                        Gỡ ảnh
                      </button>
                    ) : null}
                  </span>
                ) : null}
                {busy ? (
                  <span className="w-full text-sm text-muted" role="status">
                    Đang lưu...
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      <input
        ref={photoInputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          // Xoá giá trị để chọn lại đúng tệp đó vẫn chạy.
          e.currentTarget.value = "";
          const id = photoTargetRef.current;
          const model = models?.find((m) => m.id === id);
          if (file && id && model) {
            void runAction(id, async () => {
              await uploadModelPhoto(id, file);
              return `Đã lưu ảnh ${model.name}.`;
            });
          }
        }}
      />

      <Modal open={editing !== null} onClose={() => void requestCloseEdit()} title={`Sửa ${editing?.name ?? ""}`} width="narrow">
        {editing ? (
          <EditModelForm
            key={editing.id}
            model={editing}
            onDirtyChange={(dirty) => {
              editDirtyRef.current = dirty;
            }}
            onCancel={() => void requestCloseEdit()}
            onSave={async (input) => {
              await saveIntercomUnitModel(editing.id, input);
              editDirtyRef.current = false;
              setEditing(null);
              setNotice(`Đã lưu ${input.name}. Giờ đã ghi trên các bộ đang dùng không đổi.`);
              await load();
            }}
          />
        ) : null}
      </Modal>

      <Modal open={merging !== null} onClose={() => setMerging(null)} title={`Gộp ${merging?.name ?? ""}`} width="narrow">
        {merging ? (
          <MergeModelForm
            key={merging.id}
            source={merging}
            targets={(models ?? []).filter((m) => m.id !== merging.id && m.merged_into === null)}
            onCancel={() => setMerging(null)}
            onMerge={async (target) => {
              const ok = await ask({
                title: "Gộp Model",
                content: `Gộp ${merging.name} vào ${target.name}? Các bộ đang gắn ${merging.name} chuyển sang ${target.name}; giờ đã ghi trên bộ không đổi.`,
                confirmLabel: "Gộp",
                danger: true,
              });
              if (!ok) return;
              const moved = await mergeIntercomUnitModel(merging.id, target.id);
              setMerging(null);
              setNotice(`Đã gộp ${merging.name} vào ${target.name}, chuyển ${moved} bộ.`);
              await load();
            }}
          />
        ) : null}
      </Modal>
      {dialog}
    </div>
  );
}

function EditModelForm({
  model,
  onDirtyChange,
  onCancel,
  onSave,
}: {
  model: IntercomUnitModel;
  onDirtyChange: (dirty: boolean) => void;
  onCancel: () => void;
  onSave: (input: IntercomUnitModelInput) => Promise<void>;
}) {
  const [draft, setDraft] = useState<UnitModelDraft>(() => draftFromModel(model));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const read = readModelDraft(draft);
    if ("error" in read) return setError(read.error);
    setError(null);
    setBusy(true);
    try {
      await onSave(read.input);
    } catch (e) {
      setError(errorText(e, "Chưa lưu được Model."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <UnitModelFields
        draft={draft}
        onChange={(next) => {
          setDraft(next);
          onDirtyChange(true);
        }}
      />
      <p className="text-sm text-muted">Sửa giờ ở đây chỉ áp cho bộ thêm sau; bộ đang dùng giữ giờ đã ghi.</p>
      {error ? (
        <p className="text-base text-danger" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={SECONDARY_BUTTON}>
          Huỷ
        </button>
        <button type="submit" disabled={busy} className={PRIMARY_BUTTON}>
          {busy ? "Đang lưu..." : "Lưu"}
        </button>
      </div>
    </form>
  );
}

function MergeModelForm({
  source,
  targets,
  onCancel,
  onMerge,
}: {
  source: IntercomUnitModel;
  targets: IntercomUnitModel[];
  onCancel: () => void;
  onMerge: (target: IntercomUnitModel) => Promise<void>;
}) {
  const [targetId, setTargetId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = targets.find((t) => t.id === targetId) ?? null;

  const submit = async () => {
    if (!target) return setError("Chưa chọn Model đích.");
    setError(null);
    setBusy(true);
    try {
      await onMerge(target);
    } catch (e) {
      setError(errorText(e, "Chưa gộp được Model."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">Chọn Model đích. {source.name} giữ lại trong danh mục, mang chữ "Đã gộp".</p>
      <ul className="max-h-80 space-y-1 overflow-y-auto">
        {targets.map((t) => {
          const on = t.id === targetId;
          return (
            <li key={t.id}>
              <button
                type="button"
                aria-pressed={on}
                onClick={() => setTargetId(t.id)}
                className={cn(
                  "flex min-h-11 w-full items-center gap-3 rounded-control px-3 py-2 text-left text-base",
                  on ? "bg-brand-cta text-white" : "border border-border bg-surface text-fg active:bg-surface-2",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{t.name}</span>
                <span className={cn("text-sm", on ? "text-white" : "text-muted")}>{t.max_units} tai</span>
              </button>
            </li>
          );
        })}
      </ul>
      {error ? (
        <p className="text-base text-danger" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={SECONDARY_BUTTON}>
          Huỷ
        </button>
        <button type="button" disabled={busy || !target} onClick={() => void submit()} className={PRIMARY_BUTTON}>
          {busy ? "Đang gộp..." : "Gộp"}
        </button>
      </div>
    </div>
  );
}

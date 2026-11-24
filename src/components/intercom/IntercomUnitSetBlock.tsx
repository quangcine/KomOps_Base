"use client";

// Khối Bộ mã tai của màn chi tiết dự án: danh sách bộ kèm ghi chú tem, sửa bộ, thêm bộ (hoặc thêm số còn thiếu của
// bộ đã có), bỏ mã chưa từng giao. Máy chủ là cửa cuối: mã đã từng giao (có trong tai đã giao hoặc trong lượt nào)
// bị từ chối, báo lại tên mã. Mỗi bộ hiện Model, giờ; nút "Sửa".

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ChevronRight, Headphones, Plus } from "lucide-react";
import type { IntercomBoard, IntercomUnit, IntercomUnitSetInfo } from "@/lib/intercom/staffIntercom";
import {
  INTERCOM_TAG_NOTE_MAX,
  INTERCOM_UNIT_SET_MAX,
  addIntercomUnitSet,
  removeIntercomUnits,
  updateIntercomUnitSet,
  type IntercomUnitWithNote,
} from "@/lib/intercom/staffIntercomProject";
import {
  addIntercomUnitModelCustom,
  hasStaffRole,
  intercomHoursLabel,
  listIntercomUnitModels,
  type IntercomUnitModel,
} from "@/lib/intercom/staffIntercomUnitModel";
import { Modal } from "@/components/ui/Modal";
import { cn } from "@/lib/cn";
import { useConfirm } from "@/components/ui/useConfirm";
import { IntercomAccordionBlock } from "./IntercomAccordionBlock";
import type { IntercomFormState } from "./IntercomProjectForm";
import {
  EMPTY_MODEL_DRAFT,
  HOURS_ERROR,
  HoursField,
  IntercomUnitModelThumb,
  UnitModelFields,
  hoursText,
  modelUnitsCap,
  parseHours,
  readModelDraft,
  type UnitModelDraft,
} from "./IntercomUnitModelScreen";
import { compactCodes, unitsByPrefix } from "./intercomView";

const FIELD_CLASS = "mt-1 h-12 w-full rounded-control border border-border bg-surface px-3 text-base text-fg";
const SECONDARY_BUTTON =
  "h-11 rounded-control border border-border bg-surface px-3 text-base text-fg active:bg-surface-2 disabled:opacity-50";
const PRIMARY_BUTTON =
  "h-11 rounded-control bg-brand-cta px-4 text-base font-semibold text-white active:bg-brand-cta-hover disabled:opacity-50";

function errorText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

function fallbackSet(prefix: string): IntercomUnitSetInfo {
  return { prefix, model_id: null, model_name: null, is_hub: false, has_master: false };
}

function previewCodes(prefix: string, count: number, hasMaster: boolean): string {
  const regular = hasMaster ? count - 1 : count;
  const parts: string[] = [];
  if (hasMaster) parts.push(`${prefix}M`);
  if (regular === 1) parts.push(`${prefix}1`);
  if (regular > 1) parts.push(`${prefix}1 tới ${prefix}${regular}`);
  return parts.join(", ");
}

/** Trần số mã của một bộ đã có: theo Model đã gắn; bộ chưa có Model giữ trần cũ (máy chủ cùng luật). */
function existingSetCap(set: IntercomUnitSetInfo, models: readonly IntercomUnitModel[] | null): number {
  const model = set.model_id ? models?.find((m) => m.id === set.model_id) : undefined;
  if (model) return model.max_units;
  return set.has_master ? INTERCOM_UNIT_SET_MAX + 1 : INTERCOM_UNIT_SET_MAX;
}

export function IntercomUnitSetBlock({ board, onChanged }: { board: IntercomBoard; onChanged: () => Promise<void> }) {
  const { ask, dialog } = useConfirm();
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editPrefix, setEditPrefix] = useState<string | null>(null);
  const [removePrefix, setRemovePrefix] = useState<string | null>(null);
  const [models, setModels] = useState<IntercomUnitModel[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [seated, setSeated] = useState(false);
  /** Trạng thái form Thêm bộ, Sửa bộ (form báo lên): đóng popup khi còn chữ chưa lưu thì hỏi trước. */
  const [addState, setAddState] = useState<IntercomFormState>({ dirty: false, busy: false });
  const [editState, setEditState] = useState<IntercomFormState>({ dirty: false, busy: false });
  const reportAddState = useCallback((state: IntercomFormState) => setAddState(state), []);
  const reportEditState = useCallback((state: IntercomFormState) => setEditState(state), []);

  const loadModels = useCallback(async () => {
    try {
      setModels(await listIntercomUnitModels());
      setModelsError(null);
    } catch (e) {
      setModelsError(errorText(e, "Chưa tải được danh mục Model."));
    }
  }, []);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  useEffect(() => {
    let alive = true;
    hasStaffRole().then((value) => {
      if (alive) setSeated(value);
    });
    return () => {
      alive = false;
    };
  }, []);

  const closeAdd = () => {
    setAddState({ dirty: false, busy: false });
    setAdding(false);
  };
  const closeEdit = () => {
    setEditState({ dirty: false, busy: false });
    setEditPrefix(null);
  };
  /** Hỏi "Bỏ thay đổi?" khi form còn chữ chưa lưu; đang lưu thì không đóng. Trả `true` khi được đóng. */
  const mayClose = async (state: IntercomFormState) => {
    if (state.busy) return false;
    return !state.dirty || ask({ content: "Bỏ các thay đổi chưa lưu?", confirmLabel: "Bỏ thay đổi", danger: true });
  };
  const requestCloseAdd = async () => {
    if (await mayClose(addState)) closeAdd();
  };
  const requestCloseEdit = async () => {
    if (await mayClose(editState)) closeEdit();
  };

  const units = board.units as IntercomUnitWithNote[];
  const sections = unitsByPrefix(units);
  const usedUnitIds = new Set(board.issues.map((i) => i.unit_id));
  const noteOf = (prefix: string) => units.find((u) => u.prefix === prefix && u.tag_note)?.tag_note ?? null;
  const setOf = (prefix: string) => board.sets.find((s) => s.prefix === prefix) ?? fallbackSet(prefix);

  return (
    <IntercomAccordionBlock
      title="Mã tai"
      icon={Headphones}
      count={units.length}
      onAdd={() => {
        void loadModels();
        setAdding(true);
      }}
    >
      {sections.length === 0 ? <p className="text-base text-muted">Chưa có bộ mã nào.</p> : null}
      <ul className="divide-y divide-border">
        {sections.map((section) => {
          const note = noteOf(section.prefix);
          const set = setOf(section.prefix);
          const hours = intercomHoursLabel(set);
          const used = section.units.filter((u) => usedUnitIds.has(u.id)).length;
          return (
            <li key={section.prefix} className="flex flex-wrap items-center gap-2 py-2">
              <span className="min-w-0 flex-1">
                <span className="text-block font-semibold text-fg">Bộ {section.prefix}</span>
                <span className="ml-2 text-sm text-muted">{note ?? "chưa có ghi chú tem"}</span>
                <span className="block text-sm text-muted">
                  {set.model_name ?? "Chưa có Model"}
                  {hours ? ` · ${hours}` : ""}
                </span>
                <span className="block text-sm text-muted">
                  {section.units.length} mã ({compactCodes(section.units.map((u) => u.code))})
                  {used > 0 ? ` · ${used} mã đã từng giao` : ""}
                </span>
              </span>
              <button
                type="button"
                onClick={() => {
                  void loadModels();
                  setEditPrefix(section.prefix);
                }}
                className={SECONDARY_BUTTON}
              >
                Sửa
              </button>
              <button type="button" onClick={() => setRemovePrefix(section.prefix)} className={SECONDARY_BUTTON}>
                Bỏ mã
              </button>
            </li>
          );
        })}
      </ul>
      {notice ? <p className="text-base text-muted">{notice}</p> : null}
      {seated ? (
        <Link
          href="/intercom/models"
          className="flex min-h-11 items-center gap-2 rounded-control px-1 text-base text-fg active:bg-surface-2"
        >
          <span className="min-w-0 flex-1">Danh mục Model</span>
          <ChevronRight className="size-5 shrink-0 text-muted" aria-hidden />
        </Link>
      ) : null}

      <Modal open={adding} onClose={() => void requestCloseAdd()} title="Thêm bộ mã" width="narrow">
        {adding ? (
          <AddUnitSetForm
            projectId={board.project.id}
            sets={board.sets}
            models={models}
            modelsError={modelsError}
            onCancel={() => void requestCloseAdd()}
            onStateChange={reportAddState}
            onDone={async (message) => {
              closeAdd();
              setNotice(message);
              await Promise.all([onChanged(), loadModels()]);
            }}
          />
        ) : null}
      </Modal>

      <Modal
        open={editPrefix !== null}
        onClose={() => void requestCloseEdit()}
        title={`Sửa bộ ${editPrefix ?? ""}`}
        width="narrow"
      >
        {editPrefix ? (
          <EditUnitSetForm
            key={editPrefix}
            set={setOf(editPrefix)}
            unitCount={sections.find((s) => s.prefix === editPrefix)?.units.length ?? 0}
            initialNote={noteOf(editPrefix) ?? ""}
            models={models}
            modelsError={modelsError}
            onCancel={() => void requestCloseEdit()}
            onStateChange={reportEditState}
            onSave={async (input) => {
              await updateIntercomUnitSet({ projectId: board.project.id, prefix: editPrefix, ...input });
              closeEdit();
              setNotice(`Đã lưu bộ ${editPrefix}.`);
              await onChanged();
            }}
          />
        ) : null}
      </Modal>

      <Modal
        open={removePrefix !== null}
        onClose={() => setRemovePrefix(null)}
        title={`Bỏ mã bộ ${removePrefix ?? ""}`}
        width="medium"
      >
        {removePrefix ? (
          <RemoveUnitsForm
            key={removePrefix}
            units={sections.find((s) => s.prefix === removePrefix)?.units ?? []}
            usedUnitIds={usedUnitIds}
            onCancel={() => setRemovePrefix(null)}
            onRemove={async (ids, codes) => {
              const ok = await ask({
                title: "Bỏ mã tai",
                content: `Bỏ ${codes} khỏi dự án? Mã đã từng giao sẽ được giữ lại.`,
                confirmLabel: "Bỏ mã",
                danger: true,
              });
              if (!ok) return;
              const result = await removeIntercomUnits(ids);
              setRemovePrefix(null);
              const parts: string[] = [];
              if (result.removed.length > 0) parts.push(`Đã bỏ ${compactCodes(result.removed)}.`);
              if (result.rejected.length > 0) {
                parts.push(`Không bỏ được (đã từng giao): ${compactCodes(result.rejected)}.`);
              }
              setNotice(parts.join(" ") || "Không có mã nào được bỏ.");
              await onChanged();
            }}
          />
        ) : null}
      </Modal>
      {dialog}
    </IntercomAccordionBlock>
  );
}

/** Lưới thẻ Model 2 cột: ảnh to, tên, số tai, giờ; Model "Chưa duyệt" mang nhãn; Model đã gộp không hiện. */
function ModelGrid({
  models,
  selectedId,
  onSelect,
  customSelected,
  onSelectCustom,
}: {
  models: readonly IntercomUnitModel[];
  selectedId: string | null;
  onSelect: (model: IntercomUnitModel) => void;
  customSelected?: boolean;
  onSelectCustom?: () => void;
}) {
  const shown = models
    .filter((m) => m.merged_into === null)
    .sort((a, b) => (a.status === b.status ? 0 : a.status === "approved" ? -1 : 1));
  const cardClass = (on: boolean) =>
    cn(
      "flex flex-col gap-1 rounded-card p-2 text-left",
      on ? "border-2 border-brand-cta bg-surface-2" : "border border-border bg-surface active:bg-surface-2",
    );
  return (
    <div className="grid grid-cols-2 gap-2">
      {shown.map((m) => {
        const on = m.id === selectedId;
        return (
          <button key={m.id} type="button" aria-pressed={on} onClick={() => onSelect(m)} className={cardClass(on)}>
            <IntercomUnitModelThumb model={m} className="aspect-square w-full" />
            <span className="text-base font-semibold text-fg">{m.name}</span>
            <span className="text-sm text-muted">
              {m.max_units} tai · {intercomHoursLabel(m)}
            </span>
            {m.status === "pending" ? (
              <span className="self-start rounded-control bg-surface-2 px-1.5 py-0.5 text-sm text-muted">Chưa duyệt</span>
            ) : null}
          </button>
        );
      })}
      {onSelectCustom ? (
        <button type="button" aria-pressed={customSelected === true} onClick={onSelectCustom} className={cardClass(customSelected === true)}>
          <span className="flex aspect-square w-full items-center justify-center rounded-control border border-dashed border-border text-muted">
            <Plus className="size-1/3" aria-hidden />
          </span>
          <span className="text-base font-semibold text-fg">Custom</span>
          <span className="text-sm text-muted">Model chưa có trong danh mục</span>
        </button>
      ) : null}
    </div>
  );
}

/** Ô giờ của bộ (giờ tai thường, tai chủ Từ, Đến, giờ Hub), chữ chưa đọc. */
type SetHoursDraft = { unitHours: string; masterMin: string; masterMax: string; hubHours: string };

function hoursDraftFrom(source: {
  unit_hours?: number | null;
  master_hours_min?: number | null;
  master_hours_max?: number | null;
  hub_hours?: number | null;
}): SetHoursDraft {
  return {
    unitHours: hoursText(source.unit_hours),
    masterMin: hoursText(source.master_hours_min),
    masterMax: hoursText(source.master_hours_max),
    hubHours: hoursText(source.hub_hours),
  };
}

function SetHoursFields({
  draft,
  hasMaster,
  isHub,
  onChange,
}: {
  draft: SetHoursDraft;
  hasMaster: boolean;
  isHub: boolean;
  onChange: (draft: SetHoursDraft) => void;
}) {
  const set = (patch: Partial<SetHoursDraft>) => onChange({ ...draft, ...patch });
  return (
    <>
      <HoursField label="Giờ pin tai thường" value={draft.unitHours} onChange={(v) => set({ unitHours: v })} />
      {hasMaster ? (
        <div className="grid grid-cols-2 gap-2">
          <HoursField label="Tai chủ Từ (giờ)" value={draft.masterMin} onChange={(v) => set({ masterMin: v })} />
          <HoursField label="Tai chủ Đến (giờ)" value={draft.masterMax} onChange={(v) => set({ masterMax: v })} />
        </div>
      ) : null}
      {isHub ? (
        <HoursField label="Giờ pin Hub (không bắt buộc)" value={draft.hubHours} onChange={(v) => set({ hubHours: v })} />
      ) : null}
    </>
  );
}

type ReadHours = { unitHours: number | null; masterMin: number | null; masterMax: number | null; hubHours: number | null };

/**
 * Đọc ô giờ của bộ. `required`: giờ tai thường (và Từ, Đến khi có tai chủ) phải có. Ô trống không bắt buộc là
 * `null`.
 */
function readSetHours(draft: SetHoursDraft, hasMaster: boolean, isHub: boolean, required: boolean): ReadHours | string {
  const read = (text: string, label: string, must: boolean): number | null | string => {
    if (text.trim() === "") return must ? `${label}: ${HOURS_ERROR}` : null;
    return parseHours(text) ?? `${label}: ${HOURS_ERROR}`;
  };
  const unitHours = read(draft.unitHours, "Giờ tai thường", required);
  if (typeof unitHours === "string") return unitHours;
  let masterMin: number | null = null;
  let masterMax: number | null = null;
  if (hasMaster) {
    const min = read(draft.masterMin, "Tai chủ Từ", required);
    if (typeof min === "string") return min;
    const max = read(draft.masterMax, "Tai chủ Đến", required);
    if (typeof max === "string") return max;
    if (min !== null && max !== null && min > max) return "Giờ tai chủ: Từ không lớn hơn Đến.";
    masterMin = min;
    masterMax = max;
  }
  let hubHours: number | null = null;
  if (isHub) {
    const hub = read(draft.hubHours, "Giờ pin Hub", false);
    if (typeof hub === "string") return hub;
    hubHours = hub;
  }
  return { unitHours, masterMin, masterMax, hubHours };
}

type AddChoice = { kind: "model"; model: IntercomUnitModel } | { kind: "custom" } | null;

function AddUnitSetForm({
  projectId,
  sets,
  models,
  modelsError,
  onCancel,
  onStateChange,
  onDone,
}: {
  projectId: string;
  sets: readonly IntercomUnitSetInfo[];
  models: IntercomUnitModel[] | null;
  modelsError: string | null;
  onCancel: () => void;
  onStateChange: (state: IntercomFormState) => void;
  onDone: (message: string) => Promise<void>;
}) {
  const [prefixText, setPrefixText] = useState("");
  const [note, setNote] = useState("");
  const [choice, setChoice] = useState<AddChoice>(null);
  const [count, setCount] = useState("");
  const [hours, setHours] = useState<SetHoursDraft>(hoursDraftFrom({}));
  const [custom, setCustom] = useState<UnitModelDraft>(EMPTY_MODEL_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const prefix = prefixText.trim().toUpperCase();
  const prefixValid = /^[A-Z]{1,4}$/.test(prefix);
  const existing = prefixValid ? (sets.find((s) => s.prefix === prefix) ?? null) : null;

  useEffect(() => {
    onStateChange({ dirty: prefixText !== "" || note !== "" || choice !== null || count !== "", busy });
  }, [prefixText, note, choice, count, busy, onStateChange]);

  // Trần, cờ của bộ sẽ thêm: bộ đã có theo bộ đã lưu; Model theo `max_units`; Custom theo ô Số tai tối đa.
  const customHasMaster = custom.hasMaster && !custom.isHub;
  const target: { cap: number; hasMaster: boolean } | null = existing
    ? { cap: existingSetCap(existing, models), hasMaster: existing.has_master }
    : choice?.kind === "model"
      ? { cap: choice.model.max_units, hasMaster: choice.model.has_master }
      : choice?.kind === "custom"
        ? { cap: Number(custom.maxUnits) || modelUnitsCap(customHasMaster), hasMaster: customHasMaster }
        : null;
  // Custom: ô Số tai trống là lấy đủ số tai tối đa.
  const countValue = count.trim() === "" && choice?.kind === "custom" && !existing ? custom.maxUnits : count;
  const n = Number(countValue);
  const preview = prefixValid && target && Number.isInteger(n) && n >= 1 && n <= target.cap ? previewCodes(prefix, n, target.hasMaster) : "";

  const selectModel = (model: IntercomUnitModel) => {
    setChoice({ kind: "model", model });
    setCount(String(model.max_units));
    setHours(hoursDraftFrom(model));
    setError(null);
  };

  const submit = async () => {
    if (!prefixValid) return setError("Tên bộ chỉ gồm 1 tới 4 chữ cái A tới Z, không dấu.");
    if (!target) return setError("Chọn Model của bộ, hoặc Custom.");
    const customRead = choice?.kind === "custom" && !existing ? readModelDraft(custom) : null;
    if (customRead && "error" in customRead) return setError(customRead.error);
    if (!Number.isInteger(n) || n < 1 || n > target.cap) return setError(`Số tai từ 1 tới ${target.cap}.`);
    setError(null);
    setBusy(true);
    try {
      let created: IntercomUnit[];
      if (existing) {
        // Lối bổ sung mã lỡ xoá: máy chủ giữ Model, giờ của bộ.
        created = await addIntercomUnitSet({ projectId, prefix, count: n, tagNote: note });
      } else if (choice?.kind === "model") {
        const m = choice.model;
        const read = readSetHours(hours, m.has_master, m.is_hub, true);
        if (typeof read === "string") return setError(read);
        created = await addIntercomUnitSet({
          projectId,
          prefix,
          count: n,
          tagNote: note,
          model: {
            modelId: m.id,
            hasMaster: m.has_master,
            isHub: m.is_hub,
            unitHours: read.unitHours ?? m.unit_hours,
            masterMin: read.masterMin,
            masterMax: read.masterMax,
            hubHours: read.hubHours,
          },
        });
      } else {
        const read = customRead ?? readModelDraft(custom);
        if ("error" in read) return setError(read.error);
        const modelId = await addIntercomUnitModelCustom(projectId, read.input);
        created = await addIntercomUnitSet({
          projectId,
          prefix,
          count: n,
          tagNote: note,
          model: {
            modelId,
            hasMaster: read.input.hasMaster,
            isHub: read.input.isHub,
            unitHours: read.input.unitHours,
            masterMin: read.input.masterMin,
            masterMax: read.input.masterMax,
            hubHours: read.input.hubHours,
          },
        });
      }
      await onDone(
        created.length > 0
          ? `Đã thêm ${compactCodes(created.map((u) => u.code))}.`
          : `Bộ ${prefix} đã đủ ${n} mã, không thêm mã nào.`,
      );
    } catch (e) {
      setError(errorText(e, "Chưa thêm được bộ mã."));
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
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-base text-fg">
          Tên bộ
          <input
            value={prefixText}
            onChange={(e) => setPrefixText(e.target.value)}
            maxLength={4}
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            placeholder="Vd: Z"
            className={FIELD_CLASS}
          />
        </label>
        <label className="block text-base text-fg">
          Ghi chú tem
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={INTERCOM_TAG_NOTE_MAX}
            autoComplete="off"
            placeholder="Không bắt buộc"
            className={FIELD_CLASS}
          />
        </label>
      </div>

      {existing ? (
        <p className="text-sm text-muted">
          Bộ {prefix} đã có ({existing.model_name ?? "chưa có Model"}): chỉ thêm các số còn thiếu, Model và giờ của bộ giữ
          nguyên.
        </p>
      ) : (
        <div className="space-y-2">
          <p className="text-base text-fg">Model</p>
          {modelsError ? <p className="text-base text-danger">{modelsError}</p> : null}
          {!models && !modelsError ? <p className="text-base text-muted">Đang tải danh mục...</p> : null}
          {models ? (
            <ModelGrid
              models={models}
              selectedId={choice?.kind === "model" ? choice.model.id : null}
              onSelect={selectModel}
              customSelected={choice?.kind === "custom"}
              onSelectCustom={() => {
                setChoice({ kind: "custom" });
                setCount("");
                setError(null);
              }}
            />
          ) : null}
        </div>
      )}

      {choice?.kind === "custom" && !existing ? (
        <UnitModelFields draft={custom} onChange={setCustom} />
      ) : null}

      {target ? (
        <label className="block text-base text-fg">
          Số tai (tối đa {target.cap})
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={target.cap}
            value={count}
            onChange={(e) => setCount(e.target.value)}
            placeholder={choice?.kind === "custom" && !existing ? "Bằng số tai tối đa" : undefined}
            className={FIELD_CLASS}
          />
        </label>
      ) : null}

      {choice?.kind === "model" && !existing ? (
        <SetHoursFields draft={hours} hasMaster={choice.model.has_master} isHub={choice.model.is_hub} onChange={setHours} />
      ) : null}
      {choice?.kind === "model" && !existing && choice.model.has_master ? (
        <p className="text-sm text-muted">Giảm số tai thì sửa lại mức Từ của tai chủ cho khớp.</p>
      ) : null}

      {preview ? <p className="text-base text-fg">Mã sẽ có: {preview}</p> : null}
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
          {busy ? "Đang thêm..." : "Thêm"}
        </button>
      </div>
    </form>
  );
}

type EditSetInput = {
  tagNote: string;
  modelId: string | null;
  unitHours: number | null;
  masterMin: number | null;
  masterMax: number | null;
  hubHours: number | null;
};

/**
 * Hộp Sửa bộ: ghi chú tem, Model, giờ. Cờ tai chủ, Hub và số mã không đổi ở đây; máy chủ từ chối Model trần thấp
 * hơn số mã.
 */
function EditUnitSetForm({
  set,
  unitCount,
  initialNote,
  models,
  modelsError,
  onCancel,
  onStateChange,
  onSave,
}: {
  set: IntercomUnitSetInfo;
  unitCount: number;
  initialNote: string;
  models: IntercomUnitModel[] | null;
  modelsError: string | null;
  onCancel: () => void;
  onStateChange: (state: IntercomFormState) => void;
  onSave: (input: EditSetInput) => Promise<void>;
}) {
  const [note, setNote] = useState(initialNote);
  const [modelId, setModelId] = useState<string | null>(set.model_id);
  const [hours, setHours] = useState<SetHoursDraft>(() => hoursDraftFrom(set));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    onStateChange({ dirty, busy });
  }, [dirty, busy, onStateChange]);

  const pickModel = (model: IntercomUnitModel) => {
    setModelId(model.id);
    setDirty(true);
    setError(
      unitCount > model.max_units
        ? `Bộ đang có ${unitCount} mã, ${model.name} tối đa ${model.max_units} tai. Bỏ bớt mã hoặc chọn Model khác.`
        : null,
    );
    // Điền sẵn giờ theo Model mới; ô nào bộ không dùng (tai chủ, Hub) thì giữ.
    setHours((prev) => ({
      unitHours: hoursText(model.unit_hours),
      masterMin: set.has_master && model.master_hours_min !== null ? hoursText(model.master_hours_min) : prev.masterMin,
      masterMax: set.has_master && model.master_hours_max !== null ? hoursText(model.master_hours_max) : prev.masterMax,
      hubHours: set.is_hub && model.hub_hours !== null ? hoursText(model.hub_hours) : prev.hubHours,
    }));
  };

  const submit = async () => {
    const read = readSetHours(hours, set.has_master, set.is_hub, false);
    if (typeof read === "string") return setError(read);
    setError(null);
    setBusy(true);
    try {
      await onSave({ tagNote: note, modelId: modelId !== set.model_id ? modelId : null, ...read });
    } catch (e) {
      setError(errorText(e, "Chưa lưu được bộ mã."));
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
      <label className="block text-base text-fg">
        Ghi chú tem (để trống là bỏ ghi chú)
        <input
          value={note}
          onChange={(e) => {
            setNote(e.target.value);
            setDirty(true);
          }}
          maxLength={INTERCOM_TAG_NOTE_MAX}
          autoComplete="off"
          className={FIELD_CLASS}
        />
      </label>
      <div className="space-y-2">
        <p className="text-base text-fg">Model</p>
        {modelsError ? <p className="text-base text-danger">{modelsError}</p> : null}
        {!models && !modelsError ? <p className="text-base text-muted">Đang tải danh mục...</p> : null}
        {models ? <ModelGrid models={models} selectedId={modelId} onSelect={pickModel} /> : null}
      </div>
      <SetHoursFields
        draft={hours}
        hasMaster={set.has_master}
        isHub={set.is_hub}
        onChange={(next) => {
          setHours(next);
          setDirty(true);
        }}
      />
      <p className="text-sm text-muted">Giờ mới áp cho lượt giao sau; tai đang ở ngoài giữ giờ cũ.</p>
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

function RemoveUnitsForm({
  units,
  usedUnitIds,
  onCancel,
  onRemove,
}: {
  units: readonly IntercomUnit[];
  usedUnitIds: ReadonlySet<string>;
  onCancel: () => void;
  onRemove: (ids: string[], codes: string) => Promise<void>;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const picked = units.filter((u) => selected.has(u.id));

  const submit = async () => {
    if (picked.length === 0) return setError("Chưa chọn mã nào.");
    setBusy(true);
    setError(null);
    try {
      await onRemove(
        picked.map((u) => u.id),
        compactCodes(picked.map((u) => u.code)),
      );
    } catch (e) {
      setError(errorText(e, "Chưa bỏ được mã."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">Chỉ bỏ được mã chưa từng giao. Mã gạch dưới là mã đã từng giao.</p>
      <div className="grid grid-cols-5 gap-1.5 sm:grid-cols-6">
        {units.map((u) => {
          const used = usedUnitIds.has(u.id);
          const on = selected.has(u.id);
          return (
            <button
              key={u.id}
              type="button"
              aria-pressed={on}
              onClick={() =>
                setSelected((prev) => {
                  const next = new Set(prev);
                  if (next.has(u.id)) next.delete(u.id);
                  else next.add(u.id);
                  return next;
                })
              }
              className={cn(
                "h-11 rounded-control text-base font-semibold",
                used && "underline",
                on ? "bg-danger text-white" : "border border-border bg-surface text-fg active:bg-surface-2",
              )}
            >
              {u.code}
            </button>
          );
        })}
      </div>
      {error ? <p className="text-base text-danger">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={SECONDARY_BUTTON}>
          Huỷ
        </button>
        <button
          type="button"
          disabled={busy || picked.length === 0}
          onClick={() => void submit()}
          className="h-11 rounded-control bg-danger px-4 text-base font-semibold text-white active:opacity-80 disabled:opacity-50"
        >
          {busy ? "Đang bỏ..." : `Bỏ ${picked.length} mã`}
        </button>
      </div>
    </div>
  );
}

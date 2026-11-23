"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { copyMealSchema } from "@/lib/shared/meal-schemas";
import { MEAL_TYPES, type MealDetail, type MealSummary, type MealType } from "@/lib/shared/meal-types";
import { MealCalendar } from "./meal-calendar";
import { formatMealDate, getMealPeriod, isMealDate, MEAL_TYPE_LABELS, type MealView } from "./meal-dates";
import { MealDetails, MealRecord } from "./meal-detail";
import { appendCopiedDish, editMealDraft, newMealDraft, type MealDraft, type MealDraftPayload } from "./meal-draft";
import { MealEditor } from "./meal-editor";
import { MealSearchPanel } from "./meal-search-panel";
import { detailUrl, listUrl, MealApiError, mealRequest, mealWrite, readMealSlot, useMealResource, type MealWrite } from "./meal-client";

export interface MealSelection { date: string; view: MealView; meal: MealType }
export type MealNavigationBlock = "draft" | "saving" | null;

type EditorState = {
  key: number;
  draft: MealDraft;
  original?: MealDetail;
  copied?: { notice: string; confirmServings: boolean };
};
type CopyTarget = { source: MealDetail; dishId?: string; date: string; type: MealType };
type Slot = { date: string; type: MealType };
type Action = { write: MealWrite; label: string; target: Slot; original?: MealDetail };
type Conflict = { title: string; latest?: MealDetail | null; lookupFailed?: boolean; action: Action; byVersion: boolean };

function Modal({ title, testId, busy, children, onClose }: {
  title: string;
  testId: string;
  busy: boolean;
  children: ReactNode;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="meal-dialog" data-testid={testId} aria-label={title} onCancel={event => {
    event.preventDefault();
    if (!busy) onClose();
  }}>
    <h2>{title}</h2>
    {children}
  </dialog>;
}

export function MealApp({ workspaceId, selection, refresh, onSelection, onBlockChange }: {
  workspaceId: string;
  selection: MealSelection;
  refresh: number;
  onSelection: (selection: MealSelection) => void;
  onBlockChange: (block: MealNavigationBlock) => void;
}) {
  const api = `/api/workspaces/${encodeURIComponent(workspaceId)}`;
  const { date, view, meal } = selection;
  const [revision, setRevision] = useState(0);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [copy, setCopy] = useState<CopyTarget | null>(null);
  const [deletion, setDeletion] = useState<MealDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [retry, setRetry] = useState<Action | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const dirty = useRef(false);
  const editorKey = useRef(0);
  const pending = useRef<AbortController | null>(null);
  const update = refresh + revision;
  const { from, to } = getMealPeriod(date, view);
  const list = useMealResource<{ meals: MealSummary[] }>(listUrl(api, from, to), update);
  const meals = list.status === "loaded" ? list.data.meals : [];
  const selected = meals.find(item => item.mealDate === date && item.mealType === meal);
  const details = useMealResource<{ meal: MealDetail }>(selected ? detailUrl(api, selected.id) : null, update);
  const candidate = details.status === "loaded" ? details.data.meal : null;
  const detail = candidate?.mealDate === date && candidate.mealType === meal ? candidate : null;
  const detailStatus = candidate && !detail ? "error" : list.status === "loaded" ? selected ? details.status : "empty" : list.status;

  useEffect(() => () => pending.current?.abort(), []);

  function refreshMeals() { setRevision(previous => previous + 1); }

  function startEditor(draft: MealDraft, original?: MealDetail, copied?: EditorState["copied"]) {
    dirty.current = Boolean(copied);
    onBlockChange(copied ? "draft" : null);
    setEditor({ key: ++editorKey.current, draft, original, copied });
    setNotice("");
    setError("");
    setConflict(null);
  }

  function markDirty() {
    dirty.current = true;
    onBlockChange("draft");
  }

  function closeEditor() {
    if (pending.current) return;
    if (retry && !window.confirm("送信結果の確認を終了しますか？")) return;
    if (!retry && dirty.current && !window.confirm("保存していない入力を破棄しますか？")) return;
    if (retry || conflict) refreshMeals();
    dirty.current = false;
    onBlockChange(null);
    setEditor(null);
    setRetry(null);
    setConflict(null);
    setError("");
  }

  function choose(date: string, meal: MealType) {
    onSelection({ ...selection, date, meal });
  }

  async function latestFor(action: Action, byVersion: boolean, signal: AbortSignal) {
    if (byVersion && action.original) {
      try {
        return (await mealRequest<{ meal: MealDetail }>(detailUrl(api, action.original.id), signal)).meal;
      } catch (error) {
        if (!(error instanceof MealApiError && error.status === 404)) throw error;
      }
      return readMealSlot(api, action.original.mealDate, action.original.mealType, signal);
    }
    return readMealSlot(api, action.target.date, action.target.type, signal);
  }

  function startPending() {
    const request = new AbortController();
    pending.current = request;
    onBlockChange("saving");
    setBusy(true);
    return request;
  }

  function endPending(request: AbortController) {
    if (request.signal.aborted) return;
    pending.current = null;
    setBusy(false);
    onBlockChange(dirty.current ? "draft" : null);
  }

  async function save(action: Action) {
    if (pending.current) return;
    if (Date.now() - action.write.createdAt >= 24 * 60 * 60 * 1_000) {
      setRetry(null);
      setError("送信結果を再確認できる期間を過ぎました。最新の献立を確認してください。");
      refreshMeals();
      return;
    }
    const request = startPending();
    setError("");
    setNotice("");
    setRetry(null);
    setConflict(null);
    try {
      const result = await mealRequest<{ meal: MealDetail } | undefined>(action.write.url, request.signal, action.write);
      if (request.signal.aborted) return;
      let target = action.target;
      if (action.write.method !== "DELETE") {
        const saved = result?.meal;
        if (!saved || saved.workspaceId !== workspaceId || typeof saved.mealDate !== "string"
          || !isMealDate(saved.mealDate) || !MEAL_TYPES.includes(saved.mealType)) {
          throw new Error("保存された献立を確認できませんでした。");
        }
        target = { date: saved.mealDate, type: saved.mealType };
      }
      dirty.current = false;
      setEditor(null);
      setCopy(null);
      setDeletion(null);
      choose(target.date, target.type);
      refreshMeals();
      setNotice(action.label);
    } catch (cause) {
      if (request.signal.aborted) return;
      if (!(cause instanceof MealApiError) || cause.status >= 500) {
        dirty.current = true;
        setRetry(action);
        setError("保存結果を確認できませんでした。同じ内容で再試行できます。");
      } else if (cause.code === "VERSION_CONFLICT" || cause.code === "SLOT_OCCUPIED" || (cause.status === 404 && action.original)) {
        const byVersion = cause.code !== "SLOT_OCCUPIED";
        const title = cause.status === 404 ? "元の献立を取得できませんでした。現在の食事枠を確認してください。" : cause.message;
        const next = { title, action, byVersion };
        try {
          const latest = await latestFor(action, byVersion, request.signal);
          if (!request.signal.aborted) setConflict({ ...next, latest });
        } catch {
          if (!request.signal.aborted) setConflict({ ...next, lookupFailed: true });
        }
      } else {
        setError(cause.message);
      }
    } finally {
      endPending(request);
    }
  }

  async function retryConflict(value: Conflict) {
    if (pending.current) return;
    const request = startPending();
    try {
      const latest = await latestFor(value.action, value.byVersion, request.signal);
      if (!request.signal.aborted) setConflict({ ...value, latest, lookupFailed: false });
    } catch {
      if (!request.signal.aborted) setConflict({ ...value, lookupFailed: true });
    } finally {
      endPending(request);
    }
  }

  function submitEditor(payload: MealDraftPayload) {
    if (!editor || retry || conflict?.byVersion) return;
    const original = editor.original;
    const write = original
      ? mealWrite(detailUrl(api, original.id), "PUT", { ...payload, expectedVersion: original.version })
      : mealWrite(`${api}/meals`, "POST", payload);
    void save({ write, label: "献立を保存しました。", target: { date: payload.mealDate, type: payload.mealType }, original });
  }

  function closeDialog() {
    if (pending.current) return;
    if (retry && !window.confirm("送信結果の確認を終了しますか？")) return;
    if (!retry && dirty.current && !window.confirm("保存していない入力を破棄しますか？")) return;
    dirty.current = false;
    onBlockChange(null);
    setCopy(null);
    setDeletion(null);
    setRetry(null);
    setConflict(null);
    setError("");
    if (retry || conflict) refreshMeals();
  }

  function changeCopyTarget(next: CopyTarget) {
    markDirty();
    setCopy(next);
  }

  async function continueCopy(event: FormEvent) {
    event.preventDefault();
    if (!copy || pending.current || retry || conflict?.byVersion) return;
    const { source, dishId, date, type } = copy;
    setError("");
    setConflict(null);
    const payload = copyMealSchema.safeParse({ sourceVersion: source.version, targetDate: date, targetMealType: type });
    if (!payload.success) {
      setError("コピー先の日付と食事区分を確認してください。");
      return;
    }
    if (date === source.mealDate && type === source.mealType) {
      setError("コピー元と異なる食事枠を選んでください。");
      return;
    }
    if (!dishId) {
      await save({ write: mealWrite(`${detailUrl(api, source.id)}/copies`, "POST", payload.data), label: "献立をコピーしました。", target: { date, type }, original: source });
      return;
    }
    const request = startPending();
    try {
      const target = await readMealSlot(api, date, type, request.signal);
      if (request.signal.aborted) return;
      const base = target ? editMealDraft(target) : newMealDraft(date, type);
      const { draft, confirmCopyServings } = appendCopiedDish(base, source, dishId);
      const name = source.dishes.find(dish => dish.id === dishId)?.name;
      startEditor(draft, target ?? undefined, {
        notice: `${formatMealDate(source.mealDate)}の${MEAL_TYPE_LABELS[source.mealType]}から「${name}」を追加しました。`,
        confirmServings: confirmCopyServings,
      });
      setCopy(null);
    } catch (cause) {
      if (!request.signal.aborted) setError(cause instanceof Error ? cause.message : "コピー先を取得できませんでした。");
    } finally {
      endPending(request);
    }
  }

  function deleteMeal() {
    if (!deletion || retry || conflict) return;
    void save({ write: mealWrite(detailUrl(api, deletion.id), "DELETE", { expectedVersion: deletion.version }), label: "献立を削除しました。", target: { date: deletion.mealDate, type: deletion.mealType }, original: deletion });
  }

  const feedback = <>
    {error && <p role="alert" className="meal-feedback meal-feedback-error">{error}</p>}
    {retry && <button className="meal-button meal-button-secondary" type="button" data-testid="meal-retry-save" disabled={busy} onClick={() => void save(retry)}>同じ内容で再試行</button>}
    {conflict && <section className="meal-conflict" data-testid="meal-conflict" aria-label="更新の競合">
      <p role="alert">{conflict.title}</p>
      {conflict.lookupFailed && <button className="meal-button meal-button-secondary" type="button" disabled={busy} onClick={() => void retryConflict(conflict)}>最新版を再取得</button>}
      {conflict.latest && <>
        <h3>現在の献立</h3>
        <p>{formatMealDate(conflict.latest.mealDate)}・{MEAL_TYPE_LABELS[conflict.latest.mealType]}</p>
        <MealRecord detail={conflict.latest} />
      </>}
      {conflict.latest === null && <p>現在、この食事枠に記録はありません。</p>}
      {editor && conflict.byVersion && conflict.latest && <button className="meal-button meal-button-secondary" type="button" disabled={busy} onClick={() => {
        if (conflict.latest && window.confirm("保存していない入力を破棄し、最新版を開きますか？")) startEditor(editMealDraft(conflict.latest), conflict.latest);
      }}>最新版から編集し直す</button>}
    </section>}
  </>;

  return <section className="meal-app" data-testid="meal-app" aria-label="献立">
    <header className="meal-app-header">
      <h2>{editor ? editor.original ? "献立を編集" : "献立を登録" : "献立"}</h2>
      {!editor && <button type="button" data-testid="meal-register" className="meal-button meal-button-primary" onClick={() => startEditor(newMealDraft(date, meal))}>＋ 登録</button>}
    </header>
    {notice && <p role="status" className="meal-feedback">{notice}</p>}
    {editor ? <>
      {feedback}
      <MealEditor key={editor.key} initial={editor.draft} busy={busy} lockSlot={Boolean(editor.copied && editor.original)}
        saveDisabled={Boolean(retry || conflict?.byVersion)} fieldsDisabled={Boolean(retry)} onDirty={markDirty} onSave={submitEditor} onCancel={closeEditor}
        copyNotice={editor.copied?.notice} confirmCopyServings={editor.copied?.confirmServings} />
    </> : <div className="meal-main-grid">
        <MealCalendar date={date} view={view} meal={meal} meals={meals} status={list.status} onDate={value => choose(value, meal)}
          onView={value => onSelection({ ...selection, view: value })} onSelect={choose} onRetry={refreshMeals} />
        <MealDetails date={date} meal={meal} detail={detail} status={detailStatus} onRetry={refreshMeals}
          onAdd={() => startEditor(newMealDraft(date, meal))} onEdit={() => { if (detail) startEditor(editMealDraft(detail), detail); }}
          onDelete={() => { if (detail) setDeletion(detail); }} onCopy={dishId => { if (detail) setCopy({ source: detail, dishId, date, type: meal }); }} />
    </div>}
    <div hidden={Boolean(editor)}>
      <MealSearchPanel api={api} revision={update} onSelect={item => choose(item.mealDate, item.mealType)} />
    </div>
    {copy && <Modal testId="meal-copy-dialog" title={copy.dishId ? "料理をコピー" : "献立をコピー"} busy={busy} onClose={closeDialog}>
      <form onSubmit={event => void continueCopy(event)}>
        <label className="meal-field">コピー先の日付<input type="date" data-testid="meal-copy-date" required value={copy.date} disabled={busy || Boolean(retry)} onChange={event => changeCopyTarget({ ...copy, date: event.target.value })} /></label>
        <label className="meal-field">コピー先の食事<select data-testid="meal-copy-type" value={copy.type} disabled={busy || Boolean(retry)} onChange={event => changeCopyTarget({ ...copy, type: event.target.value as MealType })}>
          {MEAL_TYPES.map(type => <option key={type} value={type}>{MEAL_TYPE_LABELS[type]}</option>)}
        </select></label>
        {!copy.dishId && <details>
          <summary>コピー元の人数・分量</summary>
          <MealRecord detail={copy.source} />
        </details>}
        {feedback}
        <div className="meal-dialog-actions">
          <button type="button" className="meal-button meal-button-secondary" disabled={busy} onClick={closeDialog}>キャンセル</button>
          <button data-testid="meal-copy-continue" className="meal-button meal-button-primary" disabled={busy || Boolean(retry || conflict?.byVersion)}>{copy.dishId ? "内容を確認" : "コピーする"}</button>
        </div>
      </form>
    </Modal>}
    {deletion && <Modal testId="meal-delete-dialog" title="献立を削除" busy={busy} onClose={closeDialog}>
      <p>{formatMealDate(deletion.mealDate)}の{MEAL_TYPE_LABELS[deletion.mealType]}を削除します。</p>
      {feedback}
      <div className="meal-dialog-actions">
        <button type="button" className="meal-button meal-button-secondary" disabled={busy} onClick={closeDialog}>キャンセル</button>
        <button type="button" data-testid="meal-delete-confirm" className="meal-button meal-button-danger" disabled={busy || Boolean(retry || conflict)} onClick={deleteMeal}>削除する</button>
      </div>
    </Modal>}
  </section>;
}

"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { MEAL_TYPES, type MealDetail, type MealType } from "@/lib/shared/meal-types";
import { reviseSuggestionSchema, suggestionConditionsSchema } from "@/lib/shared/suggestion-schemas";
import { suggestionModeHeader, type Suggestion, type SuggestionCandidate } from "@/lib/shared/suggestion-types";
import type { MealNavigationBlock, MealSelection } from "./meal-app";
import { MealApiError, mealRequest, mealWrite, mealWriteExpired, readMealSlot, type MealWrite } from "./meal-client";
import { formatMealDate, MEAL_TYPE_LABELS } from "./meal-dates";
import { MealDialog } from "./meal-dialog";

type ConditionsDraft = {
  mealDate: string;
  mealType: MealType;
  servings: string;
  ingredients: string;
  maxMinutes: string;
  cuisine: string;
  request: string;
};
type GenerationKind = "create" | "revise";
type ProposalWrite = { kind: GenerationKind; write: MealWrite };
type AdoptionWrite = { kind: "adopt"; write: MealWrite; slot: Pick<MealDetail, "mealDate" | "mealType">; replaceMealId?: string };
type Send = ProposalWrite | AdoptionWrite;
type Replacement = { proposal: Suggestion; candidate: SuggestionCandidate; previous: MealDetail; trigger: HTMLButtonElement };

const fieldLabels: Record<keyof ConditionsDraft, string> = {
  mealDate: "日付", mealType: "食事区分", servings: "人数", ingredients: "使いたい食材",
  maxMinutes: "調理時間", cuisine: "料理の系統", request: "自由な要望",
};

function ConditionsForm({ draft, disabled, onChange, onSubmit }: {
  draft: ConditionsDraft;
  disabled: boolean;
  onChange: (draft: ConditionsDraft) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return <form className="suggestion-form" onSubmit={onSubmit} aria-label="献立の提案条件" noValidate>
    <fieldset className="suggestion-fields" disabled={disabled}>
      <label className="meal-field">{fieldLabels.mealDate}
        <input type="date" min="0001-01-01" max="9999-12-31" required data-testid="suggestion-date" value={draft.mealDate}
          onChange={event => onChange({ ...draft, mealDate: event.target.value })} />
      </label>
      <label className="meal-field">{fieldLabels.mealType}
        <select data-testid="suggestion-type" value={draft.mealType} onChange={event => onChange({ ...draft, mealType: event.target.value as MealType })}>
          {MEAL_TYPES.map(type => <option key={type} value={type}>{MEAL_TYPE_LABELS[type]}</option>)}
        </select>
      </label>
      <label className="meal-field">{fieldLabels.servings}
        <input type="number" min="0.01" max="99" step="0.01" placeholder="任意" data-testid="suggestion-servings" value={draft.servings}
          onChange={event => onChange({ ...draft, servings: event.target.value })} />
      </label>
      <label className="meal-field">{fieldLabels.maxMinutes}（分以内）
        <input type="number" min="1" max="240" step="1" placeholder="任意" data-testid="suggestion-minutes" value={draft.maxMinutes}
          onChange={event => onChange({ ...draft, maxMinutes: event.target.value })} />
      </label>
      <label className="meal-field">{fieldLabels.ingredients}
        <input type="text" placeholder="例　鮭、きのこ" data-testid="suggestion-ingredients" value={draft.ingredients}
          onChange={event => onChange({ ...draft, ingredients: event.target.value })} />
      </label>
      <label className="meal-field">{fieldLabels.cuisine}
        <input type="text" placeholder="例　和食" data-testid="suggestion-cuisine" value={draft.cuisine}
          onChange={event => onChange({ ...draft, cuisine: event.target.value })} />
      </label>
      <label className="meal-field suggestion-wide-field">{fieldLabels.request}
        <textarea rows={2} placeholder="例　後片付けを簡単にしたい" data-testid="suggestion-request" value={draft.request}
          onChange={event => onChange({ ...draft, request: event.target.value })} />
      </label>
    </fieldset>
    <button type="submit" className="meal-button meal-button-primary" data-testid="suggestion-generate" disabled={disabled}>献立を提案する</button>
  </form>;
}

function ConditionsSummary({ conditions }: { conditions: Suggestion["conditions"] }) {
  return <dl className="suggestion-conditions" data-testid="suggestion-conditions">
    <div><dt>食事枠</dt><dd>{formatMealDate(conditions.mealDate)}・{MEAL_TYPE_LABELS[conditions.mealType]}</dd></div>
    {conditions.servings !== null && <div><dt>{fieldLabels.servings}</dt><dd>{conditions.servings}人分</dd></div>}
    {conditions.ingredients.length > 0 && <div><dt>{fieldLabels.ingredients}</dt><dd>{conditions.ingredients.join("、")}</dd></div>}
    {conditions.maxMinutes !== null && <div><dt>{fieldLabels.maxMinutes}</dt><dd>{conditions.maxMinutes}分以内</dd></div>}
    {conditions.cuisine && <div><dt>{fieldLabels.cuisine}</dt><dd>{conditions.cuisine}</dd></div>}
    {conditions.request && <div><dt>{fieldLabels.request}</dt><dd>{conditions.request}</dd></div>}
  </dl>;
}

function CandidateCard({ candidate, disabled, onAdopt }: {
  candidate: SuggestionCandidate;
  disabled: boolean;
  onAdopt: (trigger: HTMLButtonElement) => void;
}) {
  return <article className="suggestion-card" data-testid="suggestion-candidate">
    <h4>{candidate.title}</h4>
    {candidate.estimatedMinutes !== null && <p className="suggestion-time">調理の目安 {candidate.estimatedMinutes}分</p>}
    <ul className="suggestion-dishes">{candidate.dishes.map((dish, index) => <li key={`${index}-${dish.name}`}>{dish.name}</li>)}</ul>
    {candidate.reasons.length > 0 && <ul className="suggestion-reasons">{candidate.reasons.map((reason, index) => <li key={`${index}-${reason}`}>{reason}</li>)}</ul>}
    {candidate.dishes.some(dish => dish.ingredients.length || dish.recipeText) && <details>
      <summary>食材・作り方</summary>
      <div className="suggestion-candidate-recipes">{candidate.dishes.map((dish, index) => <div key={`${index}-${dish.name}`}>
        <strong>{dish.name}</strong>
        {dish.ingredients.length > 0 && <ul className="suggestion-dishes">{dish.ingredients.map((ingredient, ingredientIndex) =>
          <li key={`${ingredientIndex}-${ingredient.name}`}>{ingredient.name}{ingredient.amountText && ` ${ingredient.amountText}`}{ingredient.unit && ` ${ingredient.unit}`}</li>)}</ul>}
        {dish.recipeText && <p className="meal-recipe-text">{dish.recipeText}</p>}
      </div>)}</div>
    </details>}
    <button type="button" className="meal-button meal-button-primary" data-testid="suggestion-adopt" disabled={disabled}
      onClick={event => onAdopt(event.currentTarget)}>この献立を予定にする</button>
  </article>;
}

function failureMessage(request: Suggestion["request"]) {
  if (request.status === "EXPIRED" || request.failure === "TIMEOUT") return "提案の作成が時間内に終わりませんでした。もう一度お試しください。";
  if (request.failure === "INVALID_OUTPUT") return "候補の内容を確認できませんでした。もう一度お試しください。";
  return "提案を作成できませんでした。もう一度お試しください。";
}

export function SuggestionPanel({ workspaceId, selection, sample, onAdopt, onBlockChange }: {
  workspaceId: string;
  selection: MealSelection;
  sample: boolean;
  onAdopt: (meal: MealDetail) => void;
  onBlockChange: (block: MealNavigationBlock) => void;
}) {
  const api = `/api/workspaces/${encodeURIComponent(workspaceId)}`;
  const [draft, setDraft] = useState<ConditionsDraft>(() => ({
    mealDate: selection.date, mealType: selection.meal, servings: "", ingredients: "", maxMinutes: "", cuisine: "", request: "",
  }));
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [waiting, setWaiting] = useState<ProposalWrite | null>(null);
  const [retry, setRetry] = useState<Send | null>(null);
  const [replacement, setReplacement] = useState<Replacement | null>(null);
  const [refreshable, setRefreshable] = useState(false);
  const [busy, setBusy] = useState(false);
  const feedback = useRef<HTMLParagraphElement>(null);
  const restoreFocus = useRef<HTMLButtonElement | null>(null);
  const pending = useRef<AbortController | null>(null);
  const dirty = useRef({ conditions: false, message: false });
  const uncertainWrite = useRef(false);
  const locked = busy || Boolean(retry || waiting || replacement);

  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => { if (error) feedback.current?.focus(); }, [error]);
  useEffect(() => {
    if (replacement || busy) return;
    restoreFocus.current?.focus();
    restoreFocus.current = null;
  }, [replacement, busy]);

  function syncNavigationBlock() {
    onBlockChange(pending.current ? "saving" : dirty.current.conditions || dirty.current.message || uncertainWrite.current ? "draft" : null);
  }

  function suggestionUrl(suggestionId?: string) {
    return `${api}/suggestions${suggestionId === undefined ? "" : `/${encodeURIComponent(suggestionId)}`}`;
  }

  async function run(operation: (signal: AbortSignal) => Promise<void>) {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    syncNavigationBlock();
    setBusy(true);
    setError("");
    try {
      await operation(controller.signal);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof MealApiError ? cause.message : "結果を取得できませんでした。もう一度お試しください。");
    } finally {
      if (!controller.signal.aborted) {
        pending.current = null;
        setBusy(false);
        syncNavigationBlock();
      }
    }
  }

  function receive(next: Suggestion, action?: ProposalWrite) {
    if (!next?.id || !next.request || !Array.isArray(next.candidates)) throw new Error("Invalid suggestion response");
    setRefreshable(false);
    if (next.request.status === "RUNNING") {
      if (action) setWaiting(action);
      else {
        setRefreshable(true);
        setError("候補を更新中です。完了後に候補を再取得してください。");
      }
      return;
    }
    setWaiting(null);
    if (next.candidates.length > 0) {
      setSuggestion(previous => previous?.id === next.id && previous.version > next.version ? previous : next);
    }
    if (next.request.status !== "SUCCEEDED") {
      setError(failureMessage(next.request));
      return;
    }
    if (action?.kind === "create") dirty.current.conditions = false;
    if (action) {
      dirty.current.message = false;
      setMessage("");
    }
  }

  async function send(action: Send, signal: AbortSignal) {
    if (mealWriteExpired(action.write)) {
      uncertainWrite.current = false;
      setWaiting(null);
      setRetry(null);
      setError("送信結果を再確認できる期間を過ぎました。最新の提案と献立を確認してください。");
      return;
    }
    try {
      if (action.kind === "adopt") {
        const { meal } = await mealRequest<{ meal: MealDetail }>(action.write.url, signal, action.write);
        if (signal.aborted) return;
        if (meal?.status !== "PLANNED" || !meal.id || meal.workspaceId !== workspaceId
          || meal.mealDate !== action.slot.mealDate || meal.mealType !== action.slot.mealType
          || (action.replaceMealId && meal.id !== action.replaceMealId)) throw new Error("Invalid adoption response");
        setRetry(null);
        uncertainWrite.current = false;
        dirty.current = { conditions: false, message: false };
        onAdopt(meal);
        return;
      }
      const { suggestion: next } = await mealRequest<{ suggestion: Suggestion }>(action.write.url, signal, action.write, {
        [suggestionModeHeader]: sample ? "sample" : "gateway",
      });
      if (signal.aborted) return;
      receive(next, action);
      setRetry(null);
      uncertainWrite.current = false;
    } catch (cause) {
      if (signal.aborted) return;
      setWaiting(null);
      if (!(cause instanceof MealApiError) || cause.status >= 500) {
        setRetry(action);
        uncertainWrite.current = true;
        setError("送信結果を確認できませんでした。同じ内容で再試行できます。");
        return;
      }
      setRetry(null);
      uncertainWrite.current = false;
      if (cause.code === "VERSION_CONFLICT" && action.kind !== "create") setRefreshable(true);
      setError(cause.message);
    }
  }

  function startGeneration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked) return;
    const result = suggestionConditionsSchema.safeParse({
      ...draft,
      ingredients: draft.ingredients.split(/[,、，\r\n]+/u).map(value => value.trim()).filter(Boolean),
      servings: draft.servings ? Number(draft.servings) : null,
      maxMinutes: draft.maxMinutes ? Number(draft.maxMinutes) : null,
    });
    if (!result.success) {
      const field = result.error.issues[0]?.path[0] as keyof ConditionsDraft;
      setError(fieldLabels[field] ? `${fieldLabels[field]}の入力を確認してください。` : "提案条件を確認してください。");
      return;
    }
    dirty.current.conditions = true;
    const write = mealWrite(suggestionUrl(), "POST", result.data, [201, 202]);
    void run(signal => send({ kind: "create", write }, signal));
  }

  function revise(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!suggestion || locked) return;
    const input = reviseSuggestionSchema.safeParse({ expectedVersion: suggestion.version, message });
    if (!input.success) {
      setError("追加の要望を確認してください。");
      return;
    }
    const write = mealWrite(`${suggestionUrl(suggestion.id)}/messages`, "POST", input.data, [200, 202]);
    void run(signal => send({ kind: "revise", write }, signal));
  }

  async function adopt(proposal: Suggestion, candidate: SuggestionCandidate, signal: AbortSignal, previous?: MealDetail) {
    const { mealDate, mealType } = proposal.conditions;
    const payload = { expectedVersion: proposal.version, candidateId: candidate.id };
    const replacementPayload = previous && { replaceMealId: previous.id, replaceVersion: previous.version, confirmReplacement: true };
    const write = mealWrite(`${suggestionUrl(proposal.id)}/adoptions`, "POST", { ...payload, ...replacementPayload }, [200]);
    await send({ kind: "adopt", write, slot: { mealDate, mealType }, replaceMealId: previous?.id }, signal);
  }

  function selectCandidate(proposal: Suggestion, candidate: SuggestionCandidate, trigger: HTMLButtonElement) {
    if (locked) return;
    void run(async signal => {
      const previous = await readMealSlot(api, proposal.conditions.mealDate, proposal.conditions.mealType, signal);
      if (signal.aborted) return;
      if (previous?.status === "RECORDED") {
        setError("この食事枠は記録済みです。別の日付か食事区分を選んでください。");
      } else if (previous?.status === "PLANNED") {
        setReplacement({ proposal, candidate, previous, trigger });
      } else {
        await adopt(proposal, candidate, signal);
      }
    });
  }

  function refreshSuggestion(id: string) {
    void run(async signal => {
      const { suggestion: next } = await mealRequest<{ suggestion: Suggestion }>(suggestionUrl(id), signal);
      if (!signal.aborted) receive(next);
    });
  }

  function cancelReplacement() {
    restoreFocus.current = replacement?.trigger ?? null;
    setReplacement(null);
  }

  return <section className="meal-app" data-testid="suggestion-panel" aria-label="献立の提案">
    <header className="meal-app-header"><h2>献立の提案</h2></header>
    <p className="meal-hint suggestion-sample-notice">{sample ? "テスト用の献立提案です。" : "この画面ではAIが献立案を生成します。採用前に内容を確認してください。"}</p>
    <ConditionsForm draft={draft} disabled={locked} onChange={next => {
      dirty.current.conditions = true;
      setDraft(next);
      syncNavigationBlock();
    }} onSubmit={startGeneration} />
    {busy && <p className="meal-feedback" role="status">処理中です…</p>}
    {error && <p ref={feedback} className="meal-feedback meal-feedback-error" role="alert" tabIndex={-1}>{error}</p>}
    {retry && <div className="meal-detail-actions">
      <button type="button" className="meal-button meal-button-secondary" disabled={busy} data-testid="suggestion-retry"
        onClick={() => void run(signal => send(retry, signal))}>同じ内容で再試行</button>
      <button type="button" className="meal-button meal-button-secondary" disabled={busy} onClick={() => {
        if (!window.confirm("送信結果の確認を終了しますか？")) return;
        uncertainWrite.current = false;
        setRetry(null);
        setError("");
        syncNavigationBlock();
      }}>確認を終了</button>
    </div>}
    {waiting && <div className="meal-feedback suggestion-waiting">
      <p role="status">提案を作成しています。</p>
      <button type="button" className="meal-button meal-button-secondary" disabled={busy} data-testid="suggestion-check-generation"
        onClick={() => void run(signal => send(waiting, signal))}>提案結果を確認</button>
    </div>}
    {suggestion && <section className="suggestion-results" aria-label="献立の候補">
      <h3>現在の提案条件</h3>
      <ConditionsSummary conditions={suggestion.conditions} />
      {suggestion.messages.length > 0 && <div>
        <h4>反映済みの追加要望</h4>
        <ol className="suggestion-messages" data-testid="suggestion-messages">
          {suggestion.messages.map((value, index) => <li key={`${index}-${value}`}>{value}</li>)}
        </ol>
      </div>}
      <div className="suggestion-candidates" aria-label="提案候補">
        {suggestion.candidates.map(candidate => <CandidateCard key={candidate.id} candidate={candidate}
          disabled={locked || refreshable} onAdopt={trigger => selectCandidate(suggestion, candidate, trigger)} />)}
      </div>
      {refreshable && <button type="button" className="meal-button meal-button-secondary" disabled={locked}
        onClick={() => refreshSuggestion(suggestion.id)}>候補を再取得</button>}
      <form className="suggestion-revise" onSubmit={revise}>
        <label className="meal-field">追加の要望
          <textarea data-testid="suggestion-message" value={message} rows={2} placeholder="例　副菜は火を使わずに作りたい" disabled={locked}
            onChange={event => {
              dirty.current.message = Boolean(event.target.value.trim());
              setMessage(event.target.value);
              syncNavigationBlock();
            }} />
        </label>
        <button type="submit" className="meal-button meal-button-secondary" data-testid="suggestion-revise" disabled={locked || refreshable}>要望を反映する</button>
      </form>
    </section>}
    {replacement && <MealDialog testId="suggestion-replace" title="予定を置き換えますか？" busy={busy} onClose={cancelReplacement}>
      <p>{formatMealDate(replacement.previous.mealDate)}・{MEAL_TYPE_LABELS[replacement.previous.mealType]}</p>
      <dl className="suggestion-conditions">
        <div><dt>現在の予定</dt><dd>{replacement.previous.dishes.map(dish => dish.name).join("、")}</dd></div>
        <div><dt>新しい献立</dt><dd>{replacement.candidate.dishes.map(dish => dish.name).join("、")}</dd></div>
      </dl>
      <div className="meal-detail-actions">
        <button type="button" className="meal-button meal-button-secondary" onClick={cancelReplacement}>キャンセル</button>
        <button type="button" className="meal-button meal-button-primary" data-testid="suggestion-replace-confirm" onClick={() => {
          setReplacement(null);
          void run(signal => adopt(replacement.proposal, replacement.candidate, signal, replacement.previous));
        }}>予定を置き換える</button>
      </div>
    </MealDialog>}
  </section>;
}

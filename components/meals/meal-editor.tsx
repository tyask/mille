"use client";

import { useState, type FormEvent } from "react";
import { MEAL_TYPES, type MealType } from "@/lib/shared/meal-types";
import { MEAL_TYPE_LABELS } from "./meal-dates";
import {
  newDishDraft, newIngredientDraft, validateMealDraft, withReviewedMealPhoto,
  type DishDraft, type MealDraft, type MealDraftPayload, type ReviewedMealPhoto,
} from "./meal-draft";
import { MealPhotoEditor } from "./meal-photo-editor";

type MealEditorProps = {
  api: string;
  photoAnalysisEnabled: boolean;
  initial: MealDraft;
  busy: boolean;
  saveDisabled?: boolean;
  fieldsDisabled?: boolean;
  onDirty: () => void;
  onSave: (payload: MealDraftPayload) => void;
  onCancel: () => void;
  copyNotice?: string;
  confirmCopyServings?: boolean;
  lockSlot?: boolean;
  saveLabel?: string;
};

type DishEditorProps = {
  api: string;
  photoAnalysisEnabled: boolean;
  dish: DishDraft;
  index: number;
  invalid?: string;
  onChange: (dish: DishDraft) => void;
  onRemove?: () => void;
  onPhotoChange: (photoId: string | null) => void;
  onUploadActivity: (active: boolean) => void;
};

function DishEditor({ api, photoAnalysisEnabled, dish, index, invalid, onChange, onRemove, onPhotoChange, onUploadActivity }: DishEditorProps) {
  const path = `dishes.${index}`;

  function applyPhotoReview(review: ReviewedMealPhoto) {
    const next = withReviewedMealPhoto(dish, review);
    if (next.ingredients.length > 100) return false;
    onChange(next);
    return true;
  }

  function setIngredient(key: string, values: Partial<Pick<DishDraft["ingredients"][number], "name" | "amountText" | "unit">>) {
    onChange({
      ...dish,
      ingredients: dish.ingredients.map(ingredient => ingredient.key === key ? { ...ingredient, ...values } : ingredient),
    });
  }

  return (
    <section className="meal-dish-editor" aria-label={`料理 ${index + 1}`} data-testid="meal-editor-dish">
      <div className="meal-dish-editor-heading">
        <h3>料理 {index + 1}</h3>
        {onRemove && (
          <button className="meal-button meal-button-quiet" type="button" onClick={onRemove} data-testid="meal-editor-remove-dish">
            料理を削除
          </button>
        )}
      </div>
      <div className="meal-editor-fields">
        <label className="meal-field">
          <span>料理名</span>
          <input name={`${path}.name`} value={dish.name} required
            aria-invalid={invalid === `${path}.name` || undefined} data-testid="meal-editor-dish-name"
            onChange={event => onChange({ ...dish, name: event.target.value })} />
        </label>
        <label className="meal-field">
          <span>料理の人数</span>
          <input name={`${path}.servings`} inputMode="decimal" value={dish.servings} placeholder="献立の人数を使う"
            aria-invalid={invalid === `${path}.servings` || undefined} data-testid="meal-editor-dish-servings"
            onChange={event => onChange({ ...dish, servings: event.target.value })} />
        </label>
      </div>

      <MealPhotoEditor api={api} analysisEnabled={photoAnalysisEnabled}
        photoId={dish.photoId === undefined ? dish.savedPhotoId : dish.photoId}
        isDraft={typeof dish.photoId === "string"}
        hasDishName={Boolean(dish.name.trim())} onChange={onPhotoChange}
        onUploadActivity={onUploadActivity} onApply={applyPhotoReview} />

      <div className="meal-ingredients-editor">
        <h4>材料と分量</h4>
        {dish.ingredients.length > 0 && <p className="meal-hint">料理全体で使う量を入力します。分からない量は空欄で保存できます。</p>}
        {dish.ingredients.map((ingredient, ingredientIndex) => {
          const ingredientPath = `${path}.ingredients.${ingredientIndex}`;
          return (
            <div className="meal-ingredient-editor" key={ingredient.key} role="group" aria-label={`材料 ${ingredientIndex + 1}`}>
              <label className="meal-field">
                <span>食材名</span>
                <input name={`${ingredientPath}.name`} value={ingredient.name} required
                  aria-invalid={invalid === `${ingredientPath}.name` || undefined} data-testid="meal-editor-ingredient-name"
                  onChange={event => setIngredient(ingredient.key, { name: event.target.value })} />
              </label>
              <label className="meal-field">
                <span>分量</span>
                <input name={`${ingredientPath}.amountText`} value={ingredient.amountText} placeholder="例 1/2、少々"
                  aria-invalid={invalid === `${ingredientPath}.amountText` || undefined} data-testid="meal-editor-ingredient-amount"
                  onChange={event => setIngredient(ingredient.key, { amountText: event.target.value })} />
              </label>
              <label className="meal-field">
                <span>単位</span>
                <input name={`${ingredientPath}.unit`} value={ingredient.unit} placeholder="例 g"
                  aria-invalid={invalid === `${ingredientPath}.unit` || undefined} data-testid="meal-editor-ingredient-unit"
                  onChange={event => setIngredient(ingredient.key, { unit: event.target.value })} />
              </label>
              <button className="meal-button meal-button-quiet" type="button" data-testid="meal-editor-remove-ingredient"
                onClick={() => onChange({ ...dish, ingredients: dish.ingredients.filter(item => item.key !== ingredient.key) })}>
                食材を削除
              </button>
            </div>
          );
        })}
        <button className="meal-button" type="button" disabled={dish.ingredients.length >= 100}
          data-testid="meal-editor-add-ingredient"
          onClick={() => onChange({ ...dish, ingredients: [...dish.ingredients, newIngredientDraft()] })}>
          食材を追加
        </button>
      </div>

      <div className="meal-recipe-editor">
        <label className="meal-field">
          <span>レシピの入力方法</span>
          <select value={dish.recipeMode} data-testid="meal-editor-recipe-mode"
            onChange={event => onChange({ ...dish, recipeMode: event.target.value === "url" ? "url" : "text" })}>
            <option value="text">本文</option>
            <option value="url">URL</option>
          </select>
        </label>
        {dish.recipeMode === "text" ? (
          <label className="meal-field">
            <span>作り方</span>
            <textarea name={`${path}.recipeText`} value={dish.recipeText} rows={3}
              aria-invalid={invalid === `${path}.recipeText` || undefined} data-testid="meal-editor-recipe-text"
              onChange={event => onChange({ ...dish, recipeText: event.target.value })} />
          </label>
        ) : (
          <label className="meal-field">
            <span>レシピ URL</span>
            <input name={`${path}.recipeUrl`} type="url" value={dish.recipeUrl} placeholder="https://example.com/recipe"
              aria-invalid={invalid === `${path}.recipeUrl` || undefined} data-testid="meal-editor-recipe-url"
              onChange={event => onChange({ ...dish, recipeUrl: event.target.value })} />
          </label>
        )}
      </div>
    </section>
  );
}

function errorText(path: string, message: string): string {
  if (path.endsWith("servings")) return "人数は0.01〜99の範囲で、小数第2位まで入力してください。";
  if (path === "mealDate") return "実在する日付を入力してください。";
  return message;
}

function copiedServingsLabel(dish: DishDraft, mealServings: string): string {
  if (dish.servings.trim()) return `入力した料理の人数（${dish.servings.trim()}人分）で保存する`;
  if (mealServings.trim()) return `コピー先の献立の人数（${mealServings.trim()}人分）で保存する`;
  return "人数を未入力のまま保存する";
}

export function MealEditor({ api, photoAnalysisEnabled, initial, busy, saveDisabled, fieldsDisabled, onDirty, onSave, onCancel, copyNotice, confirmCopyServings, lockSlot, saveLabel = "保存" }: MealEditorProps) {
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<{ path: string; message: string }>();
  const [copyConfirmed, setCopyConfirmed] = useState(false);
  const [uploadingDishKeys, setUploadingDishKeys] = useState<string[]>([]);
  const [copiedDishKey] = useState(() => confirmCopyServings ? initial.dishes.at(-1)?.key : undefined);
  const copiedDish = draft.dishes.find(dish => dish.key === copiedDishKey);

  function change(next: MealDraft) {
    const nextCopiedDish = next.dishes.find(dish => dish.key === copiedDishKey);
    if (next.servings !== draft.servings || nextCopiedDish?.servings !== copiedDish?.servings) {
      setCopyConfirmed(false);
    }
    setDraft(next);
    setError(undefined);
    onDirty();
  }

  function changePhoto(dishKey: string, photoId: string | null) {
    setDraft(current => ({
      ...current,
      dishes: current.dishes.map(dish => dish.key === dishKey ? { ...dish, photoId } : dish),
    }));
    setError(undefined);
    onDirty();
  }

  function setPhotoUploading(dishKey: string, active: boolean) {
    setUploadingDishKeys(keys => active ? [...keys, dishKey] : keys.filter(key => key !== dishKey));
    if (active) onDirty();
  }

  const uploading = uploadingDishKeys.length > 0;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || uploading || saveDisabled) return;
    const result = validateMealDraft(draft);
    if (!result.success) {
      const issue = result.error.issues[0];
      const path = issue.path.join(".");
      setError({ path, message: errorText(path, issue.message) });
      const control = event.currentTarget.elements.namedItem(path);
      if (control instanceof HTMLElement) control.focus();
      return;
    }
    if (copiedDish && !copyConfirmed) {
      setError({ path: "copy-confirmation", message: "コピーした料理の人数を確認してください。" });
      const confirmation = event.currentTarget.elements.namedItem("copy-confirmation");
      if (confirmation instanceof HTMLElement) confirmation.focus();
      return;
    }
    setError(undefined);
    onSave(result.data);
  }

  return (
    <form className="meal-editor" data-testid="meal-editor" aria-label="献立の入力" aria-busy={busy} onSubmit={submit} noValidate>
      {copyNotice && <p className="meal-copy-note">{copyNotice}</p>}
      {error && <p className="meal-error" role="alert">{error.message}</p>}
      <fieldset className="meal-editor-body" disabled={busy || fieldsDisabled}>
        <div className="meal-editor-fields">
          <label className="meal-field">
            <span>日付</span>
            <input name="mealDate" type="date" min="0001-01-01" max="9999-12-31" required
              readOnly={lockSlot} value={draft.mealDate} data-testid="meal-editor-date"
              aria-invalid={error?.path === "mealDate" || undefined}
              onChange={event => change({ ...draft, mealDate: event.target.value })} />
          </label>
          <label className="meal-field">
            <span>食事区分</span>
            <select name="mealType" value={draft.mealType} disabled={lockSlot} data-testid="meal-editor-type"
              onChange={event => change({ ...draft, mealType: event.target.value as MealType })}>
              {MEAL_TYPES.map(type => <option key={type} value={type}>{MEAL_TYPE_LABELS[type]}</option>)}
            </select>
          </label>
          <label className="meal-field">
            <span>献立の人数</span>
            <input name="servings" value={draft.servings} inputMode="decimal" placeholder="任意"
              aria-invalid={error?.path === "servings" || undefined} data-testid="meal-editor-servings"
              onChange={event => change({ ...draft, servings: event.target.value })} />
          </label>
        </div>
        {draft.dishes.map((dish, index) => (
          <DishEditor key={dish.key} api={api} photoAnalysisEnabled={photoAnalysisEnabled} dish={dish} index={index} invalid={error?.path}
            onChange={next => change({ ...draft, dishes: draft.dishes.map(item => item.key === dish.key ? next : item) })}
            onPhotoChange={photoId => changePhoto(dish.key, photoId)}
            onUploadActivity={active => setPhotoUploading(dish.key, active)}
            onRemove={draft.dishes.length > 1
              ? () => {
                change({ ...draft, dishes: draft.dishes.filter(item => item.key !== dish.key) });
                setPhotoUploading(dish.key, false);
              }
              : undefined} />
        ))}
        <button className="meal-button" type="button" disabled={draft.dishes.length >= 20} data-testid="meal-editor-add-dish"
          onClick={() => change({ ...draft, dishes: [...draft.dishes, newDishDraft()] })}>
          料理を追加
        </button>
        {copiedDish && (
          <div className="meal-copy-confirmation">
            <p>コピー元の「{copiedDish.name || "料理"}」の人数は不明です。料理の人数を入力するか、以下の人数で保存してください。</p>
            <label>
              <input name="copy-confirmation" type="checkbox" checked={copyConfirmed}
                aria-invalid={error?.path === "copy-confirmation" || undefined} data-testid="meal-editor-confirm-copy-servings"
                onChange={event => { setCopyConfirmed(event.target.checked); setError(undefined); }} />
              {copiedServingsLabel(copiedDish, draft.servings)}
            </label>
          </div>
        )}
      </fieldset>
      <div className="meal-editor-actions">
        <button className="meal-button" type="button" disabled={busy} data-testid="meal-editor-cancel" onClick={onCancel}>
          キャンセル
        </button>
        <button className="meal-button meal-button-primary" type="submit" disabled={busy || uploading || saveDisabled} data-testid="meal-editor-save">
          {busy ? "保存中…" : saveLabel}
        </button>
      </div>
    </form>
  );
}

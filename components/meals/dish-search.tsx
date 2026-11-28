import { useId, useState, type FormEvent } from "react";
import { dishSearchSchema, type DishSearchBy } from "@/lib/shared/meal-schemas";
import type { DishSearchItem } from "@/lib/shared/meal-types";
import { formatMealDate, MEAL_TYPE_LABELS } from "./meal-dates";

type DishSearchProps = {
  onSearch: (query: string, by: DishSearchBy) => void;
  onRetry: () => void;
  onMore: () => void;
  onSelect: (item: DishSearchItem) => void;
  items: DishSearchItem[];
  state: "idle" | "loading" | "loaded" | "error";
  hasMore: boolean;
};

export function DishSearch({ onSearch, onRetry, onMore, onSelect, items, state, hasMore }: DishSearchProps) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [by, setBy] = useState<DishSearchBy>("name");
  const [inputError, setInputError] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = dishSearchSchema.safeParse({ q: query, by });
    if (!parsed.success) {
      setInputError(parsed.error.issues[0]?.message ?? "検索語を入力してください。");
      return;
    }
    setInputError("");
    onSearch(parsed.data.q, parsed.data.by);
  }

  return (
    <section className="meal-search" aria-label="料理の検索" data-testid="meal-search">
      <form className="meal-search-form" role="search" onSubmit={submit}>
        <select aria-label="検索対象" data-testid="meal-search-by" value={by}
          onChange={event => setBy(event.target.value as DishSearchBy)}>
          <option value="name">料理名</option>
          <option value="ingredient">食材名</option>
        </select>
        <input className="meal-input" aria-label={by === "ingredient" ? "検索する食材名" : "検索する料理名"}
          data-testid="meal-search-input" type="search" value={query} aria-invalid={Boolean(inputError)}
          aria-describedby={inputError ? `${id}-error` : undefined}
          onChange={event => { setQuery(event.target.value); setInputError(""); }} />
        <button type="submit" className="meal-button meal-button-primary" data-testid="meal-search-submit">検索</button>
      </form>
      {inputError && <p id={`${id}-error`} className="meal-feedback meal-feedback-error" role="alert">{inputError}</p>}
      {state === "loading" && <p className="meal-feedback" role="status">検索しています。</p>}
      {state === "error" && (
        <div className="meal-feedback meal-feedback-error" role="alert">
          <p>検索結果を取得できませんでした。</p>
          <button type="button" className="meal-button meal-button-secondary" onClick={onRetry}>再検索</button>
        </div>
      )}
      {state === "loaded" && items.length === 0 && <p className="meal-feedback" role="status">該当する料理はありません。</p>}
      {items.length > 0 && (
        <ul className="meal-search-results">
          {items.map(item => (
            <li key={item.dishId}>
              <button type="button" className="meal-search-result" data-testid="meal-search-result" data-date={item.mealDate} data-meal-type={item.mealType} onClick={() => onSelect(item)}>
                <strong>{item.dishName}</strong>
                <span><time dateTime={item.mealDate}>{formatMealDate(item.mealDate)}</time> {MEAL_TYPE_LABELS[item.mealType]}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {hasMore && state !== "error" && <button type="button" className="meal-button meal-button-secondary" data-testid="meal-search-more" disabled={state === "loading"} onClick={onMore}>次の結果を表示</button>}
    </section>
  );
}

import type { MealDetail, MealDish, MealType } from "@/lib/shared/meal-types";
import { formatMealDate, MEAL_TYPE_LABELS } from "./meal-dates";

const updatedAtFormat = new Intl.DateTimeFormat("ja-JP", {
  dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Tokyo",
});

type MealDetailsProps = {
  date: string;
  meal: MealType;
  detail: MealDetail | null;
  status: "empty" | "loading" | "error" | "loaded";
  onRetry: () => void;
  onAdd: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onCopy: (dishId?: string) => void;
};

function DishDetails({ dish, mealServings, onCopy }: { dish: MealDish; mealServings: number | null; onCopy?: () => void }) {
  const servings = dish.servings ?? mealServings;
  const recipeUrl = dish.recipeUrl && /^https?:\/\//i.test(dish.recipeUrl) ? dish.recipeUrl : null;
  return (
    <li className="meal-detail-dish" data-dish-id={dish.id}>
      <div className="meal-detail-dish-header">
        <h3>{dish.name}</h3>
        {servings !== null && <span>{servings}人分</span>}
      </div>
      {dish.ingredients.length > 0 && (
        <>
          <h4>食材</h4>
          <ul className="meal-ingredients">
            {dish.ingredients.map(ingredient => (
              <li key={ingredient.id}>
                <span>{ingredient.name}</span>
                <span>{ingredient.amountText ?? "分量未入力"}{ingredient.unit && ` ${ingredient.unit}`}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {dish.recipeText && <><h4>作り方</h4><p className="meal-recipe-text">{dish.recipeText}</p></>}
      {recipeUrl && <a className="meal-recipe-link" href={recipeUrl} target="_blank" rel="noreferrer">レシピを開く（別タブ）</a>}
      {onCopy && <button type="button" className="meal-button meal-button-secondary" data-testid="meal-detail-copy-dish" data-dish-id={dish.id} aria-label={`「${dish.name}」をコピー`} onClick={onCopy}>この料理をコピー</button>}
    </li>
  );
}

export function MealRecord({ detail, onCopy }: { detail: MealDetail; onCopy?: (dishId: string) => void }) {
  return <>
    <div className="meal-detail-meta">
      <span className="meal-detail-status is-recorded">記録済み</span>
      {detail.servings !== null && <span>献立 {detail.servings}人分</span>}
      <span>{detail.updatedBy.name}が <time dateTime={detail.updatedAt}>{updatedAtFormat.format(new Date(detail.updatedAt))}</time> に更新</span>
    </div>
    <ol className="meal-detail-dishes">
      {detail.dishes.map(dish => <DishDetails key={dish.id} dish={dish} mealServings={detail.servings} onCopy={onCopy && (() => onCopy(dish.id))} />)}
    </ol>
  </>;
}

export function MealDetails({ date, meal, detail, status, onRetry, onAdd, onEdit, onDelete, onCopy }: MealDetailsProps) {
  return (
    <section className="meal-detail" data-testid="meal-detail" aria-label={`${MEAL_TYPE_LABELS[meal]}の詳細`}>
      <div className="meal-detail-header">
        <time dateTime={date}>{formatMealDate(date)}</time>
        <h2>{MEAL_TYPE_LABELS[meal]}</h2>
      </div>
      {status === "loading" && <p className="meal-detail-status" role="status">献立を読み込んでいます。</p>}
      {status === "error" && (
        <div className="meal-feedback meal-feedback-error" role="alert">
          <p>献立を取得できませんでした。</p>
          <button type="button" className="meal-button meal-button-secondary" onClick={onRetry}>詳細を再取得</button>
        </div>
      )}
      {status === "empty" && (
        <div className="meal-detail-empty">
          <p className="meal-detail-status">未記録</p>
          <button type="button" className="meal-button meal-button-primary" data-testid="meal-detail-add" onClick={onAdd}>献立を登録</button>
        </div>
      )}
      {status === "loaded" && detail && (
        <>
          <MealRecord detail={detail} onCopy={onCopy} />
          <div className="meal-detail-actions">
            <button type="button" className="meal-button meal-button-primary" data-testid="meal-detail-edit" onClick={onEdit}>編集する</button>
            <button type="button" className="meal-button meal-button-secondary" data-testid="meal-detail-copy" onClick={() => onCopy()}>献立をコピー</button>
            <button type="button" className="meal-button meal-button-danger" data-testid="meal-detail-delete" onClick={onDelete}>削除する</button>
          </div>
        </>
      )}
    </section>
  );
}

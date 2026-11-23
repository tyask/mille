import { MEAL_TYPES, type MealSummary, type MealType } from "@/lib/shared/meal-types";
import {
  formatMealDate, getMealPeriod, mealWeekday, MEAL_TYPE_LABELS, moveMealPeriod, tokyoToday, type MealView,
} from "./meal-dates";

const weekdays = ["月", "火", "水", "木", "金", "土", "日"];

type CalendarStatus = "loading" | "error" | "loaded";

type CalendarProps = {
  date: string;
  view: MealView;
  meal: MealType;
  meals: MealSummary[];
  status: CalendarStatus;
  onDate: (date: string) => void;
  onView: (view: MealView) => void;
  onSelect: (date: string, meal: MealType) => void;
  onRetry: () => void;
};

function slotText(status: CalendarStatus, meal: MealSummary | undefined) {
  if (status === "loading") return "読込中";
  if (status === "error") return "取得できません";
  return meal ? "記録済み" : "未記録";
}

function DateButton({ date, today, selected, variant, status, records, onDate }: {
  date: string;
  today: string;
  selected: boolean;
  variant: "week" | "overview" | "month";
  status: CalendarStatus;
  records: (type: MealType) => MealSummary | undefined;
  onDate: (date: string) => void;
}) {
  const slots = MEAL_TYPES.map(type => ({ type, record: records(type) }));
  const summary = status === "loaded"
    ? slots.map(({ type, record }) => `${MEAL_TYPE_LABELS[type]} ${slotText(status, record)}`).join("、")
    : slotText(status, undefined);
  return (
    <button
      type="button"
      className={`meal-date-button${selected ? " is-selected" : ""}${date === today ? " is-today" : ""}`}
      data-testid={`meal-${variant}-date`}
      data-date={date}
      aria-label={`${formatMealDate(date)}、${summary}`}
      aria-current={date === today ? "date" : undefined}
      aria-pressed={selected}
      onClick={() => onDate(date)}
    >
      {variant !== "month" && <span className="meal-date-weekday">{weekdays[mealWeekday(date)]}</span>}
      <span className="meal-date-number">{Number(date.slice(8))}</span>
      {status === "loaded" && variant === "overview" && (
        <span className="meal-date-count">{slots.filter(({ record }) => record).length}食</span>
      )}
      {status === "loaded" && variant === "month" && (
        <span className="meal-month-markers" aria-hidden="true">
          {slots.map(({ type, record }) => (
            <span key={type} className={`meal-marker meal-marker-${type}${record ? " is-recorded" : ""}`} />
          ))}
        </span>
      )}
    </button>
  );
}

function SlotButton({ date, type, record, selected, status, daySummary = false, onSelect }: {
  date: string;
  type: MealType;
  record: MealSummary | undefined;
  selected: boolean;
  status: CalendarStatus;
  daySummary?: boolean;
  onSelect: (date: string, meal: MealType) => void;
}) {
  const label = slotText(status, record);
  const name = record?.dishes.map(dish => dish.name).join("、");
  return (
    <button
      type="button"
      className={`meal-slot${daySummary ? " meal-day-slot" : ""}${selected ? " is-selected" : ""}${record ? " is-recorded" : ""}`}
      data-testid={daySummary ? "meal-day-slot" : "meal-week-slot"}
      data-date={date}
      data-meal-type={type}
      aria-pressed={selected}
      aria-label={`${formatMealDate(date)} ${MEAL_TYPE_LABELS[type]} ${label}${name ? `、${name}` : ""}`}
      onClick={() => onSelect(date, type)}
    >
      {daySummary && <span className="meal-slot-type">{MEAL_TYPE_LABELS[type]}</span>}
      <span className="meal-slot-status">{label}</span>
      {name && <span className="meal-slot-name">{name}</span>}
    </button>
  );
}

function periodLabel(date: string, days: string[], view: MealView) {
  const monthDay = (day: string) => `${Number(day.slice(5, 7))}月${Number(day.slice(8))}日`;
  if (view === "month") return `${Number(date.slice(0, 4))}年${Number(date.slice(5, 7))}月`;
  const first = days[0];
  const last = days[days.length - 1];
  const endYear = first.slice(0, 4) === last.slice(0, 4) ? "" : `${Number(last.slice(0, 4))}年`;
  return `${Number(first.slice(0, 4))}年${monthDay(first)} – ${endYear}${monthDay(last)}`;
}

export function MealCalendar({ date, view, meal, meals, status, onDate, onView, onSelect, onRetry }: CalendarProps) {
  const today = tokyoToday();
  const { days } = getMealPeriod(date, view);
  const previous = moveMealPeriod(date, view, -1);
  const next = moveMealPeriod(date, view, 1);
  const unit = view === "week" ? "週" : "月";
  const bySlot = new Map((status === "loaded" ? meals : []).map(record => [`${record.mealDate}/${record.mealType}`, record]));
  const getMeal = (day: string, type: MealType) => bySlot.get(`${day}/${type}`);

  function dateButton(day: string, variant: "week" | "overview" | "month") {
    return <DateButton date={day} today={today} selected={date === day} variant={variant} status={status} records={type => getMeal(day, type)} onDate={onDate} />;
  }

  function slotButton(day: string, type: MealType, daySummary = false) {
    return <SlotButton date={day} type={type} record={getMeal(day, type)} selected={day === date && type === meal} status={status} onSelect={onSelect} daySummary={daySummary} />;
  }

  return (
    <section className={`meal-calendar meal-calendar-${view}`} aria-label="献立カレンダー" data-testid="meal-calendar">
      <div className="meal-calendar-toolbar">
        <div className="meal-view-control" role="group" aria-label="献立の表示期間">
          <button type="button" className="meal-button meal-button-secondary" data-testid="meal-view-week" aria-pressed={view === "week"} onClick={() => onView("week")}>週</button>
          <button type="button" className="meal-button meal-button-secondary" data-testid="meal-view-month" aria-pressed={view === "month"} onClick={() => onView("month")}>月</button>
        </div>
        <button type="button" className="meal-button meal-button-secondary" onClick={() => onDate(today)}>今日へ</button>
      </div>
      <div className="meal-range-controls">
        <button type="button" className="meal-button meal-button-secondary" aria-label={`前の${unit}`} disabled={previous === date} onClick={() => onDate(previous)}>‹</button>
        <h2 className="meal-period-label">{periodLabel(date, days, view)}</h2>
        <button type="button" className="meal-button meal-button-secondary" aria-label={`次の${unit}`} disabled={next === date} onClick={() => onDate(next)}>›</button>
      </div>
      {status === "loading" && <p className="meal-feedback meal-calendar-feedback" role="status">献立を読み込んでいます。</p>}
      {status === "error" && (
        <div className="meal-feedback meal-feedback-error meal-calendar-feedback" role="alert">
          <p>献立を取得できませんでした。</p>
          <button type="button" className="meal-button meal-button-secondary" onClick={onRetry}>一覧を再取得</button>
        </div>
      )}
      {view === "week" ? (
        <>
          <table className="meal-week-grid">
            <caption className="ws-sr-only">週の朝・昼・夕の献立</caption>
            <thead>
              <tr><td />{days.map(day => <th scope="col" key={day}>{dateButton(day, "week")}</th>)}</tr>
            </thead>
            <tbody>
              {MEAL_TYPES.map(type => (
                <tr key={type}>
                  <th scope="row">{MEAL_TYPE_LABELS[type]}</th>
                  {days.map(day => <td key={day}>{slotButton(day, type)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="meal-week-overview" role="group" aria-label="週の日付">
            {days.map(day => <div key={day}>{dateButton(day, "overview")}</div>)}
          </div>
        </>
      ) : (
        <>
          <div className="meal-weekdays" aria-hidden="true">{weekdays.map(day => <span key={day}>{day}</span>)}</div>
          <div className="meal-month-grid" role="group" aria-label="月の日付">
            {Array.from({ length: mealWeekday(days[0]) }, (_, index) => <span key={`blank-${index}`} aria-hidden="true" />)}
            {days.map(day => <div key={day}>{dateButton(day, "month")}</div>)}
          </div>
          <p className="meal-month-legend">左から 朝・昼・夕。塗りつぶしは記録済み。</p>
        </>
      )}
      <section className="meal-day-slots" aria-label="選択した日の献立">
        <h3>{formatMealDate(date)}</h3>
        <ul className="meal-day-slot-list">
          {MEAL_TYPES.map(type => <li key={type}>{slotButton(date, type, true)}</li>)}
        </ul>
      </section>
    </section>
  );
}

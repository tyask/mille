"use client";

import { useEffect, useRef, useState } from "react";
import type { MealPhotoAnalysis } from "@/lib/shared/meal-photo-analysis";
import { MEAL_PHOTO_MAX_BYTES } from "@/lib/shared/meal-photo-types";
import { newIngredientDraft, type IngredientDraft, type ReviewedMealPhoto } from "./meal-draft";
import { analyzeMealPhoto, MealPhotoRequestError, uploadMealPhoto } from "./meal-photo-client";
import { MealPhotoImage } from "./meal-photo-image";

type UploadFile = { id: string; file: File };
type UploadState = { status: "uploading" } | { status: "failed"; message: string; retry?: UploadFile };
type AnalysisState = { status: "analyzing" } | { status: "failed"; message: string }
  | { status: "ready"; dishes: MealPhotoAnalysis["dishes"]; selection: number; reviews: ReviewedMealPhoto[]; sample: boolean };

const manualEntry = "写真を添付したまま手入力で記録できます。";

function candidateReview(candidate: MealPhotoAnalysis["dishes"][number]): ReviewedMealPhoto {
  return {
    name: candidate.name,
    ingredients: candidate.ingredients.map(ingredient => ({
      key: crypto.randomUUID(),
      name: ingredient.name,
      amountText: ingredient.amountText ?? "",
      unit: ingredient.unit ?? "",
    })),
  };
}

export function MealPhotoEditor({ api, analysisEnabled, photoId, hasDishName, onChange, onUploadActivity, onApply }: {
  api: string;
  analysisEnabled: boolean;
  photoId?: string | null;
  hasDishName: boolean;
  onChange: (photoId: string | null) => void;
  onUploadActivity: (active: boolean) => void;
  onApply: (review: ReviewedMealPhoto) => boolean;
}) {
  const pendingUpload = useRef<AbortController | null>(null);
  const pendingAnalysis = useRef<AbortController | null>(null);
  const [upload, setUpload] = useState<UploadState | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisState | null>(null);
  const [reviewError, setReviewError] = useState("");

  useEffect(() => () => {
    pendingUpload.current?.abort();
    pendingAnalysis.current?.abort();
  }, []);

  function clearAnalysis() {
    pendingAnalysis.current?.abort();
    pendingAnalysis.current = null;
    setAnalysis(null);
    setReviewError("");
  }

  async function uploadFile(attempt: UploadFile) {
    if (pendingUpload.current) return;
    clearAnalysis();
    const controller = new AbortController();
    pendingUpload.current = controller;
    setUpload({ status: "uploading" });
    onUploadActivity(true);
    try {
      await uploadMealPhoto(api, attempt.id, attempt.file, controller.signal);
      if (controller.signal.aborted) return;
      onChange(attempt.id);
      setUpload(null);
    } catch (cause) {
      if (controller.signal.aborted) return;
      const status = cause instanceof MealPhotoRequestError ? cause.status : undefined;
      setUpload({
        status: "failed",
        message: cause instanceof MealPhotoRequestError ? cause.message : "写真を送信できませんでした。",
        retry: status === undefined || status >= 500 || status === 429 ? attempt : undefined,
      });
    } finally {
      if (!controller.signal.aborted) {
        pendingUpload.current = null;
        onUploadActivity(false);
      }
    }
  }

  function chooseFile(file: File) {
    if (file.size === 0 || file.size > MEAL_PHOTO_MAX_BYTES) {
      setUpload({ status: "failed", message: "写真は1枚8 MiB以下の空でないファイルを選んでください。" });
      return;
    }
    void uploadFile({ id: crypto.randomUUID(), file });
  }

  async function analyze() {
    if (!analysisEnabled || !photoId || pendingAnalysis.current || pendingUpload.current) return;
    const controller = new AbortController();
    pendingAnalysis.current = controller;
    setAnalysis({ status: "analyzing" });
    setReviewError("");
    try {
      const { result, sample } = await analyzeMealPhoto(api, photoId, controller.signal);
      if (controller.signal.aborted) return;
      setAnalysis(result.dishes.length === 0
        ? { status: "failed", message: "写真から料理や食材を推定できませんでした。" }
        : { status: "ready", dishes: result.dishes, selection: 0, reviews: result.dishes.map(candidateReview), sample });
    } catch (cause) {
      if (controller.signal.aborted) return;
      setAnalysis({
        status: "failed",
        message: cause instanceof MealPhotoRequestError ? cause.message : "写真を解析できませんでした。",
      });
    } finally {
      if (!controller.signal.aborted) pendingAnalysis.current = null;
    }
  }

  function changeReview(review: ReviewedMealPhoto) {
    if (analysis?.status !== "ready") return;
    setAnalysis({ ...analysis, reviews: analysis.reviews.map((current, index) => index === analysis.selection ? review : current) });
    setReviewError("");
  }

  function setIngredient(key: string, values: Partial<Pick<IngredientDraft, "name" | "amountText" | "unit">>) {
    if (!review) return;
    changeReview({
      ...review,
      ingredients: review.ingredients.map(ingredient =>
        ingredient.key === key ? { ...ingredient, ...values } : ingredient),
    });
  }

  function applyReview() {
    if (!review) return;
    if ((!hasDishName && !review.name.trim()) || review.ingredients.some(ingredient => !ingredient.name.trim())) {
      setReviewError("料理名と、追加する食材の名前を入力してください。");
      return;
    }
    if (!onApply(review)) {
      setReviewError("1つの料理に保存できる食材は100件までです。追加する食材を減らしてください。");
      return;
    }
    clearAnalysis();
  }

  const uploading = upload?.status === "uploading";
  const analyzing = analysis?.status === "analyzing";
  const review = analysis?.status === "ready" ? analysis.reviews[analysis.selection] : undefined;
  return <section className="meal-photo-editor" aria-label="料理写真">
    <h4>写真</h4>
    {photoId && <MealPhotoImage key={photoId} api={api} photoId={photoId} alt="添付した料理写真" testId="meal-photo-preview" />}
    <label className="meal-field">
      <span>{photoId ? "写真を差し替える" : "写真を添付する"}</span>
      <input data-testid="meal-photo-file" type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" disabled={uploading}
        onChange={event => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) chooseFile(file);
        }} />
    </label>
    {uploading && <p className="meal-hint" role="status">写真を送信しています…</p>}
    {upload?.status === "failed" && <>
      <p className="meal-feedback meal-feedback-error" role="alert">{upload.message}</p>
      {upload.retry && <button className="meal-button meal-button-secondary" type="button" onClick={() => upload.retry && void uploadFile(upload.retry)}>送信を再試行</button>}
    </>}
    {photoId && <div className="meal-photo-actions">
      {analysisEnabled && <button type="button" className="meal-button meal-button-secondary" data-testid="meal-photo-analyze"
        disabled={uploading || analyzing || analysis?.status === "ready"} onClick={() => void analyze()}>
        {analyzing ? "写真を解析しています…" : analysis?.status === "failed" ? "解析を再試行" : "写真から入力する"}
      </button>}
      <button type="button" className="meal-button meal-button-quiet" data-testid="meal-photo-remove" disabled={uploading}
        onClick={() => { clearAnalysis(); setUpload(null); onChange(null); }}>写真を外す</button>
    </div>}
    {analyzing && <p className="meal-hint" role="status">解析中も献立を入力できます。</p>}
    {analysis?.status === "failed" && <p className="meal-feedback meal-feedback-error" role="alert">{analysis.message}{manualEntry}</p>}
    {analysis?.status === "ready" && review && <section className="meal-photo-review" aria-label="写真からの入力候補"
      onKeyDown={event => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing && event.target instanceof HTMLInputElement) {
          event.preventDefault();
        }
      }}>
      <h5>推定結果を確認する</h5>
      {analysis.sample && <p className="meal-hint">テスト用の推定例です。</p>}
      <p className="meal-hint">見えない食材や調味料、分量を確認してください。分からない分量は空欄のまま残せます。入力済みの料理名と食材は保持します。</p>
      {analysis.dishes.length > 1 && <label className="meal-field">
        <span>写真に写った料理</span>
        <select value={analysis.selection} data-testid="meal-photo-analysis-dish"
          onChange={event => {
            setAnalysis({ ...analysis, selection: Number(event.target.value) });
            setReviewError("");
          }}>
          {analysis.dishes.map((dish, index) => <option key={index} value={index}>{dish.name}</option>)}
        </select>
      </label>}
      <label className="meal-field">
        <span>推定した料理名</span>
        <input value={review.name} maxLength={120} data-testid="meal-photo-analysis-name"
          onChange={event => changeReview({ ...review, name: event.target.value })} />
      </label>
      {review.ingredients.map((ingredient, index) => <div className="meal-ingredient-editor" role="group"
        aria-label={`候補の食材 ${index + 1}`} key={ingredient.key}>
        <label className="meal-field">
          <span>食材名</span>
          <input value={ingredient.name} maxLength={120} data-testid="meal-photo-analysis-ingredient-name"
            onChange={event => setIngredient(ingredient.key, { name: event.target.value })} />
        </label>
        <label className="meal-field">
          <span>分量</span>
          <input value={ingredient.amountText} maxLength={40} placeholder="不明"
            data-testid="meal-photo-analysis-amount" onChange={event => setIngredient(ingredient.key, { amountText: event.target.value })} />
        </label>
        <label className="meal-field">
          <span>単位</span>
          <input value={ingredient.unit} maxLength={20} data-testid="meal-photo-analysis-unit"
            onChange={event => setIngredient(ingredient.key, { unit: event.target.value })} />
        </label>
        <button type="button" className="meal-button meal-button-quiet" data-testid="meal-photo-analysis-remove"
          onClick={() => changeReview({ ...review, ingredients: review.ingredients.filter(item => item.key !== ingredient.key) })}>
          候補から外す
        </button>
      </div>)}
      {reviewError && <p className="meal-feedback meal-feedback-error" role="alert">{reviewError}</p>}
      <div className="meal-photo-actions">
        <button type="button" className="meal-button meal-button-secondary" data-testid="meal-photo-analysis-add"
          disabled={review.ingredients.length >= 100}
          onClick={() => changeReview({ ...review, ingredients: [...review.ingredients, newIngredientDraft()] })}>
          食材を追加
        </button>
        <button type="button" className="meal-button meal-button-quiet" onClick={clearAnalysis}>閉じる</button>
        <button type="button" className="meal-button meal-button-primary" data-testid="meal-photo-analysis-apply" onClick={applyReview}>
          確認した内容を入力する
        </button>
      </div>
    </section>}
  </section>;
}

"use client";

import { useState } from "react";
import { mealPhotoUrl } from "./meal-photo-client";

export function MealPhotoImage({ api, photoId, alt, testId }: {
  api: string;
  photoId: string;
  alt: string;
  testId: string;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return <div className="meal-photo-failure">
      <p className="meal-hint" role="status">写真を読み込めませんでした。</p>
      <button className="meal-button meal-button-secondary" type="button" onClick={() => setFailed(false)}>写真を再取得</button>
    </div>;
  }
  // Keep the private image on the page origin so the browser sends its session cookie.
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="meal-photo-image" src={mealPhotoUrl(api, photoId)} alt={alt}
    width={320} height={240} loading="lazy" decoding="async" data-testid={testId} onError={() => setFailed(true)} />;
}

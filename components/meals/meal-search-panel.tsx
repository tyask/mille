"use client";

import { useEffect, useRef, useState } from "react";
import type { DishSearchBy } from "@/lib/shared/meal-schemas";
import type { DishSearchItem, DishSearchPage } from "@/lib/shared/meal-types";
import { DishSearch } from "./dish-search";
import { mealRequest, useMealResource } from "./meal-client";

type ExtraResults = { base: DishSearchPage; page: DishSearchPage; status: "loading" | "loaded" | "error" };

export function MealSearchPanel({ api, revision, onSelect }: {
  api: string;
  revision: number;
  onSelect: (item: DishSearchItem) => void;
}) {
  const [query, setQuery] = useState<{ text: string; by: DishSearchBy; attempt: number }>({ text: "", by: "name", attempt: 0 });
  const [extra, setExtra] = useState<ExtraResults | null>(null);
  const loadMoreRequest = useRef<AbortController | null>(null);
  const url = query.text ? `${api}/dish-search?${new URLSearchParams({ q: query.text, by: query.by })}` : null;
  const result = useMealResource<DishSearchPage>(url, revision + query.attempt);
  const initial = result.status === "loaded" ? result.data : null;
  const additional = extra?.base === initial ? extra : null;
  const page = additional?.page ?? initial;

  useEffect(() => () => loadMoreRequest.current?.abort(), [url, revision, query.attempt]);

  function search(value: string, by: DishSearchBy) {
    loadMoreRequest.current?.abort();
    setQuery(previous => ({ text: value, by, attempt: previous.attempt + 1 }));
  }

  async function more() {
    if (!url || !initial || !page?.nextCursor || additional?.status === "loading") return;
    loadMoreRequest.current?.abort();
    const request = new AbortController();
    loadMoreRequest.current = request;
    setExtra({ base: initial, page, status: "loading" });
    try {
      const response = await mealRequest<DishSearchPage>(`${url}&${new URLSearchParams({ cursor: page.nextCursor })}`, request.signal);
      if (request.signal.aborted) return;
      const seen = new Set(page.items.map(item => item.dishId));
      const items = [...page.items, ...response.items.filter(item => !seen.has(item.dishId))];
      setExtra({ base: initial, page: { items, nextCursor: response.nextCursor }, status: "loaded" });
    } catch {
      if (!request.signal.aborted) setExtra({ base: initial, page, status: "error" });
    }
  }

  return <DishSearch
    onSearch={search}
    onRetry={() => additional?.status === "error" ? void more() : search(query.text, query.by)}
    onMore={() => void more()}
    onSelect={onSelect}
    items={page?.items ?? []}
    state={url ? additional?.status ?? result.status : "idle"}
    hasMore={Boolean(page?.nextCursor)}
  />;
}

"use client";

import { useEffect, useRef, type ReactNode } from "react";

export function MealDialog({ title, testId, busy, children, onClose }: {
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

import type { SVGProps } from "react";

export type WorkspaceIconName = "user" | "users" | "plus" | "close" | "arrow" | "check" | "refresh" | "edit" | "trash" | "mail" | "link" | "copy" | "logout" | "shield" | "leaf" | "menu";

const paths: Record<WorkspaceIconName, string> = {
  user: "M19 21v-2a7 7 0 0 0-14 0v2M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  users: "M15 21v-2a6 6 0 0 0-12 0v2M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM21 21v-2a6 6 0 0 0-4-5.65M17 3.35a4 4 0 0 1 0 7.3",
  plus: "M12 5v14M5 12h14",
  close: "m6 6 12 12M6 18 18 6",
  arrow: "M4 12h16m-6-6 6 6-6 6",
  check: "m5 12 4 4L19 6",
  refresh: "M20 7v5h-5M4 17v-5h5M6.1 6.1a8 8 0 0 1 13.4 3M4.5 14.9a8 8 0 0 0 13.4 3",
  edit: "m16 3 5 5-12 12-6 1 1-6L16 3ZM13 6l5 5",
  trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7",
  mail: "M3 5h18v14H3V5Zm0 1 9 7 9-7",
  link: "m10 13 4-4M8 16l-2 2a4.25 4.25 0 0 1-6-6l4-4a4.25 4.25 0 0 1 6 0m4 0 2-2a4.25 4.25 0 0 1 6 6l-4 4a4.25 4.25 0 0 1-6 0",
  copy: "M8 8h13v13H8V8ZM16 8V3H3v13h5",
  logout: "M9 3H3v18h6M8 12h13m-5-5 5 5-5 5",
  shield: "m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Zm-4 9 3 3 5-6",
  leaf: "M5 20c2-7 5-12 13-15M5 17C-1 6 11 2 21 3c1 11-4 19-16 14Z",
  menu: "M4 6h16M4 12h16M4 18h16",
};

export function WorkspaceIcon({ name, ...props }: SVGProps<SVGSVGElement> & { name: WorkspaceIconName }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" width="20" height="20" aria-hidden="true" {...props}><path d={paths[name]} /></svg>;
}

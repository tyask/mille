import { auth } from "@/auth";
import type { AppUser } from "../../shared/types";
import { findUserByIdentity } from "../database/users";
import { resolveSessionUser } from "./auth-callbacks";

export async function getCurrentUser(): Promise<AppUser | null> {
  try {
    const session = await auth();
    return resolveSessionUser(session?.user, findUserByIdentity);
  } catch {
    return null;
  }
}

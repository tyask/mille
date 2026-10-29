import { createHash, randomBytes } from "node:crypto";
import { verifiedDatabaseQuery, type Query } from "./database/client";
import type { AppUser } from "../shared/types";
import type {
  InvitationPreview,
  IssuedInvitation,
  JoinedWorkspace,
  Workspace,
  WorkspaceInvitation,
  WorkspaceState,
  WorkspaceType,
} from "../shared/workspaces";
import {
  deleteWorkspaceSchema,
  invitationInputSchema,
  invitationTokenSchema,
  renameWorkspaceSchema,
  workspaceInputSchema,
} from "../shared/workspace-schemas";

export class DomainError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "DomainError";
  }
}

type CommandResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

export interface WorkspaceRepository {
  list(): Promise<WorkspaceState>;
  create(input: { name: string; type: WorkspaceType }): Promise<Workspace>;
  rename(id: string, name: string): Promise<Workspace>;
  delete(id: string, confirmationName: string): Promise<void>;
  invite(id: string, email: string): Promise<IssuedInvitation>;
  previewInvite(token: string): Promise<InvitationPreview>;
  acceptInvite(token: string): Promise<JoinedWorkspace>;
  acceptInviteById(id: string): Promise<JoinedWorkspace>;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(invitationTokenSchema.parse(token)).digest("hex");
}

/** SQL commands enforce membership, live user status and atomic writes in one DB call. */
export function createWorkspaceRepository(query: Query, user: AppUser): WorkspaceRepository {
  async function command<T>(operation: string, payload: Record<string, unknown> = {}): Promise<T> {
    if (!user.isEnabled) throw new DomainError(401, "ログインしてください。");
    const rows = await query<{ result: CommandResult<T> }>(
      "SELECT mille_workspace_command($1,$2,$3,$4::jsonb) AS result",
      [user.id, user.email.trim().toLowerCase(), operation, JSON.stringify(payload)],
    );
    const result = rows[0]?.result;
    if (!result || typeof result !== "object" || typeof result.ok !== "boolean") {
      throw new Error("Invalid workspace command response");
    }
    if (!result.ok) {
      if (!Number.isInteger(result.status) || result.status < 400 || result.status > 499 || typeof result.error !== "string") {
        throw new Error("Invalid workspace command error");
      }
      throw new DomainError(result.status, result.error);
    }
    return result.data;
  }

  return {
    list: () => command<WorkspaceState>("list"),
    create: (input) => command<Workspace>("create", workspaceInputSchema.parse(input)),
    rename: (id, newName) => command<Workspace>("rename", { id, ...renameWorkspaceSchema.parse({ name: newName }) }),
    async delete(id, confirmationName) {
      await command<null>("delete", { id, ...deleteWorkspaceSchema.parse({ confirmationName }) });
    },
    async invite(id, email) {
      const input = invitationInputSchema.parse({ email });
      const token = randomBytes(32).toString("hex");
      const invitation = await command<WorkspaceInvitation>("invite", { id, ...input, tokenHash: tokenHash(token) });
      return { invitation, token };
    },
    previewInvite: (token) => command<InvitationPreview>("previewInvite", { tokenHash: tokenHash(token) }),
    acceptInvite: (token) => command<JoinedWorkspace>("acceptInvite", { tokenHash: tokenHash(token) }),
    acceptInviteById: (invitationId) => command<JoinedWorkspace>("acceptInviteById", { invitationId }),
  };
}

export async function getWorkspaceRepository(user: AppUser): Promise<WorkspaceRepository> {
  const { query } = await verifiedDatabaseQuery();
  return createWorkspaceRepository(query, user);
}

export async function getWorkspaceState(user: AppUser): Promise<WorkspaceState> {
  return (await getWorkspaceRepository(user)).list();
}

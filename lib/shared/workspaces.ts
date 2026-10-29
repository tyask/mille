export type WorkspaceType = "PERSONAL" | "SHARED";
export type WorkspaceRole = "OWNER" | "MEMBER";

export interface WorkspaceMember {
  userId: string;
  name: string;
  email: string;
  role: WorkspaceRole;
}

export interface WorkspaceInvitation {
  id: string;
  email: string;
  expiresAt: string;
}

export interface Workspace {
  id: string;
  name: string;
  type: WorkspaceType;
  role: WorkspaceRole;
  createdAt: string;
  updatedAt: string;
  members: WorkspaceMember[];
  pendingInvitations: WorkspaceInvitation[];
}

export interface IncomingInvitation extends WorkspaceInvitation {
  workspaceId: string;
  workspaceName: string;
  inviterName: string;
}

export interface InvitationPreview extends IncomingInvitation {
  status: "PENDING" | "ACCEPTED";
}

export interface WorkspaceState {
  workspaces: Workspace[];
  invitations: IncomingInvitation[];
}

export interface IssuedInvitation {
  invitation: WorkspaceInvitation;
  token: string;
}

export interface JoinedWorkspace {
  workspaceId: string;
}

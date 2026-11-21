export const milleRepositoryId = 1436928292;

export function isNativePreviewTaskBranch(branch: string): boolean {
  return /^codex\/[a-zA-Z0-9][a-zA-Z0-9/._-]*$/.test(branch) && !branch.includes("..") && !branch.endsWith(".")
    && branch.split("/").every(part => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"));
}

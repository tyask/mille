import { z } from "zod";

const name = z.string().trim().min(1, "名前を入力してください。").max(80, "名前は80文字以内で入力してください。");

export const workspaceInputSchema = z.strictObject({
  name,
  type: z.enum(["PERSONAL", "SHARED"], { error: "個人用または共有用を選択してください。" }),
});

export const renameWorkspaceSchema = z.strictObject({ name });

export const deleteWorkspaceSchema = z.strictObject({
  confirmationName: z.string().min(1, "確認のため現在の名前を入力してください。").max(80, "名前を確認してください。"),
});

export const invitationInputSchema = z.strictObject({
  email: z.string().trim().toLowerCase().max(254, "メールアドレスが長すぎます。").pipe(z.email("有効なメールアドレスを入力してください。")),
});

export const invitationTokenSchema = z.string().regex(/^[a-f0-9]{64}$/, "招待リンクが正しくありません。");

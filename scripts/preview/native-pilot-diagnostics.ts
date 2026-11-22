const stages = {
  configuration: "試験設定の検証",
  "github-target": "GitHub の試験 PR・HEAD 照合",
  "github-source": "GitHub の試験ソース照合",
  "github-deployment-policy": "GitHub の自動デプロイ設定の照合",
  "github-history": "GitHub の初回作成履歴の照合",
  "vercel-preflight": "Vercel のプロジェクト・環境変数照合",
  "vercel-inventory": "Vercel の既存デプロイ・エイリアス照合",
  "vercel-create-request": "Vercel のデプロイ作成要求",
  "vercel-create-response": "Vercel のデプロイ作成応答・所有照合",
  "vercel-static": "Vercel の静的デプロイ確認",
  "neon-preflight": "Neon の分岐元・常設接続先の照合",
  "neon-template-metadata": "Neon のテンプレート DB・ロールの照合",
  "neon-template-sql": "Neon のテンプレート空状態の読み取り",
  "neon-branch": "Neon の試験専用ブランチ・接続先の照合",
  "neon-isolation": "Neon の試験 DB 資格情報の分離照合",
  "neon-shared-credentials": "Neon の共有資格情報を検出し DB 初期化前に停止",
  "neon-initialize": "Neon の試験用 DB 初期化",
  ownership: "Vercel と Neon の所有・接続先の照合",
  cleanup: "所有を照合した試験用資源の削除",
} as const;

type Stage = keyof typeof stages;

export class NativePilotStageError extends Error {
  constructor(readonly stage: Stage, cause: unknown) {
    super(cause instanceof Error ? cause.message : "Native Preview の試験工程で停止しました。", { cause });
  }
}

export class NativePilotHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function nativePilotStage<T>(stage: Stage, run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof NativePilotStageError) throw error;
    throw new NativePilotStageError(stage, error);
  }
}

export function formatNativePilotFailure(error: NativePilotStageError, httpStatus?: number): string {
  const status = error.cause instanceof NativePilotHttpError ? error.cause.status : httpStatus;
  const http = status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599
    ? ` (HTTP ${status})` : "";
  return `Native Preview 診断 ${stages[error.stage]}${http}`;
}

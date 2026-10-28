import type { NextConfig } from "next";
import { execFileSync } from "node:child_process";

function sourceSha() {
  const provider = process.env.VERCEL_GIT_COMMIT_SHA;
  const declared = process.env.MILLE_SOURCE_SHA;
  if (declared && !/^[a-f0-9]{40}$/.test(declared)) throw new Error("MILLE_SOURCE_SHA must be a full commit SHA.");
  if (/^[a-f0-9]{40}$/.test(provider ?? "")) {
    if (declared && declared !== provider) throw new Error("Build source commit metadata does not match.");
    return provider!;
  }
  if (declared) return declared;
  try { return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); }
  catch { return "unknown"; }
}

const config: NextConfig = {
  env: { MILLE_SOURCE_SHA: sourceSha() },
  poweredByHeader: false,
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "X-Frame-Options", value: "DENY" },
      ],
    }];
  },
};
export default config;

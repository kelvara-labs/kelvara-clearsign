import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { heliusMainnetUrl } from "../src/chain.js";

const heliusKey = (root: string) => new URL(heliusMainnetUrl(root)).searchParams.get("api-key");

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("loads environment, common checkout, then local origin checkout without copying secrets", () => {
  vi.stubEnv("HELIUS_API_KEY", "");
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kelvara-key-"));
  dirs.push(tmp);
  const source = path.join(tmp, "source checkout");
  mkdirSync(source);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
  git(source, "init");
  git(source, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "test");
  writeFileSync(path.join(source, ".env"), "HELIUS_API_KEY=fake-source-key\n");
  const worktree = path.join(tmp, "worktree");
  git(source, "worktree", "add", "--detach", worktree);
  expect(heliusKey(worktree)).toBe("fake-source-key");

  const clone = path.join(tmp, "clone");
  git(tmp, "clone", source, clone);
  for (const origin of [source, pathToFileURL(source).href, worktree]) {
    git(clone, "remote", "set-url", "origin", origin);
    expect(heliusKey(clone)).toBe("fake-source-key");
  }
  writeFileSync(path.join(clone, ".env"), "HELIUS_API_KEY=fake-clone-key\n");
  expect(heliusKey(clone)).toBe("fake-clone-key");
  vi.stubEnv("HELIUS_API_KEY", "fake-env-key");
  expect(heliusKey(clone)).toBe("fake-env-key");
  vi.stubEnv("HELIUS_API_KEY", "");
  rmSync(path.join(clone, ".env"));
  for (const origin of ["https://example.invalid/repo.git", path.join(tmp, "missing")]) {
    git(clone, "remote", "set-url", "origin", origin);
    expect(() => heliusMainnetUrl(clone)).toThrow("HELIUS_API_KEY missing");
  }
});

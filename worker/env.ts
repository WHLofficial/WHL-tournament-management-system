import type { Role } from "../shared/types";

export type Bindings = {
  DB: D1Database;
  KV: KVNamespace;
  ASSETS: Fetcher;
};

export type SessionUser = { id: number; name: string; role: Role; locked: boolean; mustChangePassword: boolean };

export type AppEnv = {
  Bindings: Bindings;
  Variables: { user: SessionUser | null };
};
